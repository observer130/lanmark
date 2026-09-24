//! Vault 全局配置（app_config_dir/config.json）与运行时状态。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::settings::{Appearance, EditorPrefs, Settings, StoragePrefs};

/// 运行时共享状态：当前 vault 路径 + 它的索引连接。
/// 以 Arc 形式 manage 进 Tauri（Mutex 不可 Clone，无法直接 clone 状态结构体）。
#[derive(Default)]
pub struct AppState {
    pub vault: Mutex<Option<PathBuf>>,
    pub db: Mutex<Option<Connection>>,
    /// M2 同步服务器实际监听端口（None = 未启动）；幂等启动的判据
    pub sync_port: Mutex<Option<u16>>,
    /// M3e：最近一次客户端回合触达同步服务器的时间（unix ms，0 = 从未；
    /// /manifest 是每回合签名动作，服务器 handler 更新；手机端面板展示）
    pub last_sync_round_at: std::sync::atomic::AtomicI64,
    /// M3f：服务器侧同步改动 vault（push 落盘/delete 生效）→ UI 刷新回调。
    /// Tauri setup 注册（经 AppHandle emit 事件）；手机是服务器、无客户端循环，
    /// 不通知则目录仍列远端已删笔记（点击报「笔记不存在」）。
    /// 测试用 AppState::default() = None = 无操作。
    pub sync_notify: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

fn default_sync_auto() -> bool {
    true
}

/// 设备级配置。**全部小节都 `serde(default)`**：M3 及更早的 config.json 直接可读，
/// 缺字段取默认（docs/08 §4.2）。同步周期不在这里——D1 定了固定 60s，不进配置。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub vault_path: Option<String>,
    /// M3：桌面端自动同步开关（默认开；旧配置无此字段 → serde default，docs/07 §7）
    #[serde(default = "default_sync_auto")]
    pub sync_auto: bool,
    /// M4a：外观（字体/字号/行距/行宽/界面缩放）
    pub appearance: Appearance,
    /// M4a：编辑器偏好
    pub editor: EditorPrefs,
    /// M4a：存储策略（回收站保留天数）
    pub storage: StoragePrefs,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vault_path: None,
            sync_auto: true,
            appearance: Appearance::default(),
            editor: EditorPrefs::default(),
            storage: StoragePrefs::default(),
        }
    }
}

impl AppConfig {
    /// 取出设置三小节（供 `settings_get`）
    pub fn settings(&self) -> Settings {
        Settings {
            appearance: self.appearance.clone(),
            editor: self.editor.clone(),
            storage: self.storage.clone(),
        }
    }
}

pub fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    tauri::Manager::path(app)
        .app_config_dir()
        .ok()
        .map(|d| d.join("config.json"))
}

pub fn load_config(app: &tauri::AppHandle) -> AppConfig {
    config_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_config(app: &tauri::AppHandle, cfg: &AppConfig) -> std::io::Result<()> {
    let path = config_path(app)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "无法定位配置目录"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // tmp+rename 原子写：此前直接 fs::write，写一半断电会损坏 JSON，
    // load 端静默回退默认 → vault 配置丢失
    crate::fs_ops::atomic_write(&path, serde_json::to_string_pretty(cfg)?.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrip() {
        let cfg = AppConfig { vault_path: Some("/tmp/vault".into()), sync_auto: false, ..AppConfig::default() };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.vault_path.as_deref(), Some("/tmp/vault"));
        assert!(!back.sync_auto);
        assert_eq!(AppConfig::default().vault_path, None);
        assert!(AppConfig::default().sync_auto, "默认开");
        // M2 旧配置（无 syncAuto 字段）→ 默认 true，不丢 vault_path
        let legacy = r#"{"vaultPath": "/tmp/vault"}"#;
        let back: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(back.vault_path.as_deref(), Some("/tmp/vault"));
        assert!(back.sync_auto, "旧配置兼容：syncAuto 默认 true");
    }

    /// M4a 关键回归：M0–M3 时期的 config.json（只有 vaultPath + syncAuto）
    /// 必须能直接读，且三小节取默认、vault_path 不丢。
    #[test]
    fn m3_config_migrates_to_m4_settings() {
        let legacy = r#"{"vaultPath":"/home/u/notes","syncAuto":false}"#;
        let cfg: AppConfig = serde_json::from_str(legacy).unwrap();
        assert_eq!(cfg.vault_path.as_deref(), Some("/home/u/notes"));
        assert!(!cfg.sync_auto);
        let s = cfg.settings();
        assert_eq!(s, crate::settings::Settings::default(), "新小节取默认");
        // 回写并重读：旧字段不丢、新小节落盘（升级后首次改设置即完整化配置）
        let round: AppConfig = serde_json::from_str(&serde_json::to_string(&cfg).unwrap()).unwrap();
        assert_eq!(round.vault_path.as_deref(), Some("/home/u/notes"));
        assert!(!round.sync_auto);
        assert_eq!(round.settings(), crate::settings::Settings::default());
    }

    /// 只有 vaultPath 的更老配置（M1/M2 无同步开关）
    #[test]
    fn oldest_config_still_opens_vault() {
        let cfg: AppConfig = serde_json::from_str(r#"{"vaultPath":"/tmp/v"}"#).unwrap();
        assert_eq!(cfg.vault_path.as_deref(), Some("/tmp/v"));
        assert!(cfg.sync_auto);
    }
}
