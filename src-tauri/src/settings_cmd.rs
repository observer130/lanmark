//! M4a 设置命令层：`settings_get` / `settings_patch` / `settings_reset`。
//!
//! 写盘纪律（沿用 `vault_set_sync_auto`）：`load_config` → 改目标字段 → `save_config`
//! （tmp+rename 原子写）；**绝不整体覆盖 `vault_path`**，也绝不把设置写进 vault。
//! 纯逻辑与命令分离：`*_op` 收 `&mut AppConfig`，可脱离 tauri AppHandle 单测。

use crate::commands::CmdResult;
use crate::settings::{Settings, SettingsPatch};
use crate::vault::{self, AppConfig};

/// 纯逻辑：读设置（不做归一化——落盘值已由 patch 归一化；此处保留原样，
/// 归一化只在写入路径发生，保证「读到的 = 盘上的」）。
pub fn settings_read_op(cfg: &AppConfig) -> Settings {
    cfg.settings()
}

/// 纯逻辑：应用 patch 到配置（原地改三小节，不动 vault_path / sync_auto）。
pub fn settings_apply_op(cfg: &mut AppConfig, patch: SettingsPatch) -> Settings {
    let cur = cfg.settings();
    let next = cur.apply(patch);
    cfg.appearance = next.appearance.clone();
    cfg.editor = next.editor.clone();
    cfg.storage = next.storage.clone();
    next
}

/// 纯逻辑：恢复默认设置，**保留 `vault_path` 与 `sync_auto`**（docs/08 §3.5 E4）。
/// 已配对设备不在 AppConfig 里（`sync-servers.json`），天然不受影响。
pub fn settings_reset_op(cfg: &mut AppConfig) -> Settings {
    let path = cfg.vault_path.clone();
    let sync_auto = cfg.sync_auto;
    *cfg = AppConfig { vault_path: path, sync_auto, ..AppConfig::default() };
    cfg.settings()
}

/// 读设置。**不依赖 vault**：未配置笔记库时设置页也要能用（docs/08 §4.3）。
#[tauri::command]
pub fn settings_get(app: tauri::AppHandle) -> CmdResult<Settings> {
    Ok(settings_read_op(&vault::load_config(&app)))
}

/// 改设置：传入的小节整体替换，逐字段归一化后落盘，**返回归一化结果**
/// （前端以返回值为准——非法字体串会被这里回退成 `system`）。
#[tauri::command]
pub fn settings_patch(app: tauri::AppHandle, patch: SettingsPatch) -> CmdResult<Settings> {
    let mut cfg = vault::load_config(&app);
    let next = settings_apply_op(&mut cfg, patch);
    vault::save_config(&app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(next)
}

/// 恢复默认设置（保留 vault_path / sync_auto）。
#[tauri::command]
pub fn settings_reset(app: tauri::AppHandle) -> CmdResult<Settings> {
    let mut cfg = vault::load_config(&app);
    let next = settings_reset_op(&mut cfg);
    vault::save_config(&app, &cfg).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Appearance, EditorPrefs, StoragePrefs};

    #[test]
    fn patch_touches_only_target_section() {
        let mut cfg = AppConfig::default();
        let before_editor = cfg.editor.clone();
        let before_storage = cfg.storage.clone();
        let out = settings_apply_op(
            &mut cfg,
            SettingsPatch {
                appearance: Some(Appearance { text_size: "xl".into(), ..Appearance::default() }),
                ..Default::default()
            },
        );
        assert_eq!(out.appearance.text_size, "xl");
        assert_eq!(cfg.appearance.text_size, "xl", "落进了配置");
        assert_eq!(cfg.editor, before_editor, "未传的小节不动");
        assert_eq!(cfg.storage, before_storage);
    }

    /// 最高风险回归：改设置绝不能覆盖 vault_path / sync_auto。
    #[test]
    fn patch_never_clobbers_vault_path_or_sync_auto() {
        let mut cfg = AppConfig {
            vault_path: Some("/home/u/notes".into()),
            sync_auto: false,
            ..AppConfig::default()
        };
        settings_apply_op(
            &mut cfg,
            SettingsPatch {
                appearance: Some(Appearance::default()),
                editor: Some(EditorPrefs { autosave_ms: 1500, ..EditorPrefs::default() }),
                storage: Some(StoragePrefs { trash_retention_days: 7 }),
            },
        );
        assert_eq!(cfg.vault_path.as_deref(), Some("/home/u/notes"));
        assert!(!cfg.sync_auto);
        assert_eq!(cfg.editor.autosave_ms, 1500);
        assert_eq!(cfg.storage.trash_retention_days, 7);
    }

    #[test]
    fn patch_returns_normalized_values() {
        let mut cfg = AppConfig::default();
        // 非法字体串：命令返回值必须是归一化后的 system（前端据此提示并回退）
        let out = settings_apply_op(
            &mut cfg,
            SettingsPatch {
                appearance: Some(Appearance {
                    ui_font: "custom".into(),
                    custom_fonts: crate::settings::CustomFonts {
                        ui: "x; --c-ink: red".into(),
                        ..Default::default()
                    },
                    ..Appearance::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(out.appearance.ui_font, "system");
        assert_eq!(out.appearance.custom_fonts.ui, "");
        assert_eq!(cfg.appearance.ui_font, "system", "落盘也是归一化后的值");
    }

    #[test]
    fn reset_keeps_vault_path_and_sync_auto() {
        let mut cfg = AppConfig {
            vault_path: Some("/home/u/notes".into()),
            sync_auto: false,
            appearance: Appearance { text_size: "xl".into(), ui_font: "serif".into(), ..Appearance::default() },
            editor: EditorPrefs { autosave_ms: 3000, ..EditorPrefs::default() },
            storage: StoragePrefs { trash_retention_days: 0 },
        };
        let out = settings_reset_op(&mut cfg);
        assert_eq!(out, Settings::default(), "设置回到默认");
        assert_eq!(cfg.vault_path.as_deref(), Some("/home/u/notes"), "换库配置不能丢");
        assert!(!cfg.sync_auto, "同步开关是 D1 独立项，恢复默认设置不动它");
    }

    #[test]
    fn read_is_pure_and_dependency_free() {
        // settings_read_op 不依赖 vault：空配置也能读
        let cfg = AppConfig::default();
        assert_eq!(settings_read_op(&cfg), Settings::default());
    }
}
