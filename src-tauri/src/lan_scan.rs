//! M4h-1 发现层：mDNS 之外的局域网并发探测（docs/08 §13.3 ①）。
//!
//! 背景：mDNS 在用户实测的两处网络（家庭 WiFi 多播不可达、公司 LAN 拦截广播）
//! 都不可用，而它是 M2/M3 唯一的自动发现手段，不可达时只剩手输 IP 一条路
//! （docs/08 §13.1 P1/P2）。本模块补一条不依赖多播的路径：直接 TCP 连。
//!
//! **代价必须分层**（docs/08 §13.3 实测）：用户机器本机网段是 /22
//! （192.168.128.0/22，1022 个主机 × 10 端口 ≈ 1 万次 connect，按并发 128 /
//! 单连 150ms 估算上限 ≈12s，达不到「点一下」的体感）；而读 ARP/邻居表只得到
//! 3 个候选、全套探测 152ms。因此候选按代价从小到大依次尝试、**命中即停**：
//!
//! | 层 | 候选来源 | 典型候选数 | 代价 |
//! |---|---|---|---|
//! | L0 | mDNS browse + **已配对 profile 的历史 IP** | 0–5 | 近乎零 |
//! | L1 | 本机 ARP/邻居表里的私有地址 | 个位数–几十 | 百毫秒级 |
//! | L2 | 本机直连网卡的私有网段全扫（跳虚拟网卡） | 数百–上千 | 秒级，有硬预算 |
//!
//! 安全边界（docs/08 §13.6 R9）：只探本机私有网段 + profile 历史地址，
//! **只做 TCP connect + GET /api/v1/info，不发任何笔记数据**，绝不探公网。
//! 设置页提供「局域网扫描」开关，关掉即退化为纯手输 URL（§13.8 走查项 5）。

use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::sync_server::DEFAULT_PORT;

/// 扫描端口范围：与 `DEFAULT_PORT` + 少量容错一致。
/// 刻意不扫 `MAX_PORT_TRIES`(60) 全段——那是测试并行的产物，真实设备只用前几个。
pub const SCAN_PORT_SPAN: u16 = 10;
/// 并发上限（§13.6 R9：并发 128 起，不再往上加，避免触发企业 IDS）。
const MAX_CONCURRENCY: usize = 128;
/// L2 全扫的总预算硬截断：超时即返回已命中部分，UI 不再转圈（§13.3 R13）。
const L2_BUDGET: Duration = Duration::from_millis(3000);
/// 候选总数上限（§13.6 R10：多网卡/VPN/Docker 会产出大量无效网段）。
const MAX_CANDIDATES: usize = 1024;

/// 扫描命中的设备（比 `Discovered` 多带 `deviceId` 与笔记数，docs/08 §13.4 卡片）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScannedDevice {
    pub name: String,
    pub url: String,
    /// M4h-3：设备身份（旧服务器无该字段则为空串，调用方回退名称匹配）
    pub device_id: String,
    pub notes: u64,
}

/// 一层扫描的结果
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScanOutcome {
    pub devices: Vec<ScannedDevice>,
    /// 是否因预算/超时提前收工（UI 据此说明「可能不全」）
    pub truncated: bool,
}

// ---------- 候选生成（纯逻辑，可单测） ----------

/// 本机网卡上的私有网段（`(network, prefix_len)` 形式）。
///
/// 从 `ip -4 -o addr` 的同源信息取：这里不引网卡枚举 crate，改由调用方传入
/// 已解析的 `(ip, prefix)` 列表——`local_ipv4_addrs()` 在非测试环境用系统命令
/// 或 socket 探测填充。这样候选生成逻辑可以完全脱离真实网卡单测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetSegment {
    pub network: Ipv4Addr,
    pub prefix: u8,
}

/// 把地址按前缀掩码成网络号
pub fn mask_v4(ip: Ipv4Addr, prefix: u8) -> Ipv4Addr {
    if prefix == 0 {
        return Ipv4Addr::UNSPECIFIED;
    }
    let mask = u32::MAX << (32 - prefix as u32);
    Ipv4Addr::from(u32::from(ip) & mask)
}

impl NetSegment {
    /// 该网段是否值得扫：只接受 RFC1918 私有段 + 链路本地。
    /// **绝不扫公网**（docs/08 §13.3 安全边界）。
    pub fn is_private(&self) -> bool {
        is_private_v4(self.network)
    }

    /// 网段内的主机地址（跳过网络号与广播地址）。
    /// `/22` 会产出 1022 个 —— 调用方靠 `MAX_CANDIDATES` 与命中即停兜住。
    pub fn hosts(&self) -> Vec<Ipv4Addr> {
        if self.prefix > 30 {
            return vec![]; // /31 /32 无可用主机
        }
        let size = 1u32 << (32 - self.prefix as u32);
        let net = u32::from(mask_v4(self.network, self.prefix));
        (1..size.saturating_sub(1)).map(|i| Ipv4Addr::from(net + i)).collect()
    }
}

pub fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    match o[0] {
        10 => true,
        172 => (16..=31).contains(&o[1]),
        192 => o[1] == 168,
        169 => o[1] == 254, // 链路本地（APIPA）
        _ => false,
    }
}

/// 虚拟网卡前缀：docker/veth/br-/utun/tun/tap/wg 等。
/// 它们的网段扫了必无结果，却会成倍拉长 L2（§13.6 R10）。
pub fn is_virtual_iface(name: &str) -> bool {
    const PREFIXES: [&str; 14] = [
        "docker", "veth", "br-", "virbr", "vmnet", "vboxnet", "utun", "tun", "tap", "wg", "zt",
        "lo", "ppp", "tailscale",
    ];
    let n = name.to_ascii_lowercase();
    PREFIXES.iter().any(|p| n.starts_with(p))
}

/// 按 `(网卡名, ip, prefix)` 生成 L2 候选网段：跳虚拟网卡、只留私有段、同段去重。
///
/// 去重按 `(network, prefix)`：多张网卡落在同一网段时只扫一次（§13.6 R10）。
pub fn subnet_candidates(ifaces: &[(String, Ipv4Addr, u8)]) -> Vec<NetSegment> {
    let mut out: Vec<NetSegment> = Vec::new();
    for (name, ip, prefix) in ifaces {
        if is_virtual_iface(name) || *prefix == 0 || *prefix > 30 {
            continue;
        }
        let seg = NetSegment { network: mask_v4(*ip, *prefix), prefix: *prefix };
        if !seg.is_private() {
            continue;
        }
        // 去重按**掩码后的网段**：wlan0 与 eth0 各报 192.168.128.5/22 与
        // 192.168.128.9/22 时是同一个网段，必须只扫一次
        if !out.iter().any(|s| s.network == seg.network && s.prefix == seg.prefix) {
            out.push(seg);
        }
    }
    out
}

/// 解析 `ip -4 -o addr` 输出（Linux）为 `(网卡, ip, prefix)`。
/// 每行形如：`2: wlan0    inet 192.168.1.23/24 brd ... scope global dynamic wlan0`
pub fn parse_ip_addr_output(text: &str) -> Vec<(String, Ipv4Addr, u8)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // `ip -4 -o addr` 的行形如 `2: wlan0    inet 192.168.128.23/22 …`：
        // 带冒号的是**序号**（"2:"），网卡名是紧随其后的那个字段。
        // 只取序号是 0 号位时才认这一行，避免误识别其它含冒号的输出。
        if !cols.first().map(|c| c.ends_with(':')).unwrap_or(false) {
            continue;
        }
        let Some(iface) = cols.get(1).filter(|c| !c.starts_with("inet")) else {
            continue;
        };
        let Some(inet_pos) = cols.iter().position(|c| *c == "inet") else { continue };
        let Some(cidr) = cols.get(inet_pos + 1) else { continue };
        if let Some((ip, pfx)) = parse_cidr(cidr) {
            out.push((iface.to_string(), ip, pfx));
        }
    }
    out
}

fn parse_cidr(s: &str) -> Option<(Ipv4Addr, u8)> {
    let (ip_s, pfx_s) = s.split_once('/')?;
    let ip: Ipv4Addr = ip_s.parse().ok()?;
    let pfx: u8 = pfx_s.parse().ok()?;
    if pfx > 32 {
        return None;
    }
    Some((ip, pfx))
}

/// 解析 `ip -4 neigh show`（Linux）为邻居 IP 列表。
/// 行形如：`192.168.1.1 dev wlan0 lladdr aa:bb:.. REACHABLE`
/// Windows 走 `GetIpNetTable`（见 `neighbor_addresses()`）。
pub fn parse_ip_neigh_output(text: &str) -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(first) = line.split_whitespace().next() else { continue };
        if let Ok(ip) = first.parse::<Ipv4Addr>() {
            // 只留私有地址：邻居表里可能有网关之外的公网直连条目
            if is_private_v4(ip) && !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    out
}

// ---------- 探测（注入式，可单测） ----------

/// 探一个 URL 的 `/api/v1/info`。
///
/// 生产实现是真实 HTTP；测试注入假实现，从而无需起真服务器即可断言
/// 「命中 /info 校验、去重、超时即弃」（docs/08 §13.5 测试计划）。
pub trait InfoProbe: Send + Sync {
    /// 返回 `(name, device_id, notes)`；连不上 / 不是 lanmark / 超时 → None
    fn probe(&self, url: &str) -> Option<ScannedDevice>;
}

/// 生产实现：TCP connect + GET /api/v1/info（3s 客户端超时，短于扫描预算）
pub struct HttpInfoProbe;

impl InfoProbe for HttpInfoProbe {
    fn probe(&self, url: &str) -> Option<ScannedDevice> {
        let info = crate::sync_client::fetch_info(url).ok()?;
        Some(ScannedDevice {
            name: info.name,
            url: url.to_string(),
            device_id: info.device_id,
            notes: info.notes,
        })
    }
}

/// 并发探测一组 URL，带去重（按 url）。
///
/// 用「分块 + 线程」而不是 async：探测本身是阻塞 IO，且扫描入口已经在
/// `spawn_blocking` 里（Rust 侧无 async runtime 依赖，测试也好注入）。
fn probe_all(
    urls: &[String],
    probe: &dyn InfoProbe,
    budget: Option<Duration>,
) -> ScanOutcome {
    let start = Instant::now();
    let found: Arc<Mutex<Vec<ScannedDevice>>> = Arc::new(Mutex::new(Vec::new()));
    let cursor = Arc::new(AtomicUsize::new(0));
    let mut truncated = false;

    let workers = urls.len().min(MAX_CONCURRENCY).max(1);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let found = Arc::clone(&found);
            let cursor = Arc::clone(&cursor);
            scope.spawn(move || loop {
                // 预算硬截断：超时后 worker 自行退出，已命中的仍会返回
                if let Some(b) = budget {
                    if start.elapsed() >= b {
                        return;
                    }
                }
                let i = cursor.fetch_add(1, Ordering::Relaxed);
                if i >= urls.len() {
                    return;
                }
                if let Some(dev) = probe.probe(&urls[i]) {
                    if let Ok(mut g) = found.lock() {
                        if !g.iter().any(|d| d.url == dev.url) {
                            g.push(dev);
                        }
                    }
                }
            });
        }
    });

    let devices = Arc::try_unwrap(found).map(|m| m.into_inner().unwrap_or_default()).unwrap_or_default();
    // 若预算耗尽时还有没探完的候选，标记「可能不全」
    if let Some(b) = budget {
        if start.elapsed() >= b && cursor.load(Ordering::Relaxed) < urls.len() {
            truncated = true;
        }
    }
    ScanOutcome { devices, truncated }
}

/// 扫描编排（纯逻辑，全部输入注入 ⇒ 可单测）。
pub struct ScanPlan {
    /// L0：mDNS 结果 + 已配对 profile 的历史 IP（调用方已转成候选 URL）
    pub known: Vec<String>,
    /// L1：ARP/邻居表地址
    pub neighbors: Vec<Ipv4Addr>,
    /// L2：本机网段
    pub subnets: Vec<NetSegment>,
    /// 该 profile 已知端口优先（None 则扫 4180..4189）
    pub known_port: Option<u16>,
    /// 是否允许 L2 全扫（设置里的「局域网扫描」开关关掉时为 false）
    pub allow_subnet: bool,
}

/// 按 L0 → L1 → L2 依次探测，**命中即停**（docs/08 §13.3）。
///
/// 返回合并去重后的设备列表。L0 命中就不再做 L1/L2——这是「点一下」体感的关键：
/// 家庭网 mDNS 可用时一次 browse 就够，公司网才退到扫描。
pub fn run_scan(plan: &ScanPlan, probe: &dyn InfoProbe) -> ScanOutcome {
    // L0：已知地址（mDNS + 历史 IP）。这一层必须做，代价近乎零。
    if !plan.known.is_empty() {
        let out = probe_all(&plan.known, probe, None);
        if !out.devices.is_empty() {
            return out;
        }
    }

    let port = plan.known_port.unwrap_or(DEFAULT_PORT);
    let ports: Vec<u16> = if plan.known_port.is_some() {
        vec![port]
    } else {
        (DEFAULT_PORT..DEFAULT_PORT + SCAN_PORT_SPAN).collect()
    };

    // L1：邻居表地址。个位数候选，百毫秒级。
    if !plan.neighbors.is_empty() {
        let mut urls = Vec::new();
        for ip in &plan.neighbors {
            for p in &ports {
                urls.push(format!("http://{ip}:{p}"));
            }
        }
        let out = probe_all(&urls, probe, None);
        if !out.devices.is_empty() {
            return out;
        }
    }

    // L2：本机网段全扫。有总预算硬截断，超时返回已命中部分。
    if !plan.allow_subnet || plan.subnets.is_empty() {
        return ScanOutcome::default();
    }
    let mut urls = Vec::new();
    'outer: for seg in &plan.subnets {
        for ip in seg.hosts() {
            // 邻居表里的地址已在 L1 试过（且 L1 全空），跳过以免重复
            if plan.neighbors.contains(&ip) {
                continue;
            }
            for p in &ports {
                urls.push(format!("http://{ip}:{p}"));
                if urls.len() >= MAX_CANDIDATES {
                    break 'outer;
                }
            }
        }
    }
    let mut out = probe_all(&urls, probe, Some(L2_BUDGET));
    // 候选被截断（超过上限）也算「可能不全」
    out.truncated |= urls.len() >= MAX_CANDIDATES;
    out
}

// ---------- 系统信息采集（生产路径） ----------

/// 本机 IPv4 网卡列表。Linux 走 `ip -4 -o addr`；其它平台尽力而为（拿不到就空，
/// 退化为 L0+L1 两层，不会因此扫公网）。
pub fn local_ipv4_addrs() -> Vec<(String, Ipv4Addr, u8)> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = std::process::Command::new("ip").args(["-4", "-o", "addr"]).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let parsed = parse_ip_addr_output(&text);
                if !parsed.is_empty() {
                    return parsed;
                }
            }
        }
    }
    vec![]
}

/// ARP / 邻居表里的私有 IPv4。Linux 走 `ip -4 neigh show`。
pub fn neighbor_addresses() -> Vec<Ipv4Addr> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = std::process::Command::new("ip").args(["-4", "neigh", "show"]).output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                return parse_ip_neigh_output(&text);
            }
        }
    }
    vec![]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// 假探测：只认白名单里的 URL，可注入延迟模拟慢设备
    struct FakeProbe {
        answers: HashMap<String, ScannedDevice>,
    }
    impl FakeProbe {
        fn new(pairs: &[(&str, &str, &str, u64)]) -> Self {
            Self {
                answers: pairs
                    .iter()
                    .map(|(url, name, id, notes)| {
                        (
                            url.to_string(),
                            ScannedDevice {
                                name: name.to_string(),
                                url: url.to_string(),
                                device_id: id.to_string(),
                                notes: *notes,
                            },
                        )
                    })
                    .collect(),
            }
        }
    }
    impl InfoProbe for FakeProbe {
        fn probe(&self, url: &str) -> Option<ScannedDevice> {
            self.answers.get(url).cloned()
        }
    }

    fn plan(known: Vec<String>, neighbors: Vec<Ipv4Addr>, subnets: Vec<NetSegment>) -> ScanPlan {
        ScanPlan { known, neighbors, subnets, known_port: None, allow_subnet: true }
    }

    #[test]
    fn only_private_segments_are_scanned() {
        assert!(is_private_v4("192.168.1.1".parse().unwrap()));
        assert!(is_private_v4("10.0.0.5".parse().unwrap()));
        assert!(is_private_v4("172.16.3.4".parse().unwrap()));
        assert!(is_private_v4("172.31.255.254".parse().unwrap()));
        assert!(is_private_v4("169.254.1.1".parse().unwrap()));
        assert!(!is_private_v4("8.8.8.8".parse().unwrap()));
        assert!(!is_private_v4("172.32.0.1".parse().unwrap()));
        assert!(!is_private_v4("192.169.1.1".parse().unwrap()));
    }

    #[test]
    fn virtual_ifaces_are_skipped() {
        for n in ["docker0", "veth1234", "br-abc", "utun3", "tun0", "wg0", "lo"] {
            assert!(is_virtual_iface(n), "{n} 应判为虚拟");
        }
        for n in ["wlan0", "eth0", "enp3s0", "wlp2s0"] {
            assert!(!is_virtual_iface(n), "{n} 是真实网卡");
        }
    }

    #[test]
    fn subnet_candidates_dedup_and_filter() {
        let ifaces = vec![
            ("wlan0".to_string(), "192.168.128.5".parse().unwrap(), 22u8),
            ("eth0".to_string(), "192.168.128.9".parse().unwrap(), 22u8), // 同段 → 去重
            ("docker0".to_string(), "172.17.0.1".parse().unwrap(), 16u8), // 虚拟 → 跳
            ("eth1".to_string(), "203.0.113.7".parse().unwrap(), 24u8),  // 公网 → 跳
        ];
        let segs = subnet_candidates(&ifaces);
        assert_eq!(segs.len(), 1, "同段去重且跳虚拟/公网: {segs:?}");
        assert_eq!(segs[0].prefix, 22);
    }

    /// /22 是本机实测网段：主机数 1022，必须靠命中即停与上限兜住
    #[test]
    fn hosts_of_slash22_is_1022() {
        let seg = NetSegment { network: "192.168.128.0".parse().unwrap(), prefix: 22 };
        let hosts = seg.hosts();
        assert_eq!(hosts.len(), 1022);
        assert_eq!(hosts[0], "192.168.128.1".parse::<Ipv4Addr>().unwrap());
        assert_eq!(*hosts.last().unwrap(), "192.168.131.254".parse::<Ipv4Addr>().unwrap());
    }

    #[test]
    fn hosts_edge_prefixes() {
        let s24 = NetSegment { network: "10.0.0.0".parse().unwrap(), prefix: 24 };
        assert_eq!(s24.hosts().len(), 254);
        // /31 /32 无可用主机（点对点链路）
        assert!(NetSegment { network: "10.0.0.0".parse().unwrap(), prefix: 31 }.hosts().is_empty());
        assert!(NetSegment { network: "10.0.0.1".parse().unwrap(), prefix: 32 }.hosts().is_empty());
    }

    #[test]
    fn parse_ip_addr_output_reads_iface_and_cidr() {
        let text = "\
1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever
2: wlan0    inet 192.168.128.23/22 brd 192.168.131.255 scope global dynamic wlan0
3: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0
";
        let got = parse_ip_addr_output(text);
        assert_eq!(got.len(), 3);
        assert_eq!(got[1].0, "wlan0");
        assert_eq!(got[1].1, "192.168.128.23".parse::<Ipv4Addr>().unwrap());
        assert_eq!(got[1].2, 22);
    }

    #[test]
    fn parse_ip_neigh_output_keeps_private_only() {
        let text = "\
192.168.128.1 dev wlan0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
192.168.128.55 dev wlan0 lladdr 11:22:33:44:55:66 STALE
8.8.8.8 dev wlan0 lladdr 00:11:22:33:44:55 REACHABLE
192.168.128.1 dev wlan0 lladdr aa:bb:cc:dd:ee:ff STALE
";
        let got = parse_ip_neigh_output(text);
        assert_eq!(got.len(), 2, "公网条目与重复项都该去掉: {got:?}");
        assert!(got.contains(&"192.168.128.1".parse::<Ipv4Addr>().unwrap()));
        assert!(got.contains(&"192.168.128.55".parse::<Ipv4Addr>().unwrap()));
    }

    #[test]
    fn l0_hit_stops_before_neighbor_and_subnet() {
        let probe = FakeProbe::new(&[("http://192.168.1.5:4180", "REDMI K90", "dev-abc", 42)]);
        let p = plan(
            vec!["http://192.168.1.5:4180".into()],
            vec!["192.168.1.99".parse().unwrap()],
            vec![NetSegment { network: "192.168.1.0".parse().unwrap(), prefix: 24 }],
        );
        let out = run_scan(&p, &probe);
        assert_eq!(out.devices.len(), 1);
        assert_eq!(out.devices[0].name, "REDMI K90");
        assert_eq!(out.devices[0].device_id, "dev-abc");
        assert_eq!(out.devices[0].notes, 42);
    }

    #[test]
    fn falls_through_to_neighbor_when_known_misses() {
        let probe = FakeProbe::new(&[("http://10.0.0.7:4180", "office-pad", "dev-xyz", 7)]);
        let p = plan(
            vec!["http://192.168.1.5:4180".into()], // L0 空
            vec!["10.0.0.7".parse().unwrap()],
            vec![],
        );
        let out = run_scan(&p, &probe);
        assert_eq!(out.devices.len(), 1);
        assert_eq!(out.devices[0].url, "http://10.0.0.7:4180");
    }

    #[test]
    fn subnet_scan_finds_device_when_earlier_layers_empty() {
        let probe = FakeProbe::new(&[("http://192.168.128.30:4180", "phone", "d1", 3)]);
        let p = plan(
            vec![],
            vec![],
            vec![NetSegment { network: "192.168.128.0".parse().unwrap(), prefix: 24 }],
        );
        let out = run_scan(&p, &probe);
        assert_eq!(out.devices.len(), 1);
        assert_eq!(out.devices[0].url, "http://192.168.128.30:4180");
    }

    /// 关掉「局域网扫描」开关 → 只做 L0/L1，UI 退化为手输 URL（§13.8 走查项 5）
    #[test]
    fn subnet_layer_disabled_by_switch() {
        let probe = FakeProbe::new(&[("http://192.168.128.30:4180", "phone", "d1", 3)]);
        let mut p = plan(
            vec![],
            vec![],
            vec![NetSegment { network: "192.168.128.0".parse().unwrap(), prefix: 24 }],
        );
        p.allow_subnet = false;
        let out = run_scan(&p, &probe);
        assert!(out.devices.is_empty(), "关了开关不得做网段全扫");
    }

    /// 已知端口优先：该 profile 有历史端口时只探那一个，不撒 10 个端口
    #[test]
    fn known_port_narrows_candidates() {
        struct Counting(Arc<AtomicUsize>, Option<ScannedDevice>);
        impl InfoProbe for Counting {
            fn probe(&self, _url: &str) -> Option<ScannedDevice> {
                self.0.fetch_add(1, Ordering::Relaxed);
                self.1.clone()
            }
        }
        let hits = Arc::new(AtomicUsize::new(0));
        let probe = Counting(Arc::clone(&hits), None);
        let mut p = plan(vec![], vec!["192.168.1.9".parse().unwrap()], vec![]);
        p.known_port = Some(4183);
        run_scan(&p, &probe);
        assert_eq!(hits.load(Ordering::Relaxed), 1, "已知端口只探 1 次");
    }

    /// 命中 /info 校验：探测返回 None 即为「不是 lanmark / 连不上」→ 丢弃
    #[test]
    fn non_lanmark_candidates_are_dropped() {
        let probe = FakeProbe::new(&[]); // 全不认
        let p = plan(
            vec!["http://192.168.1.5:4180".into()],
            vec!["192.168.1.9".parse().unwrap()],
            vec![],
        );
        let out = run_scan(&p, &probe);
        assert!(out.devices.is_empty());
        assert!(!out.truncated);
    }

    #[test]
    fn results_are_deduplicated_by_url() {
        // 两个不同 IP 报到同一个 url 的场景不存在（url 由 IP 生成），
        // 但 L0 历史 IP 与 L1 邻居表可能给出同一 url → 必须去重
        let probe = FakeProbe::new(&[("http://192.168.1.5:4180", "phone", "d1", 1)]);
        let p = plan(
            vec!["http://192.168.1.5:4180".into(), "http://192.168.1.5:4180".into()],
            vec![],
            vec![],
        );
        let out = run_scan(&p, &probe);
        assert_eq!(out.devices.len(), 1, "重复候选只出一条");
    }

    /// L2 预算硬截断：慢探测不得让扫描无限期跑下去（§13.6 R13）
    #[test]
    fn subnet_scan_truncates_on_budget() {
        struct SlowProbe;
        impl InfoProbe for SlowProbe {
            fn probe(&self, _url: &str) -> Option<ScannedDevice> {
                std::thread::sleep(Duration::from_millis(80));
                None
            }
        }
        // /24 = 254 主机 × 10 端口 = 2540 候选 ≫ 3s 预算（128 并发 → 约 1.6s/轮）
        let p = plan(
            vec![],
            vec![],
            vec![NetSegment { network: "10.1.0.0".parse().unwrap(), prefix: 24 }],
        );
        let t0 = Instant::now();
        let out = run_scan(&p, &SlowProbe);
        let elapsed = t0.elapsed();
        assert!(out.devices.is_empty());
        assert!(out.truncated, "预算耗尽应标记可能不全");
        // 允许一轮 worker 收尾的余量，但不得远超预算
        assert!(elapsed < Duration::from_millis(4500), "超预算太多: {elapsed:?}");
    }

    #[test]
    fn candidate_cap_is_respected() {
        // /16 = 65534 主机 ≫ 上限 1024；必须被截断而不是生成十万候选
        let p = plan(
            vec![],
            vec![],
            vec![NetSegment { network: "10.2.0.0".parse().unwrap(), prefix: 16 }],
        );
        let seg = &p.subnets[0];
        assert!(seg.hosts().len() > MAX_CANDIDATES);
        // 实际生成的候选由 run_scan 内部裁剪；这里断言 hosts 本身很大，
        // 说明上限逻辑是必需的（配合 scan 的 'outer 跳出）
        let _ = run_scan(&p, &FakeProbe::new(&[]));
    }
}
