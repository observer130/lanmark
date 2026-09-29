//! M5-4 应用内更新：GitHub release 版本检测（关于页展示）。
//!
//! 分工：本模块只做「检测」——比较当前版本与 GitHub 最新 release 的 tag，
//! 节流状态（≥24h 一次）记在 AppConfig。安装侧（Windows updater 插件 /
//! Linux 自更新 / Android 跳发布页）是 M5-5/5-6 的活。
//! 纯逻辑（版本比较、节流判定、release → UpdateInfo）与网络/命令分离，可单测；
//! 命令走 `spawn_blocking`（与 sync_client 同惯例）。
//!
//! 为什么查 `/releases/latest`：GitHub 自动排除 draft 与 prerelease，
//! 版本比较只需三元组（见 `version_tuple`）；匿名限额 60 次/时/IP，
//! 24h 节流后绰绰有余。

use serde::{Deserialize, Serialize};

use crate::commands::CmdResult;

/// GitHub API：最新正式 release（不含 draft / prerelease）
pub const RELEASE_API_URL: &str = "https://api.github.com/repos/observer130/lanmark/releases/latest";
/// 自动检查节流窗口：24h。手动「检查更新」不受此限（force）。
pub const CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

// ---------- 数据结构 ----------

/// GitHub `/releases/latest` 响应中我们关心的字段（其余忽略）
#[derive(Debug, Deserialize)]
pub struct ReleaseInfo {
    pub tag_name: String,
    pub html_url: String,
    /// release notes 的 markdown 正文（可能很长，构建 UpdateInfo 时截断）
    #[serde(default)]
    pub body: String,
}

/// `update_check` 命令的返回体（前端据此渲染关于页更新状态）
#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    /// None = 本次没有查到新信息（被节流跳过）
    pub latest_version: Option<String>,
    pub has_update: bool,
    pub notes: Option<String>,
    pub html_url: Option<String>,
    /// 本次检查（或节流窗口内上次检查）的 unix ms（0 = 从未检查过）
    pub checked_at_ms: u64,
    /// true = 距上次检查不足 24h，未实际发起请求（前端不改 UI 状态）
    pub skipped: bool,
}

// ---------- 纯逻辑 ----------

/// `"v0.4.0"` / `"0.4.0"` → `(0, 4, 0)`。缺失/非数字段按 0；
/// 第三段后的尾巴（如 `-rc.1`）截断忽略——`/releases/latest` 不含 prerelease。
pub fn version_tuple(v: &str) -> (u64, u64, u64) {
    let t = v.trim().trim_start_matches(['v', 'V']);
    let mut parts = t.split('.');
    let mut next_num = || -> u64 {
        parts
            .next()
            .map(|s| {
                let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().unwrap_or(0)
            })
            .unwrap_or(0)
    };
    (next_num(), next_num(), next_num())
}

/// 语义化比较：latest 严格大于 current 才算有更新（相等 = 已是最新）。
pub fn has_update(current: &str, latest: &str) -> bool {
    version_tuple(latest) > version_tuple(current)
}

/// 节流判定：手动（force）总是查；自动检查距上次 ≥24h 才查。
pub fn check_due(last_check_ms: u64, now_ms: u64, force: bool) -> bool {
    force || now_ms.saturating_sub(last_check_ms) >= CHECK_INTERVAL_MS
}

/// notes 正文截断（about 页只展示摘要，全量在发布页）
const NOTES_MAX_CHARS: usize = 600;

/// ReleaseInfo + 当前版本 → UpdateInfo（时间戳由命令层补）。
pub fn build_update_info(current: &str, release: &ReleaseInfo, checked_at_ms: u64) -> UpdateInfo {
    let notes = {
        let b = release.body.trim();
        if b.is_empty() {
            None
        } else {
            let mut t: String = b.chars().take(NOTES_MAX_CHARS).collect();
            if t.chars().count() < b.chars().count() {
                t.push('…');
            }
            Some(t)
        }
    };
    UpdateInfo {
        current_version: current.to_string(),
        latest_version: Some(release.tag_name.trim_start_matches(['v', 'V']).to_string()),
        has_update: has_update(current, &release.tag_name),
        notes,
        html_url: Some(release.html_url.clone()),
        checked_at_ms,
        skipped: false,
    }
}

// ---------- 网络与命令 ----------

fn fetch_latest() -> Result<ReleaseInfo, String> {
    let c = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(HTTP_TIMEOUT)
        .user_agent("lanmark-update-check")
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
    let r = c
        .get(RELEASE_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| format!("请求 GitHub 失败: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GitHub 返回 {}", r.status()));
    }
    r.json::<ReleaseInfo>().map_err(|e| format!("解析 GitHub 响应失败: {e}"))
}

/// 检查更新的同步实现（命令经 spawn_blocking 调用）。
///
/// 节流纪律：**成功才回写 `last_update_check_ms`**——失败（无网/限流）不记，
/// 下次启动立刻重试；手动检查成功同样回写（避免每次进关于页都打 GitHub）。
fn update_check_sync(app: &tauri::AppHandle, force: bool) -> CmdResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let mut cfg = crate::vault::load_config(app);
    let now = crate::bridge::now_unix_ms();
    if !check_due(cfg.last_update_check_ms, now, force) {
        return Ok(UpdateInfo {
            current_version: current,
            latest_version: None,
            has_update: false,
            notes: None,
            html_url: None,
            checked_at_ms: cfg.last_update_check_ms,
            skipped: true,
        });
    }
    let release = fetch_latest()?;
    let info = build_update_info(&current, &release, now);
    cfg.last_update_check_ms = now;
    crate::vault::save_config(app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(info)
}

/// 检查更新。`force=false`：启动自动检查（24h 节流）；`force=true`：手动检查。
/// 失败返回 Err——自动路径由前端静默吞掉，手动路径浮出到关于页。
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle, force: bool) -> CmdResult<UpdateInfo> {
    tauri::async_runtime::spawn_blocking(move || update_check_sync(&app, force))
        .await
        .map_err(|e| format!("更新检查任务失败: {e}"))?
}

// ---------- M5-6：Linux 自更新 ----------
//
// 官方 updater 插件只支持 AppImage/deb/rpm 安装格式，而我们发的是**裸二进制
// tar.gz**（AppImage 有 Intel Arc 兼容性问题，见 AGENTS.md）。自更新流程：
//   下载 tar.gz + .sig → minisign 验签（与 Windows 同一密钥）→ 解包找 `lanmark`
//   → rename 现行可执行文件（Linux 运行中可改名）→ 写入新二进制 + chmod 755
//   → `app.restart()` 重启（restart_on_exit 语义，见 tauri AppHandle::restart）。
// 纯逻辑（公钥行提取、tar 内找条目）与网络/命令分离，可单测。

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use base64::Engine as _;
    use std::io::Read;

    /// tauri.conf.json 里 plugins.updater.pubkey 的同一个值（外层 base64 包装，
    /// 解开后的第二行才是 minisign 内层公钥）。
    pub const PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJEQzUzMzY1NDY0QjY2MUEKUldRYVprdEdaVFBGdll6NzZkRzFTV0c3eUxsT052dVVJOFE1SUl3UFh5UXpSMGsxbVpOYmI2cVoK";

    /// 从外层 base64 包装里取 minisign **内层公钥行**（`PublicKey::from_base64`
    /// 只认这一行，不认整个 pub 文件）。
    pub fn inner_public_key_line(pubkey_b64: &str) -> Result<String, String> {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(pubkey_b64.trim())
            .map_err(|e| format!("公钥 base64 解码失败: {e}"))?;
        let text = String::from_utf8(decoded).map_err(|e| format!("公钥不是 UTF-8: {e}"))?;
        let line = text
            .lines()
            .nth(1)
            .ok_or("公钥文件缺少第二行（内层 key）")?
            .trim()
            .to_string();
        if line.is_empty() {
            return Err("公钥内层行为空".into());
        }
        Ok(line)
    }

    /// 从 tar.gz 字节里解出**仓库根名恰为 `lanmark`** 的单个二进制条目。
    /// 只接受根目录条目（`lanmark`），拒绝任何路径穿越（`/`、`..`）。
    pub fn extract_binary(tar_gz: &[u8]) -> Result<Vec<u8>, String> {
        let gz = flate2::read::GzDecoder::new(tar_gz);
        let mut archive = tar::Archive::new(gz);
        let mut found: Option<Vec<u8>> = None;
        for entry in archive
            .entries()
            .map_err(|e| format!("tar 遍历失败: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("tar 条目读取失败: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("tar 路径读取失败: {e}"))?
                .to_path_buf();
            if path != std::path::Path::new("lanmark") {
                continue;
            }
            if !entry
                .header()
                .entry_type()
                .is_file()
            {
                return Err("tar 里的 lanmark 不是普通文件".into());
            }
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("二进制读取失败: {e}"))?;            found = Some(buf);
            break;
        }
        found.ok_or_else(|| "tar 包内未找到根级 `lanmark` 二进制".into())
    }

    /// 下载 release 资产（tar.gz 与 .sig 走同一构造逻辑）。
    fn download(url: &str) -> Result<Vec<u8>, String> {
        let c = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .connect_timeout(std::time::Duration::from_secs(10))
            .user_agent("lanmark-update-check")
            .build()
            .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
        let r = c
            .get(url)
            .send()
            .map_err(|e| format!("下载失败: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("下载返回 {}", r.status()));
        }
        r.bytes()
            .map(|b| b.to_vec())
            .map_err(|e| format!("下载读取失败: {e}"))
    }

    /// 自更新同步实现（命令经 spawn_blocking 调用）。
    pub fn self_update(app: &tauri::AppHandle, tag: &str) -> Result<(), String> {
        let base = format!("https://github.com/observer130/lanmark/releases/download/{tag}");
        let tar_gz = download(&format!("{base}/lanmark-linux-x64.tar.gz"))?;
        let sig_file = download(&format!("{base}/lanmark-linux-x64.tar.gz.sig"))?;
        // tauri signer 的 .sig 是**外层 base64 包装**的 minisign 签名（与 .pub
        // 同构），Signature::decode 只认解包后的四行文本
        let sig_text = {
            let b64 = String::from_utf8(sig_file).map_err(|_| "签名文件不是 UTF-8".to_string())?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map_err(|e| format!("签名 base64 解码失败: {e}"))?;
            String::from_utf8(decoded).map_err(|_| "签名内容不是 UTF-8".to_string())?
        };

        // 验签：公钥固定在二进制里（tauri.conf.json 同源），签名必须有效
        let pub_key = minisign_verify::PublicKey::from_base64(&inner_public_key_line(PUBKEY_B64)?)
            .map_err(|e| format!("公钥解析失败: {e}"))?;
        let signature = minisign_verify::Signature::decode(&sig_text)
            .map_err(|e| format!("签名解析失败: {e}"))?;
        pub_key
            .verify(&tar_gz, &signature, false)
            .map_err(|e| format!("验签失败（更新包不可信）: {e}"))?;

        let new_bin = extract_binary(&tar_gz)?;
        if new_bin.is_empty() {
            return Err("更新包里的二进制为空".into());
        }

        // 替换现行可执行文件：Linux 允许 rename 运行中的程序。
        // current_exe 在打包容器里测试不可得，错误信息里带上路径便于排查。
        let exe = std::env::current_exe().map_err(|e| format!("无法定位自身可执行文件: {e}"))?;
        let old = exe.with_extension("old");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old).map_err(|e| format!("备份旧程序失败（{}）: {e}", exe.display()))?;
        let write = std::fs::write(&exe, &new_bin);
        if let Err(e) = write {
            // 写失败 → 尽力回滚（旧文件还在 .old）
            let _ = std::fs::rename(&old, &exe);
            return Err(format!("写入新程序失败: {e}"));
        }
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::rename(&old, &exe);
            return Err(format!("设置可执行权限失败: {e}"));
        }
        // 清理 .old 与签名测试残留成功后才走——保留到重启后也没机会删了，
        // 让新进程首启清理（这里简单处理：尽力删，失败不影响更新）
        let _ = std::fs::remove_file(&old);

        log::info!("Linux 自更新完成，重启应用（tag={tag}）");
        app.restart(); // -> !
    }
}

/// Linux 自更新命令：下载 + 验签 + 替换二进制 + 重启。
/// `tag` 来自前端已确认的 UpdateInfo.htmlUrl 解析（v 前缀可带可不带）。
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn update_install_linux(app: tauri::AppHandle, tag: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || linux::self_update(&app, tag.trim_start_matches('v')))
        .await
        .map_err(|e| format!("自更新任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tuple_parses_v_prefix_and_suffix() {
        assert_eq!(version_tuple("0.4.0"), (0, 4, 0));
        assert_eq!(version_tuple("v0.5.10"), (0, 5, 10));
        assert_eq!(version_tuple("V1.2.3"), (1, 2, 3));
        assert_eq!(version_tuple("0.4"), (0, 4, 0), "缺段补 0");
        assert_eq!(version_tuple("0.4.0-rc.1"), (0, 4, 0), "尾巴截断忽略");
        assert_eq!(version_tuple("garbage"), (0, 0, 0), "非数字按 0，不 panic");
        assert_eq!(version_tuple(""), (0, 0, 0));
    }

    #[test]
    fn has_update_is_strictly_greater() {
        assert!(has_update("0.4.0", "0.5.0"));
        assert!(has_update("0.4.0", "0.4.1"), "补丁位也算更新");
        assert!(has_update("0.4.0", "1.0.0"));
        assert!(!has_update("0.4.0", "0.4.0"), "相同版本不算");
        assert!(!has_update("0.5.0", "0.4.0"), "降级不算更新");
        // v 前缀 / 位数不足都可比
        assert!(has_update("0.4.0", "v0.4.1"));
        assert!(!has_update("0.4.0", "0.4"));
    }

    #[test]
    fn check_due_respects_force_and_interval() {
        let day = CHECK_INTERVAL_MS;
        assert!(check_due(0, day, false), "从未检查过 → 该查");
        assert!(!check_due(day, day + day / 2, false), "半天前查过 → 不查");
        assert!(check_due(day, day + day, false), "满 24h → 该查");
        assert!(check_due(day, day + 1, true), "手动 force 无视节流");
        assert!(!check_due(u64::MAX, 0, false), "saturating_sub 不 panic");
    }

    #[test]
    fn build_update_info_maps_fields_and_truncates_notes() {
        let r = ReleaseInfo {
            tag_name: "v0.5.0".into(),
            html_url: "https://github.com/observer130/lanmark/releases/tag/v0.5.0".into(),
            body: "修复若干问题".into(),
        };
        let info = build_update_info("0.4.0", &r, 12345);
        assert_eq!(info.current_version, "0.4.0");
        assert_eq!(info.latest_version.as_deref(), Some("0.5.0"), "去 v 前缀");
        assert!(info.has_update);
        assert_eq!(info.notes.as_deref(), Some("修复若干问题"));
        assert_eq!(info.checked_at_ms, 12345);
        assert!(!info.skipped);

        // notes 截断：600 字 + 省略号
        let long = "a".repeat(700);
        let r = ReleaseInfo { tag_name: "v0.5.0".into(), html_url: "u".into(), body: long };
        let info = build_update_info("0.4.0", &r, 0);
        let notes = info.notes.unwrap();
        assert_eq!(notes.chars().count(), NOTES_MAX_CHARS + 1);
        assert!(notes.ends_with('…'));

        // 空 notes → None
        let r = ReleaseInfo { tag_name: "v0.5.0".into(), html_url: "u".into(), body: String::new() };
        assert!(build_update_info("0.4.0", &r, 0).notes.is_none());
    }

    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            current_version: "0.4.0".into(),
            latest_version: Some("0.5.0".into()),
            has_update: true,
            notes: None,
            html_url: Some("u".into()),
            checked_at_ms: 1,
            skipped: false,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"currentVersion\""), "前端按 camelCase 读: {json}");
        assert!(json.contains("\"hasUpdate\""));
        assert!(json.contains("\"checkedAtMs\""));
    }

    #[cfg(target_os = "linux")]
    mod linux_tests {
        use super::linux::{extract_binary, inner_public_key_line, PUBKEY_B64};

        #[test]
        fn inner_public_key_line_unpacks_wrapper() {
            // 归档 pubkey 与 tauri.conf.json 同源：外层解出三行文本，第二行是内层 key
            // （minisign 公钥 = "RW" 前缀的 base64，56 字符左右——ed25519 key 两行）
            let line = inner_public_key_line(PUBKEY_B64).unwrap();
            assert!(!line.contains("untrusted"), "内层行不是注释");
            assert!(line.starts_with("RW"), "minisign 内层公钥以 RW 开头");
            assert!((50..=80).contains(&line.len()), "长度 {}/内层 key 应在 50-80 之间", line.len());
            assert!(inner_public_key_line("!!!not-base64!!!").is_err());
            assert!(inner_public_key_line("").is_err());
        }

        #[test]
        fn extract_binary_reads_root_entry_and_rejects_missing() {
            // 构造一个只含根级 lanmark 条目的 tar.gz（内容可识别即可，不要求真 ELF）
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::fast(),
            ));
            let payload = b"#!/bin/sh\necho lanmark\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "lanmark", &payload[..]).unwrap();
            let tar_gz = builder.into_inner().unwrap().finish().unwrap();

            let got = extract_binary(&tar_gz).unwrap();
            assert_eq!(got, payload);

            // 缺条目 → 明确报错（不静默返回空）
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::fast(),
            ));
            let mut header = tar::Header::new_gnu();
            header.set_size(3);
            header.set_cksum();
            builder.append_data(&mut header, "other.txt", &b"abc"[..]).unwrap();
            let tar_gz = builder.into_inner().unwrap().finish().unwrap();
            assert!(extract_binary(&tar_gz).is_err());
        }

        #[test]
        fn extract_binary_ignores_nested_paths() {
            // 路径穿越防御：只认根级 `lanmark`，子目录同名不算
            let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::fast(),
            ));
            let mut header = tar::Header::new_gnu();
            header.set_size(4);
            header.set_cksum();
            builder.append_data(&mut header, "sub/lanmark", &b"evil"[..]).unwrap();
            let tar_gz = builder.into_inner().unwrap().finish().unwrap();
            assert!(extract_binary(&tar_gz).is_err(), "嵌套路径不得被当成目标条目");
        }
    }
}
