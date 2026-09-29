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
}
