//! M2 桌面端同步客户端：mDNS 发现、配对、同步回合驱动。
//! 手机是服务器（App 内嵌 axum），桌面是客户端；回合幂等可重放：
//! manifest 四分类（仅服务器→拉 / 仅本地→推 / hash 同→跳 / hash 异→冲突双份）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fs_ops;
use crate::sync::{
    b64_decode, local_manifest, write_conflict_copy, FileMeta, PushFile, SyncReport,
};
use crate::vault::AppState;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const PULL_BATCH: usize = 32;
const PUSH_BATCH: usize = 8;

/// pull 一批的返回：文件内容 + 缺失/拒绝清单
type PullBatch = (Vec<crate::sync::PullFile>, Vec<(String, String)>);

/// 已配对服务器（桌面侧 app_config_dir/sync-servers.json）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfile {
    /// M4h-3：**必须等于 `device_id`**（服务器 `/info` 返回的身份）。
    /// M2/M3 时期是 `hash(url+token)[..8]` —— 那样 IP 一变就得重配对，token 变新
    /// → id 变新 → 基线文件 `sync-<id>.json` 换名 → 下回合全库无基线 →
    /// 大量「双方都改」→ 冲突副本激增（docs/08 §13.1 P4）。
    /// 改绑设备身份后 IP 变化只需改 `url`，基线不丢。
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub token: String,
    /// 最近一次回合成功时间（unix ms；M3e 状态 UI 展示，重启不丢）
    #[serde(default)]
    pub last_success_at: Option<i64>,
    /// M4h-3：设备身份（来自 `/info` 的 `deviceId`）。
    /// 旧服务器无该字段 → 空串，回退按名称匹配（`match_by_identity`）。
    #[serde(default)]
    pub device_id: String,
    /// M4h-3：上次已知端口（IP 变了按 device_id 找回时优先试它，少扫 10 个端口）
    #[serde(default)]
    pub port: Option<u16>,
}

/// mDNS 发现结果
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub name: String,
    pub url: String,
}

/// 轻量探测结果（docs/07 §7：自动同步循环的眼睛；GET /info 无鉴权，3s 超时）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub online: bool,
    pub name: String,
    pub notes: u64,
    pub assets: u64,
}

// ---------- 服务器配置持久化 ----------

fn servers_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    tauri::Manager::path(app)
        .app_config_dir()
        .map(|d| d.join("sync-servers.json"))
        .map_err(|_| "无法定位配置目录".into())
}

pub fn load_servers(app: &tauri::AppHandle) -> Vec<ServerProfile> {
    std::fs::read_to_string(servers_path(app).unwrap_or_default())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// M4h-3 一次性迁移：把 M2/M3 的旧 profile 换绑到设备身份。
///
/// 旧 profile 的 `id = hash(url+token)[..8]`，基线文件叫 `sync-<旧id>.json`。
/// 迁移步骤：
///   1. 探测每个旧 profile 的 `/info` 拿 `deviceId`
///   2. 新 id = `d<deviceId>`；**把基线文件改名**（`sync-<旧id>.json` →
///      `sync-<新id>.json`）而不是重建——重建等于丢掉「上轮已知状态」，
///      下个回合会把全部差异判成「双方都改」，正是 P4 要修的现象
///      （docs/08 §13.6 R12：测试钉住「迁移前后 skipped 计数一致」）
///   3. 探测不到的（离线）保持原样，下次同步时再迁
///
/// 幂等：已有 `device_id` 的 profile 直接跳过。
/// 返回迁移成功的数量。
pub fn migrate_profiles_to_device_id(vault: &Path, servers: &mut [ServerProfile]) -> usize {
    let mut migrated = 0;
    for p in servers.iter_mut() {
        if !p.device_id.is_empty() {
            continue;
        }
        let Ok(info) = fetch_info(&p.url) else { continue };
        if info.device_id.is_empty() {
            continue; // 旧服务器：没有身份可用，保持按 url/token 的 id
        }
        let old_id = p.id.clone();
        let new_id = profile_id(&info.device_id, &p.url, &p.token);
        if new_id != old_id {
            // 基线文件改名（不是重建）：改名保状态，重建丢状态
            let from = sync_state_path(vault, &old_id);
            let to = sync_state_path(vault, &new_id);
            if from.exists() && !to.exists() {
                if let Err(e) = std::fs::rename(&from, &to) {
                    log::warn!("基线文件改名失败 {old_id} → {new_id}: {e}（保持旧 id）");
                    continue; // 改名失败就不换 id，否则会丢基线
                }
            }
            p.id = new_id;
        }
        p.device_id = info.device_id;
        p.name = info.name;
        p.port = port_of_url(&p.url);
        migrated += 1;
    }
    migrated
}

pub fn save_servers(app: &tauri::AppHandle, servers: &[ServerProfile]) -> Result<(), String> {
    let path = servers_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // tmp+rename 原子写：写一半断电损坏 JSON → load 静默回退 → 全部已配 token 丢失
    crate::fs_ops::atomic_write(
        &path,
        serde_json::to_string_pretty(servers).map_err(|e| e.to_string())?.as_bytes(),
    )
    .map_err(|e| e.to_string())
}

/// 从 `http://host:port` 取端口（不引 url crate：格式由 `normalize_url` 保证）
fn port_of_url(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://")?;
    let (_, port) = rest.rsplit_once(':')?;
    port.split('/').next()?.parse().ok()
}

/// M4h-3：按设备身份匹配 profile。
///
/// 优先 `device_id`（稳定身份，IP/端口变了也算同一台）；对方是旧版本服务器
/// （`/info` 无 `deviceId`）时回退按**名称**匹配——名称匹配可能误配，
/// 所以只在 deviceId 缺失时用（docs/08 §13.3 ③、§13.5 测试项）。
pub fn match_by_identity<'a>(
    servers: &'a [ServerProfile],
    device_id: &str,
    name: &str,
) -> Option<&'a ServerProfile> {
    if !device_id.is_empty() {
        if let Some(p) = servers.iter().find(|s| s.device_id == device_id) {
            return Some(p);
        }
    }
    if name.is_empty() {
        return None;
    }
    servers
        .iter()
        .find(|s| s.device_id.is_empty() && s.name == name)
}

/// M4h-3：profile 的稳定 id。有 deviceId 就用它（`d<id>` 前缀便于人眼区分），
/// 否则（旧服务器）沿用老的 `hash(url+token)` 方案。
pub fn profile_id(device_id: &str, url: &str, token: &str) -> String {
    if !device_id.is_empty() {
        return format!("d{device_id}");
    }
    let hash = fs_ops::content_hash(format!("{url}{token}").as_bytes());
    format!("s{}", &hash[..8])
}

pub fn normalize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("地址不能为空".into());
    }
    if !url.starts_with("http://") {
        return Err("地址需以 http:// 开头（如 http://192.168.1.20:4180）".into());
    }
    Ok(url.to_string())
}

// ---------- HTTP 封装 ----------

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(CLIENT_TIMEOUT)
        .build()
        .expect("构建 HTTP 客户端失败")
}

fn auth_bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// POST /api/v1/pair：配对码换 token
pub fn pair(base_url: &str, code: &str) -> Result<(String, String), String> {
    let url = normalize_url(base_url)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Paired {
        token: String,
        name: String,
    }
    let resp = client()
        .post(format!("{url}/api/v1/pair"))
        .json(&serde_json::json!({ "code": code.trim() }))
        .send()
        .map_err(|e| format!("连接失败: {e}"))?;
    match resp.status() {
        reqwest::StatusCode::OK => {
            let p: Paired = resp.json().map_err(|e| e.to_string())?;
            Ok((p.token, p.name))
        }
        s if s == reqwest::StatusCode::FORBIDDEN => Err("配对码错误".into()),
        s => Err(format!("配对失败（HTTP {s}）")),
    }
}

fn fetch_manifest(c: &reqwest::blocking::Client, url: &str, token: &str) -> Result<Vec<FileMeta>, String> {
    let resp = c
        .get(format!("{url}/api/v1/manifest"))
        .header("authorization", auth_bearer(token))
        .send()
        .map_err(|e| format!("拉取清单失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取清单失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("清单解析失败: {e}"))
}

fn pull_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    paths: &[String],
) -> Result<PullBatch, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resp {
        files: Vec<crate::sync::PullFile>,
        missing: Vec<(String, String)>,
    }
    let resp = c
        .post(format!("{url}/api/v1/pull"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "paths": paths }))
        .send()
        .map_err(|e| format!("拉取失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取失败（HTTP {}）", resp.status()));
    }
    let r: Resp = resp.json().map_err(|e| e.to_string())?;
    Ok((r.files, r.missing))
}

fn push_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    files: &[PushFile],
) -> Result<Vec<crate::sync::PushResult>, String> {
    let resp = c
        .post(format!("{url}/api/v1/push"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "files": files }))
        .send()
        .map_err(|e| format!("推送失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("推送失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("推送响应解析失败: {e}"))
}

/// GET /api/v1/tombstones（docs/07 §3）：旧服务器 404 → 空列表（删除传播静默关闭，退化 M2 行为，不报错）
fn fetch_tombstones(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
) -> Result<Vec<crate::sync::Tombstone>, String> {
    let resp = c
        .get(format!("{url}/api/v1/tombstones"))
        .header("authorization", auth_bearer(token))
        .send()
        .map_err(|e| format!("拉取 tombstone 失败: {e}"))?;
    match resp.status() {
        s if s.is_success() => resp.json().map_err(|e| format!("tombstone 解析失败: {e}")),
        reqwest::StatusCode::NOT_FOUND => {
            log::debug!("服务器无 /tombstones（旧版本），按空列表处理");
            Ok(Vec::new())
        }
        s => Err(format!("拉取 tombstone 失败（HTTP {s}）")),
    }
}

/// POST /api/v1/delete（批量；服务器软删入回收站 + 记 tombstone）
fn delete_batch(
    c: &reqwest::blocking::Client,
    url: &str,
    token: &str,
    paths: &[String],
) -> Result<Vec<crate::sync::PushResult>, String> {
    let resp = c
        .post(format!("{url}/api/v1/delete"))
        .header("authorization", auth_bearer(token))
        .json(&serde_json::json!({ "paths": paths }))
        .send()
        .map_err(|e| format!("删除传播失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("删除传播失败（HTTP {}）", resp.status()));
    }
    resp.json().map_err(|e| format!("删除传播响应解析失败: {e}"))
}

// ---------- 落盘辅助 ----------

/// 把拉取内容落到本地（笔记走 write_note 进索引；附件校验内容寻址）。
/// 返回错误信息（None = 成功）。
fn store_pulled(vault: &Path, conn: &rusqlite::Connection, f: &crate::sync::PullFile) -> Option<String> {
    let bytes = match b64_decode(&f.content_base64) {
        Ok(b) => b,
        Err(e) => return Some(format!("{}: {e}", f.path)),
    };
    let actual = fs_ops::content_hash(&bytes);
    if actual != f.hash {
        return Some(format!("{}: 内容 hash 不符", f.path));
    }
    match f.kind.as_str() {
        "note" => {
            // 同步场景父目录可能尚不存在（对端先建的笔记在其目录里）
            if let Some(parent) = fs_ops::safe_join(vault, &f.path)
                .map_err(|e| e.to_string())
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            {
                if let Err(e) = std::fs::create_dir_all(&parent) {
                    return Some(format!("{}: 创建目录失败: {e}", f.path));
                }
            }
            // 非 UTF-8 的 .md（GBK 等外来文件）字节级原样落盘；索引 body 用 lossy 文本
            let ok = match std::str::from_utf8(&bytes) {
                Ok(content) => fs_ops::write_note(vault, &f.path, content, conn).is_ok(),
                Err(_) => fs_ops::write_note_bytes(vault, &f.path, &bytes, conn).is_ok(),
            };
            if ok {
                // LWW 时间源保真（docs/07 §2）：本地 mtime = 服务器版本保存时间
                if let Ok(abs) = fs_ops::safe_join(vault, &f.path) {
                    fs_ops::set_file_mtime(&abs, f.mtime_ms);
                }
            }
            if ok {
                None
            } else {
                Some(format!("{}: 写入失败", f.path))
            }
        }
        "asset" => {
            // 附件按原路径落盘（内容 hash 已验证），与服务器 push 同语义
            if !f.path.starts_with("assets/") || f.path.contains("..") {
                return Some(format!("{}: 附件路径非法", f.path));
            }
            let abs = match fs_ops::safe_join(vault, &f.path) {
                Ok(a) => a,
                Err(e) => return Some(format!("{}: 路径非法: {e}", f.path)),
            };
            if let Err(e) = std::fs::write(&abs, &bytes) {
                return Some(format!("{}: 附件写入失败: {e}", f.path));
            }
            // LWW 时间源保真（docs/07 §2）：同笔记分支
            fs_ops::set_file_mtime(&abs, f.mtime_ms);
            None
        }
        other => Some(format!("{}: 未知类型 {other}", f.path)),
    }
}

/// 本地文件读为 PushFile（含 base_hash）
fn read_push_file(vault: &Path, path: &str, kind: &str, base_hash: &str) -> Option<PushFile> {
    let abs = vault.join(path);
    let bytes = std::fs::read(&abs).ok()?;
    let hash = fs_ops::content_hash(&bytes);
    let mtime_ms = std::fs::metadata(&abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(PushFile {
        path: path.to_string(),
        kind: kind.to_string(),
        content_base64: crate::sync::b64_encode(&bytes),
        hash,
        mtime_ms,
        base_hash: base_hash.to_string(),
    })
}

// ---------- 客户端基线（避免假冲突） ----------

/// 客户端基线：上次回合结束时服务器各文件的 hash（.lanmark/sync-<id>.json）。
/// 纯 hash 对比无法区分「只有一方改过」与「双方都改」：有了基线即可——
/// 本地 hash == 基线 → 只有服务器改 → 快进拉取；服务器 hash == 基线 → 只有本地改 → 推送；
/// 两者都不是 → 双方都改 → 真冲突保留双份。
fn sync_state_path(vault: &Path, id: &str) -> PathBuf {
    // .lanmark/ 不参与同步（walk 跳过 dot 目录）
    vault.join(fs_ops::META_DIR).join(format!("sync-{id}.json"))
}

fn load_sync_state(vault: &Path, id: &str) -> HashMap<String, String> {
    std::fs::read_to_string(sync_state_path(vault, id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_sync_state(vault: &Path, id: &str, state: &HashMap<String, String>) -> Result<(), String> {
    let path = sync_state_path(vault, id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- 同步回合（docs/07 §5 回合语义 v2） ----------

/// 同步回合核心（分阶段；`sync_round` = 各阶段的默认编排）。
/// 分阶段两个目的：1) 测试可在阶段之间注入服务器侧改动，确定性构造
/// 「manifest 已过期」的竞态（M2 单体回合只能在 HTTP 层测竞态）；
/// 2) M3b/M3c 的新阶段（tombstone 处理、LWW 裁决）挂在这里，不堆进单一函数。
pub(crate) struct RoundCore {
    state: Arc<AppState>,
    profile: ServerProfile,
    vault: PathBuf,
    url: String,
    c: reqwest::blocking::Client,
    server_map: HashMap<String, FileMeta>,
    local_map: HashMap<String, FileMeta>,
    /// 服务器 tombstone（旧服务器 404 → 空列表，docs/07 §3）
    server_tombstones: Vec<crate::sync::Tombstone>,
    /// 本地 tombstone（回合开头 D4 判定后；步骤 3/4 消费与更新）
    local_tombstones: Vec<crate::sync::Tombstone>,
    /// 上轮基线（上次回合结束时服务器的 hash 快照）
    #[allow(dead_code)] // 分类在 new() 内消费；M3c 起阶段间需要时再放开
    base_prev: HashMap<String, String>,
    /// 仅服务器有 → 拉
    to_pull: Vec<String>,
    /// 仅本地有 / 冲突要推 → (path, base_hash)
    to_push: Vec<(String, String)>,
    /// 双方都改（两端 hash 均 ≠ 基线）→ (path, 服务器 hash)
    conflicts: Vec<(String, String)>,
    /// 本回合基线（步骤 8）：起点 = 回合开始时的服务器清单，
    /// 拉取/推送结果按「操作后最终 hash」更新（M3a G3 修复）
    baseline: HashMap<String, String>,
    report: SyncReport,
}

impl RoundCore {
    /// 步骤 0–2：本地 reindex → 双侧清单 + 基线 → 四分类
    fn new(state: &Arc<AppState>, profile: &ServerProfile) -> Result<Self, String> {
        let url = normalize_url(&profile.url)?;
        let vault = state
            .vault
            .lock()
            .map_err(|_| "vault 锁中毒".to_string())?
            .clone()
            .ok_or("尚未打开 vault")?;

        // 0. 本地重索引：外部改动（其他编辑器/App 直接改 vault 文件）后 DB 缓存
        //    可能缺文件或 hash 过时——同步回合必须以磁盘为准（M1 契约：磁盘是事实源）
        {
            let conn_guard = state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            fs_ops::reindex(&vault, conn).map_err(|e| format!("重索引失败: {e}"))?;
        }

        // 1. 双侧清单 + 客户端基线 + 服务器 tombstones（docs/07 §5 步骤 1）
        let c = client();
        let server_manifest = fetch_manifest(&c, &url, &profile.token)?;
        let server_tombstones = fetch_tombstones(&c, &url, &profile.token)?;

        // M3b：本地 tombstone TTL 清理（30 天）
        if let Err(e) = crate::sync::purge_expired_tombstones(&vault, fs_ops::now_ms()) {
            log::warn!("tombstone TTL 清理失败: {e}");
        }
        // 回合开头 D4 判定：本地 tombstone 的路径重新出现在磁盘上（回收站恢复/重建）
        let local_tombstones = {
            let mut keep: Vec<crate::sync::Tombstone> = Vec::new();
            for t in crate::sync::load_tombstones(&vault) {
                let abs = vault.join(&t.path);
                if abs.is_file() {
                    if crate::sync::meta_mtime_ms(&abs) > t.mtime_ms {
                        // 重建比删除新 → 路径复活（D4）：清 tombstone，正常同步流程推送
                        if let Err(e) = crate::sync::clear_tombstone_if_present(&vault, &t.path) {
                            log::warn!("回合开头清 tombstone 失败 {}: {e}", t.path);
                        }
                    } else {
                        // 陈旧恢复（mtime ≤ 删除时刻）：删除仍然有效 → 再软删（内容进回收站，铁律）
                        let res = {
                            let conn_guard = state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
                            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
                            fs_ops::delete_entry(&vault, &t.path, conn).map_err(|e| e.to_string())
                        };
                        if let Err(e) = res {
                            log::warn!("陈旧恢复文件再软删失败 {}: {e}", t.path);
                        }
                        keep.push(t);
                    }
                } else {
                    keep.push(t);
                }
            }
            keep
        };

        let local = local_manifest(state)?;
        let server_map: HashMap<String, FileMeta> =
            server_manifest.iter().cloned().map(|m| (m.path.clone(), m)).collect();
        let local_map: HashMap<String, FileMeta> =
            local.iter().cloned().map(|m| (m.path.clone(), m)).collect();
        let base_prev = load_sync_state(&vault, &profile.id);

        let mut report = SyncReport::default();
        let mut to_pull: Vec<String> = Vec::new();
        let mut to_push: Vec<(String, String)> = Vec::new(); // (path, base_hash)
        let mut conflicts: Vec<(String, String)> = Vec::new(); // (path, server hash)

        // 2. 四分类（仅服务器有→拉 / 仅本地有→推 / hash 同→跳 / hash 异→三方对比）
        for (path, sm) in &server_map {
            match local_map.get(path) {
                None => to_pull.push(path.clone()),
                Some(lm) => {
                    if lm.hash == sm.hash {
                        report.skipped += 1;
                    } else {
                        let base = base_prev.get(path);
                        if base == Some(&lm.hash) {
                            // 只有服务器改了 → 快进拉取（覆盖本地）
                            to_pull.push(path.clone());
                        } else if base == Some(&sm.hash) {
                            // 只有本地改了 → 推送
                            to_push.push((path.clone(), sm.hash.clone()));
                        } else {
                            // 双方都改（或无基线，如首次同步/重新配对）→ 双份（M3c：LWW 裁决）
                            conflicts.push((path.clone(), sm.hash.clone()));
                        }
                    }
                }
            }
        }
        for path in local_map.keys() {
            if !server_map.contains_key(path) {
                to_push.push((path.clone(), String::new()));
            }
        }

        // 8（基线起点）：= 回合开始时的服务器清单（步骤 8 按本回合结果更新）
        let baseline = server_map
            .iter()
            .map(|(k, v)| (k.clone(), v.hash.clone()))
            .collect();

        Ok(RoundCore {
            state: state.clone(),
            profile: profile.clone(),
            vault,
            url,
            c,
            server_map,
            local_map,
            server_tombstones,
            local_tombstones,
            base_prev,
            to_pull,
            to_push,
            conflicts,
            baseline,
            report,
        })
    }

    /// 步骤 3：服务器 tombstone 处理（docs/07 §5 步骤 3）
    /// hash 同 → 本地软删 + 记本地 tombstone；hash 异 → edit/delete LWW（删除元组 size=0，
    /// mtime 平手时编辑恒赢）；本地无 → 补记本地 tombstone 跳过
    fn server_tombstones_phase(&mut self) -> Result<(), String> {
        // take 出来再遍历：块内要 &mut self（upsert/软删/清 tombstone）
        let server_tombstones = std::mem::take(&mut self.server_tombstones);
        for t in server_tombstones {
            // 防御：服务器 manifest 仍有该路径（tombstone 未清的不一致态）→ 跳过，正常流程优先
            if self.server_map.contains_key(&t.path) {
                continue;
            }
            match self.local_map.get(&t.path) {
                None => {
                    // 双方已删 → 补记本地 tombstone（供传播到其他服务器），跳过
                    self.upsert_local_tombstone(&t);
                }
                Some(lm) => {
                    let edit = (lm.mtime_ms, lm.size, lm.hash.as_str());
                    let del = (t.mtime_ms, 0, t.hash.as_str());
                    if crate::sync::version_gt(edit, del) {
                        // 编辑赢 → 推送复活（服务器落盘时 D4 清 tombstone）；清陈旧本地 tombstone
                        if let Err(e) = crate::sync::clear_tombstone_if_present(&self.vault, &t.path) {
                            log::warn!("清 tombstone 失败 {}: {e}", t.path);
                        }
                        self.local_tombstones.retain(|x| x.path != t.path);
                        // 分类里「仅本地」应已在 to_push；不在则补（base 空 = 服务器无此文件）
                        if !self.to_push.iter().any(|(p, _)| p == &t.path) {
                            self.to_push.push((t.path.clone(), String::new()));
                        }
                    } else {
                        // 删除赢 → 本地软删 + 继承服务器的删除事件
                        self.soft_delete_local(&t.path)?;
                        self.upsert_local_tombstone(&t);
                        // 分类可能已把该路径放进 to_push/to_pull（不一致态）→ 撤掉
                        self.to_push.retain(|(p, _)| p != &t.path);
                        self.to_pull.retain(|p| p != &t.path);
                    }
                }
            }
        }
        Ok(())
    }

    /// 步骤 4：本地 tombstone vs 服务器 manifest（docs/07 §5 步骤 4，方向对调）
    /// hash 同 → 调 /delete 静默传播；hash 异 → edit/delete LWW（服务器编辑新 → 拉取复活 + 清
    /// 本地 tombstone；删除新 → /delete）；服务器无此文件 → 无操作
    fn local_tombstones_phase(&mut self) -> Result<(), String> {
        let mut to_delete: Vec<String> = Vec::new();
        // take 出来再遍历：块内要 &mut self（清 tombstone/撤 to_pull）
        let local_tombstones = std::mem::take(&mut self.local_tombstones);
        for t in local_tombstones {
            let Some(sm) = self.server_map.get(&t.path) else {
                continue;
            };
            let edit_wins =
                crate::sync::version_gt((sm.mtime_ms, sm.size, sm.hash.as_str()), (t.mtime_ms, 0, t.hash.as_str()));
            if sm.hash == t.hash || !edit_wins {
                // 删后没再改（静默传播）/ 删除比服务器编辑新 → 服务器也软删
                to_delete.push(t.path.clone());
                // 分类已把它放进 to_pull（仅服务器有）→ 撤掉，否则快进拉取会把已删文件拉回来
                self.to_pull.retain(|p| p != &t.path);
            } else {
                // 服务器编辑更新 → 复活：保留 to_pull（分类已放，正常拉取），清本地 tombstone（D4）
                if let Err(e) = crate::sync::clear_tombstone_if_present(&self.vault, &t.path) {
                    log::warn!("清 tombstone 失败 {}: {e}", t.path);
                }
                self.local_tombstones.retain(|x| x.path != t.path);
            }
        }
        if !to_delete.is_empty() {
            let results = delete_batch(&self.c, &self.url, &self.profile.token, &to_delete)?;
            for r in results {
                if r.ok {
                    self.report.deleted.push(r.path.clone());
                } else {
                    self.report
                        .errors
                        .push(format!("删除传播失败 {}: {}", r.path, r.error.unwrap_or_default()));
                }
            }
        }
        Ok(())
    }

    /// 本地软删（进回收站，铁律）+ 报告计数
    fn soft_delete_local(&mut self, path: &str) -> Result<(), String> {
        let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        fs_ops::delete_entry(&self.vault, path, conn)
            .map_err(|e| format!("{path}: 本地软删失败: {e}"))?;
        self.report.deleted.push(path.to_string());
        Ok(())
    }

    /// 本地 tombstone upsert（内存 + 磁盘）
    fn upsert_local_tombstone(&mut self, t: &crate::sync::Tombstone) {
        self.local_tombstones.retain(|x| x.path != t.path);
        self.local_tombstones.push(t.clone());
        if let Err(e) = crate::sync::record_tombstone(&self.vault, &t.path, &t.hash, t.deleted_at) {
            log::warn!("记 tombstone 失败 {}: {e}", t.path);
        }
    }

    /// 拉单个文件内容（冲突裁决用），返回 PullFile 或记错
    fn pull_single(&self, path: &str) -> Result<Option<crate::sync::PullFile>, String> {
        let (files, missing) =
            pull_batch(&self.c, &self.url, &self.profile.token, std::slice::from_ref(&path.to_string()))?;
        if let Some((p, why)) = missing.first() {
            return Err(format!("冲突副本拉取失败 {p}: {why}"));
        }
        Ok(files.into_iter().next())
    }

    /// 步骤 5（M3c，docs/07 §4.2/§5 步骤 5）：edit/edit LWW 裁决——
    /// 版本元组 (mtime, size, hash) 比较，较新者留原路径、较旧者自动降级为**可见**冲突副本
    /// （用户无需任何操作；副本进目录树，下回合随同步传遍全端）：
    /// - 本地新（或平手）→ M2 既有行为：服务器版本拉为本地冲突副本，本地以服务器 hash 为 base 推送
    /// - 服务器新（M2 没有的方向）→ 先把本地当前字节存为冲突副本，再拉服务器 P 覆写本地
    fn resolve_conflicts(&mut self) -> Result<(), String> {
        let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        for (path, _sm_hash) in self.conflicts.iter().cloned() {
            let Some(lm) = self.local_map.get(&path).cloned() else {
                // 不一致态（分类为冲突但本地已无文件，如回合开头 D4 软删后）→ 按「仅服务器有」拉取
                self.to_pull.push(path);
                continue;
            };
            let Some(sm) = self.server_map.get(&path).cloned() else {
                // 不一致态（服务器 manifest 已无该路径）→ 按「仅本地有」推送
                self.to_push.push((path, String::new()));
                continue;
            };
            let local_tuple = (lm.mtime_ms, lm.size, lm.hash.as_str());
            let server_tuple = (sm.mtime_ms, sm.size, sm.hash.as_str());
            let f = match self.pull_single(&path) {
                Ok(Some(f)) => f,
                Ok(None) => {
                    self.report.errors.push(format!("冲突副本拉取为空: {path}"));
                    continue;
                }
                Err(e) => {
                    self.report.errors.push(e);
                    continue;
                }
            };
            if crate::sync::version_gt(server_tuple, local_tuple) {
                // 服务器新：先存本地副本（保证本地内容必落盘，铁律），再拉服务器 P 覆写本地
                let local_bytes = match std::fs::read(self.vault.join(&path)) {
                    Ok(b) => b,
                    Err(e) => {
                        self.report.errors.push(format!("读取本地版本失败 {path}: {e}"));
                        continue;
                    }
                };
                let copy = match write_conflict_copy(&self.vault, conn, &path, &lm.kind, &local_bytes, fs_ops::now_ms()) {
                    Ok(c) => c,
                    Err(e) => {
                        self.report.errors.push(format!("冲突副本落盘失败 {path}: {e}"));
                        continue;
                    }
                };
                // 拉服务器 P 覆写本地（hash 校验；失败时副本已在盘，下回合重试）
                if let Some(e) = store_pulled(&self.vault, conn, &f) {
                    self.report.errors.push(e);
                    continue;
                }
                self.report.pulled.push(path.clone());
                self.baseline.insert(path.clone(), f.hash.clone());
                self.report.merges.push(crate::sync::MergeEvent {
                    path: path.clone(),
                    winner: "server".into(),
                    loser_copy: copy,
                    winner_mtime_ms: f.mtime_ms,
                    loser_mtime_ms: lm.mtime_ms,
                });
            } else {
                // 本地新（或平手，偏本地）：服务器版本 → 本地冲突副本；本地以服务器 hash 为 base 推送
                let bytes = match b64_decode(&f.content_base64) {
                    Ok(b) => b,
                    Err(e) => {
                        self.report.errors.push(format!("冲突副本解码失败 {path}: {e}"));
                        continue;
                    }
                };
                match write_conflict_copy(&self.vault, conn, &path, &f.kind, &bytes, fs_ops::now_ms()) {
                    Ok(copy) => {
                        self.report.merges.push(crate::sync::MergeEvent {
                            path: path.clone(),
                            winner: "local".into(),
                            loser_copy: copy,
                            winner_mtime_ms: lm.mtime_ms,
                            loser_mtime_ms: sm.mtime_ms,
                        });
                    }
                    Err(e) => self.report.errors.push(format!("冲突副本落盘失败 {path}: {e}")),
                }
                self.to_push.push((path, sm.hash));
            }
        }
        Ok(())
    }

    /// 步骤 6：拉取（批量 32）。实拉 hash 进基线（步骤 8：拉取路径 → 实拉 hash）
    fn pull_phase(&mut self) -> Result<(), String> {
        for chunk in self.to_pull.chunks(PULL_BATCH) {
            let (files, missing) =
                pull_batch(&self.c, &self.url, &self.profile.token, chunk)?;
            for (p, why) in missing {
                self.report.errors.push(format!("拉取失败 {p}: {why}"));
            }
            let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
            let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
            for f in files {
                match store_pulled(&self.vault, conn, &f) {
                    None => {
                        self.report.pulled.push(f.path.clone());
                        self.baseline.insert(f.path.clone(), f.hash.clone());
                    }
                    Some(e) => self.report.errors.push(e),
                }
            }
        }
        Ok(())
    }

    /// 步骤 7：推送（批量 8；base_hash 空 = 服务器没有，非空 = 客户端所见服务器旧版）。
    /// M3a（步骤 8 配套）：基线取 `serverHash`（操作后最终 hash）；
    /// 推送被服务器仲裁降级（serverHash ≠ 所推 hash）→ 纠正拉取服务器 P 对齐本地
    fn push_phase(&mut self) -> Result<(), String> {
        // take 出来再分块：块内 corrective_pull 要 &mut self，与 to_push 借用冲突
        let to_push = std::mem::take(&mut self.to_push);
        for chunk in to_push.chunks(PUSH_BATCH) {
            let mut batch = Vec::new();
            for (path, base_hash) in chunk {
                let Some(lm) = self.local_map.get(path).cloned() else { continue };
                let Some(pf) = read_push_file(&self.vault, path, &lm.kind, base_hash) else {
                    self.report.errors.push(format!("推送读取失败: {path}"));
                    continue;
                };
                batch.push(pf);
            }
            if batch.is_empty() {
                continue;
            }
            let results = push_batch(&self.c, &self.url, &self.profile.token, &batch)?;
            for r in results {
                let Some(pf) = batch.iter().find(|f| f.path == r.path) else {
                    continue;
                };
                if !r.ok {
                    self.report
                        .errors
                        .push(format!("推送失败 {}: {}", r.path, r.error.unwrap_or_default()));
                    continue;
                }
                match &r.server_hash {
                    // 被服务器仲裁降级：原路径上是更新的版本（docs/07 §5 步骤 8）
                    Some(sh) if sh != &pf.hash => match self.corrective_pull(&r.path, sh) {
                        Ok((actual, winner_mtime)) => {
                            self.report.pulled.push(r.path.clone());
                            self.baseline.insert(r.path.clone(), actual);
                            // 输家（本次推送内容）已在服务器侧存为冲突副本，下回合作普通文件拉回
                            self.report.merges.push(crate::sync::MergeEvent {
                                path: r.path.clone(),
                                winner: "server".into(),
                                loser_copy: r.conflict_saved_as.clone().unwrap_or_default(),
                                winner_mtime_ms: winner_mtime,
                                loser_mtime_ms: pf.mtime_ms,
                            });
                        }
                        Err(e) => {
                            self.report.errors.push(e);
                            // 兜底：基线 = 所推 hash → 下回合「只有服务器改」快进拉取
                            //（M2 行为：内容在服务器侧副本中安全，无丢失）
                            self.baseline.insert(r.path.clone(), pf.hash.clone());
                        }
                    },
                    Some(sh) => {
                        // 干净落盘 / 来件仲裁获胜：服务器 P = 所推内容
                        self.report.pushed.push(r.path.clone());
                        if let Some(cp) = r.conflict_saved_as {
                            // 仲裁获胜：服务器原版本被降级为副本（下回合拉回本端）
                            self.report.merges.push(crate::sync::MergeEvent {
                                path: r.path.clone(),
                                winner: "local".into(),
                                loser_copy: cp,
                                winner_mtime_ms: pf.mtime_ms,
                                loser_mtime_ms: 0,
                            });
                        }
                        self.baseline.insert(r.path.clone(), sh.clone());
                    }
                    // 旧服务器（无 serverHash 字段）→ M2 行为：ok = 落盘成功
                    None => {
                        self.report.pushed.push(r.path.clone());
                        self.baseline.insert(r.path.clone(), pf.hash.clone());
                    }
                }
            }
        }
        Ok(())
    }

    /// M3a：推送被服务器仲裁降级后，拉服务器 P 现值对齐本地。
    /// 先拉后覆写（hash 校验通过才落盘）；输家内容已有服务器侧冲突副本，无丢失。
    /// 返回 (实拉 hash, 服务器 P 的 mtime_ms)。
    fn corrective_pull(&mut self, path: &str, expect_hash: &str) -> Result<(String, i64), String> {
        let (files, missing) = pull_batch(
            &self.c,
            &self.url,
            &self.profile.token,
            std::slice::from_ref(&path.to_string()),
        )
        .map_err(|e| format!("{path}: 降级纠正拉取失败: {e}"))?;
        if let Some((p, why)) = missing.first() {
            return Err(format!("{p}: 降级纠正拉取被拒: {why}"));
        }
        let f = files
            .first()
            .ok_or_else(|| format!("{path}: 降级纠正拉取为空"))?;
        if f.hash != expect_hash {
            // push 与 pull 之间服务器又被别的客户端改了——拉回内容已 hash 校验，以实拉为准
            log::warn!(
                "同步: {} 降级参照 {} 与实拉 {} 不一致（服务器又变了），以实拉为准",
                path,
                expect_hash,
                f.hash
            );
        }
        let conn_guard = self.state.db.lock().map_err(|_| "DB 锁中毒".to_string())?;
        let conn = conn_guard.as_ref().ok_or("尚未打开 vault")?;
        if let Some(e) = store_pulled(&self.vault, conn, f) {
            return Err(format!("{path}: 降级纠正写入失败: {e}"));
        }
        Ok((f.hash.clone(), f.mtime_ms))
    }

    /// 步骤 8–9：持久化基线 + 返回报告
    fn finish(self) -> Result<SyncReport, String> {
        save_sync_state(&self.vault, &self.profile.id, &self.baseline)?;
        Ok(self.report)
    }
}

/// 一个完整同步回合（docs/07 §5 回合语义 v2 的 M3a+M3b 子集：M2 + serverHash 基线修复
/// + 仲裁降级纠正拉取 + tombstone 删除传播）。阻塞；调用方负责放到 blocking 线程。
pub fn sync_round(state: &Arc<AppState>, profile: &ServerProfile) -> Result<SyncReport, String> {
    let mut core = RoundCore::new(state, profile)?;
    core.server_tombstones_phase()?;
    core.local_tombstones_phase()?;
    core.resolve_conflicts()?;
    core.pull_phase()?;
    core.push_phase()?;
    core.finish()
}

// ---------- mDNS 发现 ----------

/// 浏览 _lanmark._tcp 约 2s，返回去重结果（按 url）。
pub fn discover(timeout: Duration) -> Vec<Discovered> {
    let daemon = match mdns_sd::ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("mDNS daemon 启动失败: {e}");
            return vec![];
        }
    };
    let receiver = match daemon.browse(crate::sync_server::SERVICE_TYPE) {
        Ok(rx) => rx,
        Err(e) => {
            eprintln!("mDNS browse 失败: {e}");
            return vec![];
        }
    };
    let deadline = std::time::Instant::now() + timeout;
    let mut out: Vec<Discovered> = Vec::new();
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        match receiver.recv_timeout(deadline - now) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                let host = info
                    .get_addresses()
                    .iter()
                    .next()
                    .map(|ip| ip.to_string())
                    .or_else(|| info.get_hostname().trim_end_matches('.').to_string().into())
                    .unwrap_or_default();
                if host.is_empty() {
                    continue;
                }
                let url = format!("http://{}:{}", host, info.get_port());
                let name = info.get_fullname().trim_end_matches(&format!(".{}", crate::sync_server::SERVICE_TYPE)).to_string();
                let name = crate::sync_server::service_instance_name(&name);
                if !out.iter().any(|d| d.url == url) {
                    out.push(Discovered { name, url });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.stop_browse(crate::sync_server::SERVICE_TYPE);
    out
}

// ---------- Tauri 命令 ----------

/// mDNS 发现（约 2s 阻塞扫描；异步命令 + blocking 线程，不卡 UI）
#[tauri::command]
pub async fn sync_discover() -> CmdResult<Vec<Discovered>> {
    tauri::async_runtime::spawn_blocking(|| discover(Duration::from_secs(2)))
        .await
        .map_err(|e| format!("发现任务失败: {e}"))
}

// ---------- M4h-1：LAN 扫描发现 ----------

/// 扫描结果（含 deviceId，供 M4h-3 按设备身份匹配）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub devices: Vec<crate::lan_scan::ScannedDevice>,
    /// 因预算截断（可能不全）——UI 说明用
    pub truncated: bool,
    /// 是否做了网段全扫（设置里的开关；关掉时为 false，UI 说明「仅查了已知设备」）
    pub scanned_subnet: bool,
}

/// LAN 发现（M4h-1）：mDNS 一级 best effort → L1 邻居表 → L2 本机网段并发探测。
///
/// **命中即停**：mDNS 或已知地址命中就不再扫描（docs/08 §13.3）——家庭网
/// 一次 browse 就够，公司网才退到扫描。整个命令走 `spawn_blocking`，
/// UI 显示「搜索中」不卡界面（§13.6 R13）。
#[tauri::command]
pub async fn sync_scan_lan(
    app: tauri::AppHandle,
    allow_subnet: Option<bool>,
) -> CmdResult<ScanResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let allow_subnet = allow_subnet.unwrap_or(true);
        // L0-a：mDNS（2s browse；失败/为空都继续往下走）
        let mdns = discover(Duration::from_secs(2));
        // L0-b：已配对 profile 的历史 URL（含历史端口）——IP 变了也能靠它试旧地址
        let servers = load_servers(&app);
        let mut known: Vec<String> = mdns.iter().map(|d| d.url.clone()).collect();
        for s in &servers {
            if !known.contains(&s.url) {
                known.push(s.url.clone());
            }
        }

        // 同网段里已配对服务器的历史端口优先（该设备上次用的端口）
        let known_port = servers.first().and_then(|s| port_of_url(&s.url));

        let neighbors = crate::lan_scan::neighbor_addresses();
        let subnets =
            crate::lan_scan::subnet_candidates(&crate::lan_scan::local_ipv4_addrs());

        let plan = crate::lan_scan::ScanPlan {
            known,
            neighbors,
            subnets,
            known_port,
            allow_subnet,
        };
        let probe = crate::lan_scan::HttpInfoProbe;
        let out = crate::lan_scan::run_scan(&plan, &probe);
        // 标注哪些候选是**已配对**设备（按设备身份匹配，IP 变了也算同一台）——
        // UI 据此把已配对设备排在前面 / 显示「已连接」，而不是让用户对着一堆
        // 陌生卡片猜哪个是自己的手机（docs/08 §13.4）。
        let mut devices = out.devices;
        devices.sort_by_key(|d| {
            let known = match_by_identity(&servers, &d.device_id, &d.name).is_some();
            (!known, d.name.clone())
        });
        Ok(ScanResult {
            devices,
            truncated: out.truncated,
            scanned_subnet: allow_subnet,
        })
    })
    .await
    .map_err(|e| format!("扫描任务失败: {e}"))?
}

// ---------- M4h-2：桌面侧「一键授权」客户端 ----------

/// 配对请求的轮询结局（前端四态：等待 / 批准 / 拒绝 / 超时）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairAttempt {
    /// "approved" | "rejected" | "timeout" | "error"
    pub status: String,
    /// approved 时的 profile（已落盘）
    pub profile: Option<ServerProfile>,
    /// rejected / error 时的原因
    pub reason: Option<String>,
}

/// 客户端名：桌面主机名（手机端 UI 显示「『nwj-PC』请求连接」）。
/// 拿不到主机名就退回平台名——UI 里显示成「你的电脑」也比空白强。
fn client_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "Lanmark 电脑".into()))
}

/// 生成一次性 nonce（32 位十六进制）
fn gen_nonce() -> String {
    use sha2::{Digest, Sha256};
    let material = format!(
        "{}{}{:p}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        std::process::id(),
        &std::env::temp_dir(),
    );
    let hash = Sha256::digest(material.as_bytes());
    hash.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// 提交配对请求并轮询等待手机端点「允许」（docs/08 §13.3 ②）。
///
/// 桌面等待上限 90s（§13.3：超时/拒绝 → 面板回到设备列表并提示）。
/// 返回 `PairAttempt`，**不抛错**——超时与拒绝都是正常结局，交给 UI 呈现。
/// 阻塞；调用方负责放到 blocking 线程。
pub fn request_pair_blocking(
    url: &str,
    timeout: Duration,
) -> PairAttempt {
    let url = match normalize_url(url) {
        Ok(u) => u,
        Err(e) => return PairAttempt { status: "error".into(), profile: None, reason: Some(e) },
    };
    let nonce = gen_nonce();
    let c = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return PairAttempt { status: "error".into(), profile: None, reason: Some(e.to_string()) }
        }
    };
    let posted = c
        .post(format!("{url}/api/v1/pair-request"))
        .json(&serde_json::json!({ "clientName": client_name(), "nonce": nonce }))
        .send();
    match posted {
        Ok(r) if r.status().is_success() => {}
        Ok(r) if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            return PairAttempt {
                status: "error".into(),
                profile: None,
                reason: Some("对方手机上待确认的请求过多，请稍后再试".into()),
            }
        }
        Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
            // 旧版本服务器没有这个端点 → 提示用户走「手动连接」（8 位配对码兜底）
            return PairAttempt {
                status: "error".into(),
                profile: None,
                reason: Some("对方是无一键授权的旧版本，请用「手动连接」输入配对码".into()),
            }
        }
        Ok(r) => {
            return PairAttempt {
                status: "error".into(),
                profile: None,
                reason: Some(format!("请求失败（HTTP {}）", r.status())),
            }
        }
        Err(e) => {
            return PairAttempt {
                status: "error".into(),
                profile: None,
                reason: Some(format!("连接失败: {e}")),
            }
        }
    }

    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() >= deadline {
            return PairAttempt {
                status: "timeout".into(),
                profile: None,
                reason: Some("等待对方确认超时".into()),
            };
        }
        std::thread::sleep(Duration::from_millis(1200));
        let resp = c
            .get(format!("{url}/api/v1/pair-status"))
            .query(&[("nonce", nonce.as_str())])
            .send();
        let Ok(resp) = resp else { continue }; // 网络抖动：继续轮询到超时
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<serde_json::Value>() else { continue };
        match v.get("status").and_then(|s| s.as_str()) {
            Some("pending") => continue,
            Some("approved") => {
                let Some(token) = v.get("token").and_then(|t| t.as_str()) else {
                    continue;
                };
                let name = v
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("Lanmark 手机")
                    .to_string();
                // 取设备身份（决定 profile.id）——拿不到就退回 hash id
                let device_id = fetch_info(&url).map(|i| i.device_id).unwrap_or_default();
                return PairAttempt {
                    status: "approved".into(),
                    profile: Some(ServerProfile {
                        id: profile_id(&device_id, &url, token),
                        name,
                        url: url.clone(),
                        token: token.to_string(),
                        last_success_at: None,
                        device_id,
                        port: port_of_url(&url),
                    }),
                    reason: None,
                };
            }
            Some("rejected") => {
                return PairAttempt {
                    status: "rejected".into(),
                    profile: None,
                    reason: v
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| Some("对方拒绝了这次连接".into())),
                }
            }
            // invalid：过期或被消费
            _ => {
                return PairAttempt {
                    status: "timeout".into(),
                    profile: None,
                    reason: Some("请求已过期，请重试".into()),
                }
            }
        }
    }
}

/// 一键授权连接设备（桌面 UI：[连接] 按钮）。成功即落盘 profile。
///
/// `timeoutSecs` 由前端给（默认 90）；上限 300s 防前端传个巨大的值把线程占住。
#[tauri::command]
pub async fn sync_connect_device(
    app: tauri::AppHandle,
    url: String,
    timeout_secs: Option<u64>,
) -> CmdResult<PairAttempt> {
    let secs = timeout_secs.unwrap_or(90).clamp(5, 300);
    tauri::async_runtime::spawn_blocking(move || {
        let attempt = request_pair_blocking(&url, Duration::from_secs(secs));
        if let Some(profile) = &attempt.profile {
            let mut servers = load_servers(&app);
            servers.retain(|s| {
                s.url != profile.url
                    && (profile.device_id.is_empty() || s.device_id != profile.device_id)
            });
            servers.push(profile.clone());
            save_servers(&app, &servers)?;
        }
        Ok(attempt)
    })
    .await
    .map_err(|e| format!("配对任务失败: {e}"))?
}

/// 配对并保存服务器（pair 成功才落盘）
#[tauri::command]
pub async fn sync_pair(
    app: tauri::AppHandle,
    url: String,
    code: String,
) -> CmdResult<ServerProfile> {
    tauri::async_runtime::spawn_blocking(move || {
        let (token, name) = pair(&url, &code)?;
        let url = normalize_url(&url)?;
        // M4h-3：配对后立刻取 deviceId，让 profile 从第一次起就绑设备身份
        let device_id = fetch_info(&url).map(|i| i.device_id).unwrap_or_default();
        let mut servers = load_servers(&app);
        let profile = ServerProfile {
            id: profile_id(&device_id, &url, &token),
            name,
            url: url.clone(),
            token,
            last_success_at: None,
            device_id,
            port: port_of_url(&url),
        };
        // 同一台设备（按身份）或同一个 url 都视为已在列表里 → 替换而不是新增
        servers.retain(|s| {
            s.url != profile.url
                && (profile.device_id.is_empty() || s.device_id != profile.device_id)
        });
        servers.push(profile.clone());
        save_servers(&app, &servers)?;
        Ok(profile)
    })
    .await
    .map_err(|e| format!("配对任务失败: {e}"))?
}

/// 已配对服务器列表。
///
/// M4h-3：这里顺带做一次**惰性 profile 迁移**——M2/M3 的旧 profile 用
/// `hash(url+token)` 当 id，IP 一变就得重配对且基线文件会换名（docs/08 §13.1 P4）。
/// 迁移要探测设备（拿 deviceId），是网络动作，所以放在「打开同步面板」这条
/// 用户可见的路径上做，而不是每次 `load_servers` 都做（那会让同步回合变慢）。
/// 迁移失败/设备离线都不阻断列表返回——下次再迁。
#[tauri::command]
pub async fn sync_servers(app: tauri::AppHandle) -> CmdResult<Vec<ServerProfile>> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut servers = load_servers(&app);
        // 只在确有旧格式 profile 时才动网（避免无谓探测拖慢面板打开）
        if servers.iter().any(|s| s.device_id.is_empty()) {
            let vault = vault_of(&app);
            let n = match vault {
                Some(v) => migrate_profiles_to_device_id(&v, &mut servers),
                None => 0,
            };
            if n > 0 {
                log::info!("M4h-3：{n} 个已配对设备换绑到设备身份（IP 变化不再需要重配）");
                save_servers(&app, &servers)?;
            }
        }
        Ok(servers)
    })
    .await
    .map_err(|e| format!("读取服务器列表失败: {e}"))?
}

/// 当前 vault 路径（迁移需要它来定位 `.lanmark/sync-<id>.json` 基线文件）
fn vault_of(app: &tauri::AppHandle) -> Option<PathBuf> {
    crate::vault::load_config(app)
        .vault_path
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

#[tauri::command]
pub fn sync_server_remove(app: tauri::AppHandle, id: String) -> CmdResult<()> {
    let mut servers = load_servers(&app);
    servers.retain(|s| s.id != id);
    save_servers(&app, &servers)
}

/// 立即同步（阻塞回合放进 blocking 线程）。
/// Rust 侧全局互斥兜底：UI 锁（syncing 标志）之外的双发（快速双击/多窗口）
/// 会让两个回合并发 reindex/写基线文件互踩
static SYNC_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct SyncGuard;
impl Drop for SyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> CmdResult<SyncReport> {
    use std::sync::atomic::Ordering;
    if SYNC_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("同步回合进行中，请稍候".into());
    }
    let _guard = SyncGuard;
    let servers = load_servers(&app);
    let profile = servers
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("未找到服务器: {id}"))?;
    let state = state.inner().clone();
    let report = tauri::async_runtime::spawn_blocking(move || sync_round(&state, &profile))
        .await
        .map_err(|e| format!("同步任务失败: {e}"))?
        .map_err(|e| e)?;
    // M3e：回合成功 → 记最近成功时间（profile JSON 持久化，重启不丢）
    let mut servers = load_servers(&app);
    if let Some(s) = servers.iter_mut().find(|s| s.id == id) {
        s.last_success_at = Some(fs_ops::now_ms());
        let _ = save_servers(&app, &servers);
    }
    Ok(report)
}

/// `/api/v1/info` 的响应体（M4h-1 起多带 `deviceId`）
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct InfoResponse {
    pub app: String,
    pub name: String,
    /// M4h-3：设备身份。**旧服务器无该字段 → 空串**，调用方回退名称匹配
    /// （docs/08 §13.3 ③）
    pub device_id: String,
    pub notes: u64,
    pub assets: u64,
}

/// GET `/api/v1/info`（无鉴权、3s 超时）——探测与扫描共用的唯一入口。
///
/// 校验 `app == "lanmark"`：M4h-1 的 LAN 扫描会连到任意开着 4180 端口的主机，
/// 没有这个校验就会把别人的服务当成笔记库列给用户（docs/08 §13.3 ①）。
pub fn fetch_info(url: &str) -> Result<InfoResponse, String> {
    let c = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("构建客户端失败: {e}"))?;
    let r = c
        .get(format!("{}/api/v1/info", url.trim_end_matches('/')))
        .send()
        .map_err(|e| format!("连接失败: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("服务返回 {}", r.status()));
    }
    let info: InfoResponse = r.json().map_err(|e| format!("响应解析失败: {e}"))?;
    if info.app != "lanmark" {
        return Err("不是 Lanmark 服务器".into());
    }
    Ok(info)
}

/// M3 自动同步循环的轻量探测（阻塞，可单测）：GET /info（无鉴权、3s 超时）。
/// 不读清单、不算 hash——单线程服务器上被刷请求会停摆，循环每 60s 一探测必须廉价。
/// 网络错误/超时/非 2xx 一律 online=false（探测永不抛错：循环按退避继续）。
pub(crate) fn probe_server(url: &str, name: &str) -> ProbeResult {
    match fetch_info(url) {
        Ok(i) => ProbeResult { online: true, name: i.name, notes: i.notes, assets: i.assets },
        Err(_) => ProbeResult { online: false, name: name.to_string(), notes: 0, assets: 0 },
    }
}

/// Tauri 命令封装（薄层：定位 profile → blocking 线程探测）
#[tauri::command]
pub async fn sync_probe(app: tauri::AppHandle, id: String) -> CmdResult<ProbeResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let servers = load_servers(&app);
        let profile = servers
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("未找到服务器: {id}"))?;
        let url = normalize_url(&profile.url)?;
        Ok(probe_server(&url, &profile.name))
    })
    .await
    .map_err(|e| format!("探测任务失败: {e}"))?
}

/// M3 P2（mDNS 连续监听兜底）：探测连续失败后 browse 到同名服务器 → 更新 url 重连。
/// 与 pair 同纪律：normalize_url 校验 + 原子写 profile。
#[tauri::command]
pub fn sync_server_set_url(app: tauri::AppHandle, id: String, url: String) -> CmdResult<ServerProfile> {
    let url = normalize_url(&url)?;
    let mut servers = load_servers(&app);
    let s = servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("未找到服务器: {id}"))?;
    s.url = url.clone();
    save_servers(&app, &servers)?;
    Ok(servers.into_iter().find(|s| s.id == id).unwrap())
}

pub type CmdResult<T> = Result<T, String>;

#[cfg(test)]
#[allow(non_snake_case)] // 测试惯用短标识（dA/deskA/profile_a…）
mod tests {
    use super::*;
    use crate::commands::{
        asset_save_op, entry_delete_op, entry_rename_op, folder_create_op, note_create_op,
        note_write_op, open_vault_at,
    };
    use crate::sync::{b64_encode, load_tombstones};
    use crate::sync_server::test_util::start_phone_server;
    use crate::vault::AppState;

    fn client_vault() -> (tempfile::TempDir, Arc<AppState>) {
        let dir = tempfile::TempDir::new().unwrap();
        let state = Arc::new(AppState::default());
        open_vault_at(&state, dir.path()).unwrap();
        (dir, state)
    }

    /// 测试：显式设定文件 mtime（LWW 仲裁确定性；真实场景由保存时间自然分布）
    fn set_mtime(state: &Arc<AppState>, rel: &str, ms: i64) {
        let vault = state.vault.lock().unwrap().clone().unwrap();
        let abs = vault.join(rel);
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64);
        let times = std::fs::FileTimes::new().set_modified(t);
        std::fs::File::open(&abs).unwrap().set_times(times).unwrap();
    }

    /// 测试：vault 全量快照（相对路径 → 内容 hash；跳过点目录与孤儿 tmp）
    fn vault_snapshot(vault: &Path) -> std::collections::BTreeMap<String, String> {
        fn walk(dir: &Path, vault: &Path, out: &mut std::collections::BTreeMap<String, String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let p = e.path();
                let s = e.file_name().to_string_lossy().to_string();
                if s.starts_with('.') {
                    continue; // .lanmark/（索引/回收站/基线）不参与收敛比对
                }
                if p.is_dir() {
                    walk(&p, vault, out);
                } else if p.is_file() && !s.contains("lanmark-tmp") {
                    if let Ok(b) = std::fs::read(&p) {
                        let rel = fs_ops::rel_to_string(p.strip_prefix(vault).unwrap());
                        out.insert(rel, fs_ops::content_hash(&b));
                    }
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(vault, vault, &mut out);
        out
    }

    #[test]
    fn pair_requires_correct_code() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let app = Arc::new(AppState::default());
        open_vault_at(&app, phone_dir.path()).unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), app);

        assert!(pair(&base, "00000000").is_err());
        assert!(pair(&base, &code).is_ok());
        assert!(pair("not-a-url", "x").is_err());
        assert!(pair(&base, "").is_err());
    }

    #[test]
    fn sync_round_full_flow_bidirectional() {
        // 手机端：两篇笔记 + 一个附件（手机侧建一篇、稍后桌面侧建一篇）
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note_a = note_create_op(&phone, "", "手机笔记").unwrap();
        note_write_op(&phone, &note_a.path, "手机端内容甲").unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"img-phone"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        // 桌面端：一篇手机没有的笔记
        let (desk_dir, desk) = client_vault();
        let note_b = note_create_op(&desk, "", "桌面笔记").unwrap();
        note_write_op(&desk, &note_b.path, "桌面端内容乙").unwrap();

        // 配对 → round 1：手机 → 桌面（2 文件），桌面 → 手机（1 笔记）
        let (token, name) = pair(&base, &code).unwrap();
        assert!(!name.is_empty());
        let profile = ServerProfile { id: "s1".into(), name: name.clone(), url: base.clone(), token, last_success_at: None, ..Default::default() };
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.pulled.len(), 2, "拉回笔记+附件: {:?}", r1);
        assert_eq!(r1.pushed.len(), 1, "推走桌面笔记: {:?}", r1);
        assert!(r1.merges.is_empty());
        assert_eq!(r1.skipped, 0);
        assert!(r1.errors.is_empty(), "无错误: {:?}", r1.errors);

        // 双方对齐：桌面有手机笔记（内容一致）+ 附件
        let got = std::fs::read_to_string(desk_dir.path().join(&note_a.path)).unwrap();
        assert_eq!(got, "手机端内容甲");
        assert!(desk_dir.path().join(&asset).exists());
        // 手机有桌面笔记
        let got2 = std::fs::read_to_string(phone_dir.path().join(&note_b.path)).unwrap();
        assert_eq!(got2, "桌面端内容乙");

        // round 2：全部 hash 相同 → 全跳过
        let r2 = sync_round(&desk, &profile).unwrap();
        assert!(r2.pulled.is_empty() && r2.pushed.is_empty() && r2.merges.is_empty());
        assert_eq!(r2.skipped, 3, "3 个文件跳过: {:?}", r2);

        // 双向各改一篇 → round 3 互见（无冲突：各自改不同文件）
        note_write_op(&desk, &note_b.path, "桌面端内容乙改").unwrap();
        note_write_op(&phone, &note_a.path, "手机端内容甲改").unwrap();
        let r3 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r3.pulled.len(), 1);
        assert_eq!(r3.pushed.len(), 1);
        assert!(r3.errors.is_empty(), "{:?}", r3.errors);
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(&note_a.path)).unwrap(), "手机端内容甲改");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note_b.path)).unwrap(), "桌面端内容乙改");
    }

    #[test]
    fn sync_round_conflict_keeps_both_versions() {
        // 两端离线各改同一篇 → 同步后双份都在、无丢失（M2 验收项 3）
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "冲突笔记").unwrap();
        note_write_op(&phone, &note.path, "原始内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        // 先同步让桌面拿到原始内容
        let r0 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r0.pulled.len(), 1, "{r0:?}");

        // 离线：两端各改同一篇。桌面 mtime 钉到未来 → LWW 桌面（本地）赢，
        // 测试原意（M2 冲突双份断言）在 LWW 下保持成立
        note_write_op(&desk, &note.path, "桌面版本").unwrap();
        set_mtime(&desk, &note.path, fs_ops::now_ms() + 3_600_000);
        note_write_op(&phone, &note.path, "手机版本").unwrap();

        // 同步回合（LWW 本地赢方向）：手机版本 → 桌面冲突副本；桌面版本 → 推给手机
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.merges.len(), 1, "一个自动合并: {r1:?}");
        assert_eq!(r1.merges[0].winner, "local", "桌面更新 → local 赢: {r1:?}");
        assert_eq!(r1.pushed.len(), 1, "桌面版本推走: {r1:?}");
        assert!(r1.errors.is_empty(), "{:?}", r1.errors);

        // 桌面端：原路径 = 桌面版本，冲突副本 = 手机版本（双份都在）
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(&note.path)).unwrap(), "桌面版本");
        let copy = &r1.merges[0].loser_copy;
        assert!(copy.contains("冲突"), "冲突命名: {copy}");
        assert_eq!(std::fs::read_to_string(desk_dir.path().join(copy)).unwrap(), "手机版本");

        // 手机端：原路径 = 桌面版本（干净覆盖，base_hash 一致），随后回合把冲突副本推过来
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note.path)).unwrap(), "桌面版本");

        // 收敛回合：桌面把冲突副本推给手机 → 两端都有两份
        let r2 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r2.pushed.len(), 1, "冲突副本推送: {r2:?}");
        assert_eq!(r2.skipped, 1, "原路径已一致: {r2:?}");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(copy)).unwrap(), "手机版本");

        // 终态：再跑一轮全跳过（note + 冲突副本）
        let r3 = sync_round(&desk, &profile).unwrap();
        assert!(r3.pulled.is_empty() && r3.pushed.is_empty());
        assert_eq!(r3.skipped, 2);
    }

    #[test]
    fn sync_round_race_on_server_side_conflict_naming() {
        // 推送时服务器版本在 manifest 之后又变了（base_hash 过期）→ 服务器侧冲突命名
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "竞态笔记").unwrap();
        note_write_op(&phone, &note.path, "手机版本一").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };

        let r0 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r0.pulled.len(), 1);

        // 1) 客户端先取 manifest（此刻服务器还是「手机版本一」）
        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let stale_hash = manifest.iter().find(|m| m.path == note.path).unwrap().hash.clone();

        // 2) 桌面基于旧版修改；服务器在 manifest 之后被改成「手机版本二」。
        //    显式设定 mtime：桌面版本更新（M3a 仲裁下来件获胜，M2 断言保持成立）
        note_write_op(&desk, &note.path, "桌面版本").unwrap();
        set_mtime(&desk, &note.path, fs_ops::now_ms() + 3_600_000);
        note_write_op(&phone, &note.path, "手机版本二").unwrap();

        // 3) 客户端带着过期 base_hash 推送 → 服务器仲裁（来件新）：原版本冲突命名
        let pf = read_push_file(desk_dir.path(), &note.path, "note", &stale_hash).unwrap();
        let pushed_hash = pf.hash.clone();
        let results = push_batch(&c, &base, &token, &[pf]).unwrap();
        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "竞态 push 应成功: {:?}", results[0].error);
        let server_copy = results[0].conflict_saved_as.clone().expect("服务器侧应有冲突副本");
        assert!(server_copy.contains("冲突"), "服务器侧冲突命名: {server_copy}");
        // M3a：来件获胜 → serverHash = 所推 hash
        assert_eq!(results[0].server_hash.as_deref(), Some(pushed_hash.as_str()));

        // 服务器：原路径 = 桌面版本，冲突副本 = 手机版本二（双份都在）
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&note.path)).unwrap(), "桌面版本");
        assert_eq!(
            std::fs::read_to_string(phone_dir.path().join(&server_copy)).unwrap(),
            "手机版本二"
        );

        // 4) 收敛回合：服务器多出的冲突副本被桌面拉回，无新冲突
        let r1 = sync_round(&desk, &profile).unwrap();
        assert_eq!(r1.pulled.len(), 1, "拉回服务器侧冲突副本: {r1:?}");
        assert!(r1.merges.is_empty(), "{r1:?}");
        assert!(r1.errors.is_empty(), "{r1:?}");
        assert_eq!(
            std::fs::read_to_string(desk_dir.path().join(&server_copy)).unwrap(),
            "手机版本二"
        );
        // 三份内容都在，无丢失：桌面（桌面版本 + 手机版本二副本）、服务器同
    }

    // ---------- M3a 双客户端集成（docs/07 §9） ----------

    /// 三端（手机服务器 + 桌面×2）顺序改动 → 收敛，终轮全跳过
    #[test]
    #[allow(non_snake_case)]
    fn dual_client_sequential_convergence() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let s_note = note_create_op(&phone, "", "服务器笔记").unwrap();
        note_write_op(&phone, &s_note.path, "服务器内容").unwrap();
        let _s_asset = asset_save_op(&phone, &b64_encode(b"phone-asset"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        // 两个客户端各用独立 id（基线按 id 隔离，模拟两台桌面）
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();

        // 两客户端首次同步：各拉回 2（笔记 + 附件）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // A 改：修改服务器笔记 + 新建笔记
        note_write_op(&deskA, &s_note.path, "服务器内容-A 改").unwrap();
        let na = note_create_op(&deskA, "", "A 新笔记").unwrap();
        note_write_op(&deskA, &na.path, "A 新笔记内容").unwrap();
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pushed.len(), 2, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        // B 同步 → 互见
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // B 改：修改 A 的新笔记 + 新建附件
        note_write_op(&deskB, &na.path, "A 新笔记内容-B 改").unwrap();
        let _b_asset = asset_save_op(&deskB, &b64_encode(b"b-asset"), "png").unwrap();
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 2, "{r:?}");
        // A 同步 → 互见
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 2, "{r:?}");

        // 三端快照一致（收敛）
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()), "A 与服务器不一致");
        assert_eq!(snap_phone, vault_snapshot(dB.path()), "B 与服务器不一致");
        assert_eq!(snap_phone.len(), 4, "4 个同步单元: {snap_phone:?}");

        // 终轮：全跳过
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty() && r.merges.is_empty(), "{r:?}");
        assert_eq!(r.skipped, 4, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty(), "{r:?}");
        assert_eq!(r.skipped, 4, "{r:?}");
    }

    /// 双端离线改同一篇（较新者走冲突分支）→ 较新者留原路径、较旧者成可见副本
    #[test]
    #[allow(non_snake_case)]
    fn dual_client_interleaved_same_file_newer_wins() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "交错笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // 离线：A 改旧版（mtime -1h），B 改新版（mtime +1h）
        note_write_op(&deskA, &p.path, "A 版本").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() - 3_600_000);
        note_write_op(&deskB, &p.path, "B 版本").unwrap();
        set_mtime(&deskB, &p.path, fs_ops::now_ms() + 3_600_000);

        // A 先同步：干净推送 A 版本
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        // B 同步：双方都改 → 冲突分支（B 本地更新）：A 版本 → B 侧副本，B 版本推走
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        assert_eq!(r.merges.len(), 1, "{r:?}");
        assert_eq!(r.merges[0].winner, "local", "B 本地更新 → local 赢: {r:?}");
        let b_copy = r.merges[0].loser_copy.clone();
        // A 再同步：快进拉 B 版本
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "{r:?}");

        // 三端原路径 = B 版本（较新者赢）
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 版本");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 版本");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 版本");

        // 副本传播：B 推 → A 拉 → 三端互见（铁律：A 版本内容不丢）
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "{r:?}");

        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        let copy_rel = snap_phone
            .keys()
            .find(|k| k.contains("冲突"))
            .cloned()
            .expect("冲突副本应在三端");
        assert_eq!(std::fs::read_to_string(dA.path().join(&copy_rel)).unwrap(), "A 版本");
        assert_eq!(copy_rel, b_copy, "A 拉回的副本 = B 侧落地的副本");
    }

    /// 同文件并发竞态：A 的旧版推送晚于 B 的新版落服务器（到达顺序 ≠ mtime 顺序）
    /// → 服务器仲裁降级 A → A 回合内纠正拉取 → 最终 P = mtime 新者，输家副本落点正确
    #[test]
    #[allow(non_snake_case)]
    fn round_demoted_push_corrective_pull_converges() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "竞态笔记").unwrap();
        note_write_op(&phone, &p.path, "基础版").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 离线改「旧版」（mtime -1h），回合开始：此刻服务器还是「基础版」
        note_write_op(&deskA, &p.path, "A 旧版").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() - 3_600_000);
        let mut core = RoundCore::new(&deskA, &profile_a).unwrap();
        // A 的回合分类：只有本地改 → 推送（base = 基础版 hash，即将过期）

        // 注入竞态：B 在 A 的 manifest 之后、推送之前完成整回合（新版 mtime +1h）
        note_write_op(&deskB, &p.path, "B 新版").unwrap();
        set_mtime(&deskB, &p.path, fs_ops::now_ms() + 3_600_000);
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "B 新版干净落盘: {r:?}");

        // A 继续回合：推送 A 旧版（base 已过期）→ 服务器仲裁降级 → 回合内纠正拉取
        core.resolve_conflicts().unwrap();
        core.pull_phase().unwrap();
        core.push_phase().unwrap();
        let report = core.finish().unwrap();
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        // M3c：降级产生一条 LWW 合并事件（server 赢，输家 = 本次推送的 A 旧版）
        assert_eq!(report.merges.len(), 1, "降级应产生合并事件: {report:?}");
        assert_eq!(report.merges[0].winner, "server", "{:?}", report.merges[0]);
        assert_eq!(report.merges[0].path, p.path);
        assert!(report.merges[0].loser_copy.contains("冲突"), "{:?}", report.merges[0]);
        // 铁律核查：A 旧版内容已在服务器侧副本落盘
        let server_snap = vault_snapshot(phone_dir.path());
        assert!(
            server_snap.values().any(|h| *h == fs_ops::content_hash("A 旧版".as_bytes())),
            "降级来件必须已有服务器侧副本: {server_snap:?}"
        );
        // A 本地原路径 = B 新版（纠正拉取对齐，未被快进覆盖）
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 新版");
        // A 基线 = 服务器操作后 hash（G3：不再误判「只有本地改」重推旧版）
        let base_file = dA.path().join(fs_ops::META_DIR).join("sync-sa.json");
        let base_state: HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(base_file).unwrap()).unwrap();
        assert_eq!(
            base_state.get(&p.path),
            Some(&fs_ops::content_hash("B 新版".as_bytes())),
            "基线必须 = serverHash（G3 修复）"
        );

        // 收敛：A、B 各补一回合 → 三端 P = B 新版 + 副本（A 旧版）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "A 拉回降级副本: {r:?}");
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pulled.len(), 1, "B 拉回降级副本: {r:?}");
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 新版");
        let copy_rel = snap_phone
            .keys()
            .find(|k| k.contains("冲突"))
            .cloned()
            .expect("输家副本应在三端");
        assert_eq!(std::fs::read_to_string(dA.path().join(&copy_rel)).unwrap(), "A 旧版");
        // 终轮全跳过
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty() && r.merges.is_empty(), "{r:?}");
        assert_eq!(r.skipped, snap_phone.len());
    }

    /// M3c 客户端 LWW（服务器更新方向，M2 没有的分支）：双端离线改同一篇，
    /// 较新者先同步 → 较旧者回合时服务器版本更新 → 先存本地副本再拉取覆写，
    /// 全程无人工操作；副本下回合传遍全端（docs/07 §10 验收 3）
    #[test]
    fn client_lww_server_newer_saves_copy_then_pulls() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "LWW 笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // 离线：A 改新版（mtime 未来），B 改旧版（mtime 过去）
        note_write_op(&deskA, &p.path, "A 新版").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() + 3_600_000);
        note_write_op(&deskB, &p.path, "B 旧版").unwrap();
        let b_mtime = fs_ops::now_ms() - 3_600_000;
        set_mtime(&deskB, &p.path, b_mtime);

        // A 先同步（干净推送）→ 服务器 P = A 新版
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pushed.len(), 1, "{r:?}");
        assert!(r.merges.is_empty(), "{r:?}");

        // B 回合：服务器版本更新（LWW 服务器赢方向）→ 先存本地副本，再拉取覆写
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.pushed.is_empty(), "较旧版本不得推送: {r:?}");
        assert_eq!(r.merges.len(), 1, "一条自动合并（server 赢）: {r:?}");
        let m = &r.merges[0];
        assert_eq!(m.winner, "server");
        assert_eq!(m.path, p.path);
        assert_eq!(m.loser_mtime_ms, b_mtime, "输家 mtime 应为 B 的保存时间");
        assert!(m.loser_copy.contains("冲突"), "{m:?}");
        // B 本地：原路径 = A 新版，副本 = B 旧版（双份都在，无丢失）
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "A 新版");
        assert_eq!(std::fs::read_to_string(dB.path().join(&m.loser_copy)).unwrap(), "B 旧版");

        // 副本传播：B 推 → A 拉 → 三端互见（次回合收敛，docs/07 §10-3）
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert_eq!(r.pushed.len(), 1, "副本推送: {r:?}");
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert_eq!(r.pulled.len(), 1, "副本拉取: {r:?}");

        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        let copy_rel = snap_phone
            .keys()
            .find(|k| k.contains("冲突"))
            .cloned()
            .expect("副本应在三端");
        assert_eq!(std::fs::read_to_string(dA.path().join(&copy_rel)).unwrap(), "B 旧版");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "A 新版");
        // 终轮全跳过
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.is_empty() && r.pushed.is_empty() && r.merges.is_empty(), "{r:?}");
        assert_eq!(r.skipped, snap_phone.len());
    }

    /// LWW 时间源保真（docs/07 §2 的核心决策）：裁决按文件 mtime 而非到达顺序。
    /// A 的旧版（10:00）先到达服务器，B 的新版（10:05）后到达（base 过期）→
    /// B 必须赢。若服务器落地时把 mtime 重写成落地时刻（到达顺序），A 会误赢。
    #[test]
    fn server_mtime_preservation_lww_not_arrival_order() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "到达顺序笔记").unwrap();
        note_write_op(&phone, &p.path, "基础").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let c = client();

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let base_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let base_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let _ = sync_round(&deskA, &base_a).unwrap();
        let _ = sync_round(&deskB, &base_b).unwrap();
        let stale_base = c
            .get(format!("{base}/api/v1/manifest"))
            .header("authorization", format!("Bearer {token}"))
            .send()
            .unwrap()
            .json::<Vec<crate::sync::FileMeta>>()
            .unwrap()
            .into_iter()
            .find(|m| m.path == p.path)
            .unwrap()
            .hash;

        // A 旧版（保存时刻 = now-3600s），B 新版（保存时刻 = now-1800s）
        note_write_op(&deskA, &p.path, "A 的 10:00 编辑").unwrap();
        set_mtime(&deskA, &p.path, fs_ops::now_ms() - 3_600_000);
        note_write_op(&deskB, &p.path, "B 的 10:05 编辑").unwrap();
        set_mtime(&deskB, &p.path, fs_ops::now_ms() - 1_800_000);

        // A 先到达（干净落盘），B 后到达（base 过期 → 服务器仲裁）
        let pf_a = read_push_file(dA.path(), &p.path, "note", &stale_base).unwrap();
        let r = push_batch(&c, &base, &token, &[pf_a]).unwrap();
        assert!(r[0].ok, "{:?}", r[0].error);
        let pf_b = read_push_file(dB.path(), &p.path, "note", &stale_base).unwrap();
        let r = push_batch(&c, &base, &token, &[pf_b]).unwrap();
        assert!(r[0].ok, "B 的推送应成功（内容进副本或原路径）: {:?}", r[0].error);

        // B（保存时间更新）必须留在原路径；A 的内容成可见副本
        assert_eq!(
            std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(),
            "B 的 10:05 编辑",
            "服务器必须按 mtime 裁决（B 新），不得按到达顺序（A 先到）"
        );
        let server_snap = vault_snapshot(phone_dir.path());
        assert!(
            server_snap.values().any(|h| *h == fs_ops::content_hash("A 的 10:00 编辑".as_bytes())),
            "A 的内容必须留存为副本: {server_snap:?}"
        );
    }

    // ---------- M3b tombstone（docs/07 §9） ----------

    /// 删除传播：hash 相同（删后没再改）→ 三端软删，回收站都有，不再拉回复活
    #[test]
    fn delete_propagation_hash_match() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "删除笔记").unwrap();
        note_write_op(&phone, &p.path, "内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除（本地 UI 路径：entry_delete_op → 回收站 + tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        assert!(load_tombstones(dA.path()).iter().any(|t| t.path == p.path));

        // A 回合：删除传播到服务器（/delete → 服务器回收站 + 服务器 tombstone）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "A 报告删除: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            load_tombstones(phone_dir.path()).iter().any(|t| t.path == p.path),
            "服务器应记 tombstone"
        );
        assert!(!phone_dir.path().join(&p.path).exists(), "服务器原路径应已软删");

        // B 回合：服务器 tombstone → B 本地软删 + 记本地 tombstone
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "B 报告删除: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&p.path).exists(), "B 本地应软删");
        assert!(load_tombstones(dB.path()).iter().any(|t| t.path == p.path));

        // 铁律：三端回收站都有（内容未丢）
        for (label, vault) in [("A", dA.path()), ("B", dB.path()), ("服务器", phone_dir.path())] {
            let trash = vault.join(fs_ops::TRASH_DIR);
            let found = std::fs::read_dir(&trash)
                .unwrap()
                .flatten()
                .any(|e| {
                    e.path().is_file()
                        && std::fs::read_to_string(e.path())
                            .map(|c| c == "内容")
                            .unwrap_or(false)
                });
            assert!(found, "{label} 回收站应保留被删内容");
        }

        // 后续回合：不拉回复活（M2 会复活，M3b 修掉）
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "不得拉回已删文件: {r:?}");
        assert!(!dA.path().join(&p.path).exists());
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
    }

    /// 删后编辑：编辑更新（mtime > 删除时刻）→ 推送复活，服务器 D4 清 tombstone
    #[test]
    fn delete_vs_edit_edit_newer_resurrects() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "复活笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除并同步（服务器 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let del_ms = load_tombstones(dA.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // B 离线编辑（mtime 晚于删除时刻）
        note_write_op(&deskB, &p.path, "B 的新编辑").unwrap();
        set_mtime(&deskB, &p.path, del_ms + 3_600_000);

        // B 回合：服务器 tombstone vs 本地编辑 → 编辑赢 → 推送复活
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "B 应推送复活: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert!(
            load_tombstones(phone_dir.path()).iter().all(|t| t.path != p.path),
            "服务器 D4：复活后 tombstone 应清除"
        );

        // A 回合：拉回复活后的 P；本地 tombstone 被 D4（服务器编辑更新）清除
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pulled.iter().any(|x| x == &p.path), "A 应拉回复活文件: {r:?}");
        assert_eq!(std::fs::read_to_string(dA.path().join(&p.path)).unwrap(), "B 的新编辑");
        assert!(load_tombstones(dA.path()).iter().all(|t| t.path != p.path), "A 的 tombstone 应清除");
    }

    /// 删后编辑：删除更新（编辑 mtime < 删除时刻）→ 本地再软删，内容进回收站
    #[test]
    fn delete_vs_edit_delete_newer_soft_deletes() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "删除赢笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // B 先离线编辑（mtime 旧）
        note_write_op(&deskB, &p.path, "B 的旧编辑").unwrap();
        let old_ms = fs_ops::now_ms() - 3_600_000;
        set_mtime(&deskB, &p.path, old_ms);

        // A 删除（晚于编辑）并同步
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // B 回合：编辑（旧）vs 删除（新）→ 删除赢 → B 软删 + 本地 tombstone
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "B 应软删: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&p.path).exists(), "B 原路径应消失");
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let kept = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .any(|e| {
                e.path().is_file()
                    && std::fs::read_to_string(e.path())
                        .map(|c| c == "B 的旧编辑")
                        .unwrap_or(false)
            });
        assert!(kept, "铁律：B 的旧编辑内容必须留在回收站");
        // 终态：三端都没有该文件，不复活
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        assert!(!dA.path().join(&p.path).exists(), "A 端保持删除");
    }

    /// 平手（编辑 mtime == 删除时刻）→ 编辑恒赢（删除元组 size=0）
    #[test]
    fn delete_vs_edit_tie_edit_wins() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "平手笔记").unwrap();
        note_write_op(&phone, &p.path, "原始").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (_dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除并同步（服务器墓碑时间 = /delete 处理时刻，B 回合看到的就是它）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let del_ms = load_tombstones(phone_dir.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;

        // B 编辑，mtime 恰好 == 服务器删除时刻（平手）
        note_write_op(&deskB, &p.path, "B 平手编辑").unwrap();
        set_mtime(&deskB, &p.path, del_ms);

        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "平手时编辑必须赢（size=0 规则）: {r:?}");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "B 平手编辑");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "B 平手编辑");
    }

    /// 双方已删 → 跳过，无错误无复活
    #[test]
    fn delete_both_sides_already_deleted_skip() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "双删笔记").unwrap();
        note_write_op(&phone, &p.path, "内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步；B 直接删除（未同步，服务器已有 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        entry_delete_op(&deskB, &p.path).unwrap();

        // B 回合：双方已删 → 静默跳过
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.pulled.iter().all(|x| x != &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        // A 再回合：无动作
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dA.path().join(&p.path).exists());
    }

    /// D4：删除后同路径重新创建 → tombstone 清除，文件推送复活
    #[test]
    fn d4_recreation_clears_tombstone() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "重建笔记").unwrap();
        note_write_op(&phone, &p.path, "旧内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步（服务器 tombstone），然后同路径重建（create_note → D4 清本地 tombstone）
        entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let created = note_create_op(&deskA, "", "重建笔记").unwrap();
        assert_eq!(created.path, p.path, "同路径重建: {:?}", created.path);
        note_write_op(&deskA, &created.path, "重建内容").unwrap();
        assert!(
            load_tombstones(dA.path()).iter().all(|t| t.path != p.path),
            "D4：重建后本地 tombstone 应清除"
        );

        // A 回合：推送重建内容（base 空）→ 服务器 D4 清 tombstone
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "{r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(
            load_tombstones(phone_dir.path()).iter().all(|t| t.path != p.path),
            "服务器 tombstone 应清除"
        );
        // B 回合：正常拉取（当作新文件），无删除传播
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.is_empty(), "{r:?}");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "重建内容");
    }

    /// TTL：30 天以上的 tombstone 回合开头清理；新鲜 tombstone 保留
    #[test]
    fn tombstone_ttl_purge() {
        let (_dir, desk) = client_vault();
        let vault = desk.vault.lock().unwrap().clone().unwrap();
        let now = fs_ops::now_ms();

        crate::sync::record_tombstone(&vault, "过期.md", "h1", now - crate::sync::TOMBSTONE_TTL_MS - 1).unwrap();
        crate::sync::record_tombstone(&vault, "新鲜.md", "h2", now - 86_400_000).unwrap();
        assert_eq!(load_tombstones(&vault).len(), 2);

        let removed = crate::sync::purge_expired_tombstones(&vault, now).unwrap();
        assert_eq!(removed, 1);
        let kept = load_tombstones(&vault);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].path, "新鲜.md");
    }

    /// 文件夹删除：tombstone 展开为文件级 → 三端内容全部软删（铁律）
    #[test]
    fn folder_delete_expands_tombstones() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let f = folder_create_op(&phone, "", "项目").unwrap();
        let n1 = note_create_op(&phone, &f.path, "笔记一").unwrap();
        let n2 = note_create_op(&phone, &f.path, "笔记二").unwrap();
        note_write_op(&phone, &n1.path, "一").unwrap();
        note_write_op(&phone, &n2.path, "二").unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"dir-asset"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删整个文件夹
        entry_delete_op(&deskA, &f.path).unwrap();
        let ts = load_tombstones(dA.path());
        for expected in [&n1.path, &n2.path] {
            assert!(ts.iter().any(|t| t.path == *expected), "文件夹应展开为文件 tombstone: {ts:?}");
        }
        assert!(ts.iter().all(|t| t.path != asset), "根级附件不得被文件夹展开波及: {ts:?}");

        // A 回合：传播到服务器
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!phone_dir.path().join(&n1.path).exists(), "服务器 n1 应软删");
        assert!(!phone_dir.path().join(&n2.path).exists(), "服务器 n2 应软删");
        assert!(phone_dir.path().join(&asset).exists(), "根级附件必须存活");

        // B 回合：服务器 tombstone → B 本地软删
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!dB.path().join(&n1.path).exists(), "B n1 应软删: {r:?}");
        assert!(!dB.path().join(&n2.path).exists(), "B n2 应软删");
        assert!(dB.path().join(&asset).exists(), "B 根级附件必须存活");
        // 铁律：B 回收站保留文件夹内 2 个文件内容
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let contents: Vec<Vec<u8>> = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| std::fs::read(e.path()).ok())
            .collect();
        for expect in ["一".as_bytes().to_vec(), "二".as_bytes().to_vec()] {
            assert!(contents.iter().any(|c| *c == expect), "B 回收站缺内容: {expect:?}");
        }

        // 终态：三端快照一致（文件夹内笔记全没了，根级附件都在）
        let snap_phone = vault_snapshot(phone_dir.path());
        assert_eq!(snap_phone, vault_snapshot(dA.path()));
        assert_eq!(snap_phone, vault_snapshot(dB.path()));
        assert!(snap_phone.iter().all(|(k, _)| !k.starts_with(&f.path)));
        assert!(snap_phone.contains_key(&asset));
    }

    /// 回收站恢复（mtime 保留旧值）→ 删除仍然有效：再软删，不复活
    #[test]
    fn stale_restore_from_trash_keeps_deletion() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "恢复笔记").unwrap();
        note_write_op(&phone, &p.path, "内容甲").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // 删除 + 同步（服务器 tombstone）
        let trash_path = entry_delete_op(&deskA, &p.path).unwrap();
        let del_ms = load_tombstones(dA.path())
            .into_iter()
            .find(|t| t.path == p.path)
            .unwrap()
            .mtime_ms;
        let _ = sync_round(&deskA, &profile_a).unwrap();

        // 从回收站恢复（fs::rename，mtime 保留删除前 < del_ms）
        let abs = dA.path().join(&p.path);
        std::fs::rename(dA.path().join(&trash_path), &abs).unwrap();
        assert!(crate::sync::meta_mtime_ms(&abs) <= del_ms, "恢复文件 mtime 应保留旧值");

        // 回合：陈旧恢复 → 再软删（删除仍有效），不推不拉
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(r.pushed.iter().all(|x| x != &p.path), "陈旧恢复不得推送: {r:?}");
        assert!(!abs.exists(), "应再软删");
        // 服务器也仍然没有
        assert!(!phone_dir.path().join(&p.path).exists());
    }

    /// 恢复后再编辑（mtime > 删除时刻）→ D4 复活，推送服务器
    #[test]
    fn restore_and_edit_resurrects() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "恢复编辑笔记").unwrap();
        note_write_op(&phone, &p.path, "内容甲").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 删除 + 同步；恢复 + 编辑（mtime 新）
        let trash_path = entry_delete_op(&deskA, &p.path).unwrap();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let abs = dA.path().join(&p.path);
        std::fs::rename(dA.path().join(&trash_path), &abs).unwrap();
        note_write_op(&deskA, &p.path, "恢复后的编辑").unwrap(); // 编辑 → mtime = now > 删除时刻

        // A 回合：D4 清 tombstone + 推送复活
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.pushed.iter().any(|x| x == &p.path), "应推送复活: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&p.path)).unwrap(), "恢复后的编辑");
        // B 回合：拉取
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.pulled.iter().any(|x| x == &p.path), "{r:?}");
        assert_eq!(std::fs::read_to_string(dB.path().join(&p.path)).unwrap(), "恢复后的编辑");
    }

    /// 重命名 = 旧路径删除传播 + 新路径推送（内容保留，铁律）
    #[test]
    fn rename_propagates_old_path_deletion() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "改名前").unwrap();
        note_write_op(&phone, &p.path, "保留的内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();
        let profile_a = ServerProfile { id: "sa".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };
        let profile_b = ServerProfile { id: "sb".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let (dA, deskA) = client_vault();
        let (dB, deskB) = client_vault();
        let _ = sync_round(&deskA, &profile_a).unwrap();
        let _ = sync_round(&deskB, &profile_b).unwrap();

        // A 重命名
        let new_rel = entry_rename_op(&deskA, &p.path, "改名后").unwrap();
        assert_ne!(new_rel, p.path);
        assert!(load_tombstones(dA.path()).iter().any(|t| t.path == p.path), "旧路径应记 tombstone");

        // A 回合：旧路径 /delete + 新路径推送
        let r = sync_round(&deskA, &profile_a).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "旧路径应传播删除: {r:?}");
        assert!(r.pushed.iter().any(|x| x == &new_rel), "新路径应推送: {r:?}");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        assert!(!phone_dir.path().join(&p.path).exists(), "服务器旧路径应消失");
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&new_rel)).unwrap(), "保留的内容");

        // B 回合：旧路径软删 + 新路径拉取
        let r = sync_round(&deskB, &profile_b).unwrap();
        assert!(r.deleted.iter().any(|x| x == &p.path), "{r:?}");
        assert!(!dB.path().join(&p.path).exists());
        assert_eq!(std::fs::read_to_string(dB.path().join(&new_rel)).unwrap(), "保留的内容");
        // 铁律：B 回收站保留旧路径内容
        let trash = dB.path().join(fs_ops::TRASH_DIR);
        let kept = std::fs::read_dir(&trash)
            .unwrap()
            .flatten()
            .any(|e| {
                e.path().is_file()
                    && std::fs::read_to_string(e.path())
                        .map(|c| c == "保留的内容")
                        .unwrap_or(false)
            });
        assert!(kept, "B 回收站应保留旧路径内容");
    }

    /// 旧服务器（无 /tombstones）→ 404 按空列表处理，不报错
    #[test]
    fn fetch_tombstones_404_degrades_to_empty() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                listener.set_nonblocking(true).unwrap();
                let tl = tokio::net::TcpListener::from_std(listener).unwrap();
                // 空路由 = 模拟旧服务器（任何路径 404）
                let _ = axum::serve(tl, axum::Router::new()).await;
            });
        });
        let c = client();
        let base = format!("http://127.0.0.1:{port}");
        // 等就绪
        for _ in 0..40 {
            if c.get(format!("{base}/api/v1/info")).send().is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let ts = fetch_tombstones(&c, &base, "any-token").unwrap();
        assert!(ts.is_empty(), "404 必须按空列表处理");
    }

    #[test]
    fn sync_round_asset_pull_and_dedup() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let asset = asset_save_op(&phone, &b64_encode(b"binary-image-data"), "png").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token, last_success_at: None, ..Default::default() };

        let r = sync_round(&desk, &profile).unwrap();
        assert_eq!(r.pulled, vec![asset.clone()]);
        // 内容一致
        assert_eq!(
            std::fs::read(desk_dir.path().join(&asset)).unwrap(),
            b"binary-image-data".to_vec()
        );
    }

    #[test]
    fn sync_round_fails_gracefully_without_vault_or_server() {
        let (_dir, desk) = client_vault();
        let profile = ServerProfile { id: "s".into(), name: "x".into(), url: "http://127.0.0.1:1".into(), token: "t".into(), last_success_at: None, ..Default::default() };
        let err = sync_round(&desk, &profile).unwrap_err();
        assert!(!err.is_empty());

        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), phone);
        let (token, _) = pair(&base, &code).unwrap();
        // 无 vault 的 state
        let empty = Arc::new(AppState::default());
        let profile2 = ServerProfile { id: "s".into(), name: "x".into(), url: base, token, last_success_at: None, ..Default::default() };
        assert!(sync_round(&empty, &profile2).is_err());
    }

    #[test]
    fn sync_creates_parent_dirs_and_preserves_asset_names() {
        // 回归（真机验收发现）：对端「空库」没有父目录 / 附件不是内容寻址名
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        // 手机端只有一篇根目录笔记；桌面端有「目录/笔记」和「assets/人名.png」
        let phone_note = note_create_op(&phone, "", "手机笔记").unwrap();
        note_write_op(&phone, &phone_note.path, "手机内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        let (desk_dir, desk) = client_vault();
        let folder = crate::commands::folder_create_op(&desk, "", "工作").unwrap();
        let desk_note = note_create_op(&desk, &folder.path, "会议纪要").unwrap();
        note_write_op(&desk, &desk_note.path, "# 纪要\n\n内容").unwrap();
        let asset_path = "assets/示例图片.png";
        std::fs::create_dir_all(desk_dir.path().join("assets")).unwrap();
        std::fs::write(desk_dir.path().join(asset_path), "fake-png-数据".as_bytes()).unwrap();
        // 非 UTF-8 的 .md（如 GBK 编码的外来文件）也必须能同步（hash 按字节）
        let foreign = "工作/GBK笔记.md";
        std::fs::write(desk_dir.path().join(foreign), [0xC4, 0xE3, 0xBA, 0xC3]).unwrap();

        let (token, _) = pair(&base, &code).unwrap();
        let profile = ServerProfile { id: "s1".into(), name: "phone".into(), url: base.clone(), token: token.clone(), last_success_at: None, ..Default::default() };

        let r = sync_round(&desk, &profile).unwrap();
        assert!(r.errors.is_empty(), "应无错误: {:?}", r.errors);
        // 推送：工作/会议纪要.md + GBK笔记.md + 附件（+ 根目录无重名文件）
        assert_eq!(r.pushed.len(), 3, "推送 3 个: {r:?}");
        assert_eq!(r.pulled.len(), 1, "拉取手机笔记: {r:?}");

        // 服务器侧：父目录被创建、附件保留人名、GBK 文件字节原样
        assert_eq!(std::fs::read_to_string(phone_dir.path().join(&desk_note.path)).unwrap(), "# 纪要\n\n内容");
        assert_eq!(std::fs::read(phone_dir.path().join(asset_path)).unwrap(), "fake-png-数据".as_bytes().to_vec());
        assert_eq!(std::fs::read(phone_dir.path().join(foreign)).unwrap(), vec![0xC4, 0xE3, 0xBA, 0xC3]);

        // 服务器 manifest 与 pull 字节一致（修复1+2：磁盘真相）
        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let asset_meta = manifest.iter().find(|m| m.path == asset_path).unwrap();
        let served = std::fs::read(phone_dir.path().join(asset_path)).unwrap();
        assert_eq!(asset_meta.hash, crate::fs_ops::content_hash(&served));

        // 终态：再跑一轮全跳过
        let r2 = sync_round(&desk, &profile).unwrap();
        assert!(r2.pulled.is_empty() && r2.pushed.is_empty() && r2.merges.is_empty(), "{r2:?}");
        assert_eq!(r2.skipped, 4);
    }

    #[test]
    fn manifest_reflects_external_disk_changes() {
        // 回归（真机验收发现）：磁盘被外部改动后（DB 未更新），manifest 必须反映磁盘
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "外部改动").unwrap();
        note_write_op(&phone, &note.path, "初始内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, _) = pair(&base, &code).unwrap();

        // 外部直接改文件（绕过 write_note，DB 保持旧值）
        std::fs::write(phone_dir.path().join(&note.path), "外部改过的内容").unwrap();

        let c = client();
        let manifest = fetch_manifest(&c, &base, &token).unwrap();
        let meta = manifest.iter().find(|m| m.path == note.path).unwrap();
        assert_eq!(
            meta.hash,
            crate::fs_ops::content_hash("外部改过的内容".as_bytes()),
            "manifest 必须反映磁盘"
        );
        // pull 服务的 hash 与内容一致（客户端校验必过）
        let (files, missing) = pull_batch(&c, &base, &token, &[note.path.clone()]).unwrap();
        assert!(missing.is_empty());
        assert_eq!(files[0].hash, crate::fs_ops::content_hash("外部改过的内容".as_bytes()));
    }

    /// M3 探测：在线服务器 → online + 设备统计；离线（未监听端口）→ online=false 不抛错
    #[test]
    fn probe_server_online_and_offline() {
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        note_create_op(&phone, "", "探测笔记").unwrap();
        let (base, _code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));

        // 服务器线程启动有延迟，探测重试到在线（最多 2s）
        let mut online = None;
        for _ in 0..40 {
            let p = probe_server(&base, "phone");
            if p.online {
                online = Some(p);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let p = online.expect("2s 内应探测到在线");
        assert!(p.notes >= 1, "{p:?}");

        // 离线：未监听的端口 → online=false（探测永不抛错）
        let off = probe_server("http://127.0.0.1:1", "phone");
        assert!(!off.online, "{off:?}");
        assert_eq!(off.name, "phone");
    }

    #[test]
    fn normalize_url_rules() {
        assert_eq!(normalize_url(" http://1.2.3.4:4180/ ").unwrap(), "http://1.2.3.4:4180");
        assert!(normalize_url("https://x").is_err(), "M2 仅明文 http");
        assert!(normalize_url("ftp://x").is_err());
        assert!(normalize_url("1.2.3.4").is_err());
        assert!(normalize_url("").is_err());
    }

    // ---------- M4h-3：profile 换绑设备身份 + 基线迁移 ----------

    #[test]
    fn profile_id_binds_device_identity() {
        // 有身份：id 由身份决定，url/token 变了也不变 → IP 变化不丢基线
        let a = profile_id("abc123", "http://192.168.1.5:4180", "tok1");
        let b = profile_id("abc123", "http://192.168.1.99:4180", "tok2");
        assert_eq!(a, b, "同一设备的 id 必须与 url/token 无关");
        assert_eq!(a, "dabc123");
        // 无身份（旧服务器）：沿用 hash(url+token)
        let c = profile_id("", "http://192.168.1.5:4180", "tok1");
        assert!(c.starts_with('s'));
        assert_ne!(c, profile_id("", "http://192.168.1.9:4180", "tok1"));
    }

    #[test]
    fn match_by_identity_prefers_device_id_over_name() {
        let servers = vec![
            ServerProfile { id: "d1".into(), name: "手机".into(), device_id: "dev-1".into(), ..Default::default() },
            ServerProfile { id: "d2".into(), name: "手机".into(), device_id: "dev-2".into(), ..Default::default() },
        ];
        // 同名两台设备：必须按身份命中正确那台
        assert_eq!(match_by_identity(&servers, "dev-2", "手机").unwrap().id, "d2");
        // 身份未知（旧服务器）：回退名称匹配，但只匹配同样没身份的
        assert!(match_by_identity(&servers, "", "手机").is_none(), "有身份的不能被名称匹配到");
        let legacy = vec![ServerProfile { id: "s1".into(), name: "老手机".into(), device_id: "".into(), ..Default::default() }];
        assert_eq!(match_by_identity(&legacy, "", "老手机").unwrap().id, "s1");
        assert_eq!(match_by_identity(&legacy, "dev-new", "老手机").unwrap().id, "s1");
        assert!(match_by_identity(&legacy, "dev-new", "别的名字").is_none());
    }

    /// 迁移核心：旧 id 的基线文件必须**改名**到新 id，状态不丢。
    /// 丢基线的后果是下回合全库判「双方都改」→ 冲突副本激增（docs/08 §13.1 P4）。
    #[test]
    fn migrate_renames_baseline_file_and_keeps_state() {
        use crate::commands::open_vault_at;
        // 起一台「手机」服务器（它有自己的 deviceId）
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let p = note_create_op(&phone, "", "笔记").unwrap();
        note_write_op(&phone, &p.path, "内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, name) = pair(&base, &code).unwrap();
        let device_id = crate::sync_server::load_sync_config(phone_dir.path()).device_id;

        // 桌面：造一个「旧格式」profile（id = hash(url+token)），并写一份基线
        let (desk_dir, desk) = client_vault();
        let old_id = format!("s{}", &fs_ops::content_hash(format!("{base}{token}").as_bytes())[..8]);
        let mut servers = vec![ServerProfile {
            id: old_id.clone(),
            name,
            url: base.clone(),
            token: token.clone(),
            last_success_at: None,
            device_id: String::new(), // 旧格式：没有身份
            port: None,
        }];
        // 该设备上轮已知的服务器状态（模拟已同步过一轮）
        let mut baseline: HashMap<String, String> = HashMap::new();
        baseline.insert(p.path.clone(), "deadbeef".into());
        save_sync_state(desk_dir.path(), &old_id, &baseline).unwrap();
        assert!(sync_state_path(desk_dir.path(), &old_id).exists());

        // 迁移
        let n = migrate_profiles_to_device_id(desk_dir.path(), &mut servers);
        assert_eq!(n, 1, "离线设备不该被迁移…这里在线，应迁移 1 个");
        assert_eq!(servers[0].device_id, device_id, "换绑到设备身份");
        assert_eq!(servers[0].id, format!("d{device_id}"));
        assert_ne!(servers[0].id, old_id);

        // **基线必须跟着改名而不是重建**：内容一字不差
        let new_path = sync_state_path(desk_dir.path(), &servers[0].id);
        assert!(new_path.exists(), "新 id 的基线文件应存在");
        assert!(!sync_state_path(desk_dir.path(), &old_id).exists(), "旧文件应已改名");
        assert_eq!(load_sync_state(desk_dir.path(), &servers[0].id), baseline, "基线状态不丢");

        // 幂等：再迁一次不重复动作
        let mut again = servers.clone();
        assert_eq!(migrate_profiles_to_device_id(desk_dir.path(), &mut again), 0);
        assert_eq!(again[0], servers[0]);
    }

    /// 离线设备（探测不到）保持原样，下次同步再迁——不能因此丢凭据
    #[test]
    fn migrate_skips_unreachable_devices() {
        let (desk_dir, _desk) = client_vault();
        // 127.0.0.1:1 必然连不上
        let mut servers = vec![ServerProfile {
            id: "sold1234".into(),
            name: "离线手机".into(),
            url: "http://127.0.0.1:1".into(),
            token: "tok".into(),
            device_id: String::new(),
            ..Default::default()
        }];
        assert_eq!(migrate_profiles_to_device_id(desk_dir.path(), &mut servers), 0);
        assert_eq!(servers[0].id, "sold1234", "id 保持原样");
        assert!(servers[0].device_id.is_empty());
        assert_eq!(servers[0].token, "tok", "凭据不丢");
    }

    /// 迁移后回合一整轮：不再产生「双方都改」的假冲突（P4 回归）
    #[test]
    fn migration_prevents_false_conflict_storm() {
        use crate::commands::open_vault_at;
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let note = note_create_op(&phone, "", "共享笔记").unwrap();
        note_write_op(&phone, &note.path, "同一份内容").unwrap();
        let (base, code) = start_phone_server(phone_dir.path(), Arc::clone(&phone));
        let (token, name) = pair(&base, &code).unwrap();
        let device_id = crate::sync_server::load_sync_config(phone_dir.path()).device_id;

        let (desk_dir, desk) = client_vault();
        let old_id = format!("s{}", &fs_ops::content_hash(format!("{base}{token}").as_bytes())[..8]);
        let mut servers = vec![ServerProfile {
            id: old_id.clone(),
            name,
            url: base.clone(),
            token: token.clone(),
            device_id: String::new(),
            ..Default::default()
        }];
        save_sync_state(desk_dir.path(), &old_id, &HashMap::new()).unwrap();

        // 第一轮：桌面从零开始 → 拉取
        let r1 = sync_round(&desk, &servers[0]).unwrap();
        assert!(r1.errors.is_empty(), "{:?}", r1.errors);
        assert_eq!(r1.pulled.len(), 1);

        // 迁移（模拟升级到 M4h-3 后的首次启动）
        assert_eq!(migrate_profiles_to_device_id(desk_dir.path(), &mut servers), 1);
        assert_eq!(servers[0].device_id, device_id);

        // 迁移后立刻再回合：双方内容一致 → 不应产生冲突副本
        let r2 = sync_round(&desk, &servers[0]).unwrap();
        assert!(r2.errors.is_empty(), "{:?}", r2.errors);
        assert!(r2.merges.is_empty(), "迁移后不得出现假冲突: {:?}", r2.merges);
        assert!(r2.pushed.is_empty(), "无改动不该推送: {:?}", r2.pushed);
        assert!(r2.pulled.is_empty(), "无改动不该拉取: {:?}", r2.pulled);
    }

    /// 旧服务器（/info 无 deviceId）→ 保持 hash id，回退名称匹配
    #[test]
    fn legacy_server_without_device_id_keeps_hash_profile() {
        let (desk_dir, _desk) = client_vault();
        let mut servers = vec![ServerProfile {
            id: "skeep".into(),
            name: "旧手机".into(),
            url: "http://127.0.0.1:1".into(),
            token: "t".into(),
            ..Default::default()
        }];
        // 探测失败 → 一个都不迁，且不报错
        assert_eq!(migrate_profiles_to_device_id(desk_dir.path(), &mut servers), 0);
        assert_eq!(servers[0].id, "skeep");
    }

    #[test]
    fn port_of_url_parses_typical_forms() {
        assert_eq!(port_of_url("http://192.168.1.5:4180"), Some(4180));
        assert_eq!(port_of_url("http://192.168.1.5:4189/"), Some(4189));
        assert_eq!(port_of_url("http://phone.local:4180"), Some(4180));
        assert_eq!(port_of_url("http://192.168.1.5"), None);
        assert_eq!(port_of_url("nonsense"), None);
    }

    // ---------- M4h-2：桌面侧一键授权客户端 ----------

    /// 端到端：桌面发起请求 → 手机侧批准 → 桌面拿到 profile（id 绑设备身份）
    #[test]
    fn connect_device_end_to_end() {
        use crate::commands::open_vault_at;
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let (base, _code, ctx) = crate::sync_server::test_util::start_phone_server_with_ctx(
            phone_dir.path(),
            Arc::clone(&phone),
        );

        // 手机侧「人」在 200ms 后点允许（模拟用户在手机上操作）
        let approver = {
            let ctx = Arc::clone(&ctx);
            std::thread::spawn(move || {
                for _ in 0..50 {
                    std::thread::sleep(Duration::from_millis(100));
                    let pending = crate::sync_server::list_pending(&ctx);
                    if let Some(p) = pending.first() {
                        crate::sync_server::approve_pending(&ctx, &p.nonce).unwrap();
                        return true;
                    }
                }
                false
            })
        };

        let attempt = request_pair_blocking(&base, Duration::from_secs(20));
        assert!(approver.join().unwrap(), "手机侧应看到请求");
        assert_eq!(attempt.status, "approved", "{:?}", attempt.reason);
        let profile = attempt.profile.expect("批准后应给出 profile");
        let device_id = crate::sync_server::load_sync_config(phone_dir.path()).device_id;
        assert_eq!(profile.device_id, device_id, "profile 绑设备身份");
        assert_eq!(profile.id, format!("d{device_id}"));
        assert_eq!(profile.name, "Lanmark 手机");
        assert!(!profile.token.is_empty());
        assert_eq!(profile.port, port_of_url(&base));

        // profile 可直接用于同步回合
        let (desk_dir, desk) = client_vault();
        let _ = desk_dir;
        let r = sync_round(&desk, &profile).unwrap();
        assert!(r.errors.is_empty(), "{:?}", r.errors);
    }

    /// 拒绝 → status=rejected 且没有 profile（不落盘任何东西）
    #[test]
    fn connect_device_rejected() {
        use crate::commands::open_vault_at;
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let (base, _code, ctx) = crate::sync_server::test_util::start_phone_server_with_ctx(
            phone_dir.path(),
            Arc::clone(&phone),
        );
        let rejecter = {
            let ctx = Arc::clone(&ctx);
            std::thread::spawn(move || {
                for _ in 0..50 {
                    std::thread::sleep(Duration::from_millis(100));
                    if let Some(p) = crate::sync_server::list_pending(&ctx).first() {
                        crate::sync_server::reject_pending(&ctx, &p.nonce).unwrap();
                        return;
                    }
                }
            })
        };
        let attempt = request_pair_blocking(&base, Duration::from_secs(20));
        rejecter.join().unwrap();
        assert_eq!(attempt.status, "rejected");
        assert!(attempt.profile.is_none(), "拒绝不得留下 profile");
        assert!(crate::sync_server::load_sync_config(phone_dir.path()).tokens.is_empty());
    }

    /// 无人应答 → 超时（不卡死；UI 拿到 timeout 后回设备列表）
    #[test]
    fn connect_device_times_out() {
        use crate::commands::open_vault_at;
        let phone_dir = tempfile::TempDir::new().unwrap();
        let phone = Arc::new(AppState::default());
        open_vault_at(&phone, phone_dir.path()).unwrap();
        let (base, _code, _ctx) = crate::sync_server::test_util::start_phone_server_with_ctx(
            phone_dir.path(),
            Arc::clone(&phone),
        );
        let t0 = std::time::Instant::now();
        let attempt = request_pair_blocking(&base, Duration::from_secs(2));
        assert_eq!(attempt.status, "timeout");
        assert!(attempt.profile.is_none());
        assert!(t0.elapsed() < Duration::from_secs(15), "超时应及时返回");
    }

    /// 连不上（端口无人）→ error，不 panic
    #[test]
    fn connect_device_unreachable_reports_error() {
        let attempt = request_pair_blocking("http://127.0.0.1:1", Duration::from_secs(2));
        assert_eq!(attempt.status, "error");
        assert!(attempt.reason.is_some());
    }

    /// 地址非法 → error（不做任何网络动作）
    #[test]
    fn connect_device_validates_url() {
        let attempt = request_pair_blocking("192.168.1.5:4180", Duration::from_secs(2));
        assert_eq!(attempt.status, "error");
        assert!(attempt.reason.unwrap().contains("http://"));
    }

    #[test]
    fn nonce_is_unique_and_hex() {
        let a = gen_nonce();
        let b = gen_nonce();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
