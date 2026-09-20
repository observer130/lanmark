//! Vault 全局配置（app_config_dir/config.json）与运行时状态。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub vault_path: Option<String>,
    /// M3：桌面端自动同步开关（默认开；旧配置无此字段 → serde default，docs/07 §7）
    #[serde(default = "default_sync_auto")]
    pub sync_auto: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self { vault_path: None, sync_auto: true }
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
        let cfg = AppConfig { vault_path: Some("/tmp/vault".into()), sync_auto: false };
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
}
