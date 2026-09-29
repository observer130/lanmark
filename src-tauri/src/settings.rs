//! M4a 设置：设备级偏好的数据结构与归一化（纯逻辑，可单测）。
//!
//! 存哪：`app_config_dir/config.json` 的 `AppConfig` 内嵌小节（见 `vault.rs`）。
//! 为什么不放 vault 内 `.lanmark/settings.json`：字体是**设备**偏好，换库不该变；
//! 且 `.lanmark/` 不参与同步，放 vault 里会让设置进入同步清单判定（docs/08 §4.1）。
//! 分界规则：设备/用户偏好 → `AppConfig`；vault 级视图状态 → localStorage；笔记内容 → 文件。
//!
//! 本模块只做「结构 + 归一化」，不碰 tauri::AppHandle（命令封装在 `commands.rs`）。
//! 归一化的意义：前端以 `settings_patch` 的**返回值**为准，非法值一律回退默认，
//! 因此手改 config.json / 跨版本残留 / 恶意串都不会让界面变成畸形排版。

use serde::{Deserialize, Serialize};

/// 字号 / 行距的合法枚举。
const SIZE_KEYS: [&str; 4] = ["sm", "md", "lg", "xl"];
const LINE_HEIGHT_KEYS: [&str; 3] = ["compact", "normal", "relaxed"];
const EDITOR_MODE_KEYS: [&str; 3] = ["read", "wysiwyg", "source"];
const NEW_NOTE_LOCATION_KEYS: [&str; 2] = ["root", "last"];
/// 自动保存延迟档位（ms）：仅改防抖时长，不改尾沿纪律（docs/08 §3.2 B2）。
const AUTOSAVE_KEYS: [u32; 4] = [300, 700, 1500, 3000];

// ---------- 数据结构 ----------

/// M5 减法说明：M4a 曾有字体（界面/正文/等宽/自定义）、源码字号、正文宽度、
/// 界面缩放等字段。移除后旧 config.json 里的残留字段由 serde 静默忽略
/// （无 deny_unknown_fields），下次保存自然清除，无需迁移代码。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    /// 正文字号档位；`md` = 16px（与既往硬编码一致 ⇒ 默认视觉不变）
    pub text_size: String,
    /// 行距档位；`normal` = 1.75
    pub line_height: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorPrefs {
    /// 打开笔记 / 新建后的编辑器模式初值（既往硬编码 `wysiwyg`）
    pub default_mode: String,
    /// 自动保存防抖时长 ms
    pub autosave_ms: u32,
    /// 源码模式是否显示行号
    pub source_line_numbers: bool,
    /// 新建笔记的默认位置：`root` 固定根目录 / `last` 上次所在目录（前端会话内，不落库）
    pub new_note_location: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StoragePrefs {
    /// 回收站保留天数；`0` = 从不清理
    pub trash_retention_days: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            text_size: "md".into(),
            line_height: "normal".into(),
        }
    }
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            default_mode: "wysiwyg".into(),
            autosave_ms: 700,
            source_line_numbers: true,
            new_note_location: "root".into(),
        }
    }
}

impl Default for StoragePrefs {
    fn default() -> Self {
        // 30 天：与 tombstone TTL 数值巧合但**语义无关**（docs/08 §3.3 注）
        Self { trash_retention_days: 30 }
    }
}

/// 设置全量（`settings_get` / `settings_patch` / `settings_reset` 的返回体）。
/// 不含 `vaultPath` / `syncAuto`：这两项各有既有命令，避免同一字段两个写入口。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub appearance: Appearance,
    pub editor: EditorPrefs,
    pub storage: StoragePrefs,
}

/// patch 入参：**传入即整体替换该小节**（缺省 = 该小节不动）。
/// 整节替换让「清除自定义字体」= 传空串，前端持有完整对象，天然表达意图。
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub appearance: Option<Appearance>,
    pub editor: Option<EditorPrefs>,
    pub storage: Option<StoragePrefs>,
}

// ---------- 归一化 ----------

/// `key` 合法则保留，否则回退 `fallback`。
fn pick(key: &str, allowed: &[&str], fallback: &str) -> String {
    if allowed.contains(&key) {
        key.to_string()
    } else {
        fallback.to_string()
    }
}

impl Appearance {
    /// 逐字段归一化；返回值即前端应采用的最终值。
    /// 字体相关的白名单校验（`sanitize_font_stack`）随字体设置一并移除：
    /// 字体栈现在常驻 index.css，用户输入不再进入 CSS 变量。
    pub fn normalize(mut self) -> Self {
        self.text_size = pick(&self.text_size, &SIZE_KEYS, "md");
        self.line_height = pick(&self.line_height, &LINE_HEIGHT_KEYS, "normal");
        self
    }
}

impl EditorPrefs {
    pub fn normalize(mut self) -> Self {
        self.default_mode = pick(&self.default_mode, &EDITOR_MODE_KEYS, "wysiwyg");
        if !AUTOSAVE_KEYS.contains(&self.autosave_ms) {
            self.autosave_ms = 700;
        }
        self.new_note_location = pick(&self.new_note_location, &NEW_NOTE_LOCATION_KEYS, "root");
        self
    }
}

impl StoragePrefs {
    /// 保留天数上限 3650（10 年）：再大等于「从不」，但 `0` 才是显式的「从不」，
    /// 避免超大数值被前端展示成无意义的数字。
    pub fn normalize(mut self) -> Self {
        if self.trash_retention_days > 3650 {
            self.trash_retention_days = 3650;
        }
        self
    }
}

impl Settings {
    /// 应用 patch：传入的小节整体替换（并归一化），未传的保持原值。
    pub fn apply(self, patch: SettingsPatch) -> Self {
        Self {
            appearance: patch.appearance.unwrap_or(self.appearance).normalize(),
            editor: patch.editor.unwrap_or(self.editor).normalize(),
            storage: patch.storage.unwrap_or(self.storage).normalize(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_previous_hardcoded_visuals() {
        // 默认值必须与 M3 的硬编码等价，否则升级用户界面会突变（docs/08 §3 表头）
        let a = Appearance::default();
        assert_eq!(a.text_size, "md"); // 16px
        assert_eq!(a.line_height, "normal"); // 1.75
        let e = EditorPrefs::default();
        assert_eq!(e.default_mode, "wysiwyg");
        assert_eq!(e.autosave_ms, 700); // 原 SAVE_DEBOUNCE_MS
        assert!(e.source_line_numbers);
        assert_eq!(e.new_note_location, "root");
        assert_eq!(StoragePrefs::default().trash_retention_days, 30);
    }

    #[test]
    fn normalize_falls_back_on_illegal_enums() {
        let a = Appearance {
            text_size: "huge".into(),
            line_height: "loose".into(),
        }
        .normalize();
        assert_eq!(a.text_size, "md");
        assert_eq!(a.line_height, "normal");

        let e = EditorPrefs {
            default_mode: "edit".into(),
            autosave_ms: 42,
            new_note_location: "somewhere".into(),
            ..EditorPrefs::default()
        }
        .normalize();
        assert_eq!(e.default_mode, "wysiwyg");
        assert_eq!(e.autosave_ms, 700);
        assert_eq!(e.new_note_location, "root");
    }

    #[test]
    fn normalize_keeps_legal_enums() {
        for k in SIZE_KEYS {
            assert_eq!(pick(k, &SIZE_KEYS, "md"), k);
        }
        for k in LINE_HEIGHT_KEYS {
            assert_eq!(pick(k, &LINE_HEIGHT_KEYS, "normal"), k);
        }
        for ms in AUTOSAVE_KEYS {
            let e = EditorPrefs { autosave_ms: ms, ..EditorPrefs::default() }.normalize();
            assert_eq!(e.autosave_ms, ms);
        }
    }

    #[test]
    fn patch_replaces_only_named_section_and_normalizes() {
        let base = Settings::default();
        let patched = base.clone().apply(SettingsPatch {
            appearance: Some(Appearance { text_size: "xl".into(), ..Appearance::default() }),
            ..Default::default()
        });
        assert_eq!(patched.appearance.text_size, "xl");
        // 未传的小节保持原值
        assert_eq!(patched.editor, base.editor);
        assert_eq!(patched.storage, base.storage);

        // 传入小节内的非法值也在同一步归一化
        let patched = base.apply(SettingsPatch {
            editor: Some(EditorPrefs { autosave_ms: 1, ..EditorPrefs::default() }),
            ..Default::default()
        });
        assert_eq!(patched.editor.autosave_ms, 700);
    }

    #[test]
    fn trash_retention_clamped() {
        let s = StoragePrefs { trash_retention_days: 0 }.normalize();
        assert_eq!(s.trash_retention_days, 0, "0 = 从不，是合法值");
        let s = StoragePrefs { trash_retention_days: 100_000 }.normalize();
        assert_eq!(s.trash_retention_days, 3650);
    }

    #[test]
    fn settings_serde_roundtrip_is_camel_case() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"textSize\""), "前端按 camelCase 读: {json}");
        assert!(json.contains("\"trashRetentionDays\""));
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn settings_tolerate_partial_and_legacy_json() {
        // 只有部分字段的 config.json（跨版本残留 / 手改）→ 其余取默认
        let legacy = r#"{"appearance":{"textSize":"lg"}}"#;
        let s: Settings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.appearance.text_size, "lg");
        assert_eq!(s.appearance.line_height, "normal");
        assert_eq!(s.editor.autosave_ms, 700);
        // 完全空对象
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
        // M5 减法迁移：旧版外观字段（字体/源码字号/行宽/界面缩放）被静默忽略
        let m5_legacy = r#"{"appearance":{"uiFont":"serif","textFont":"custom",
            "customFonts":{"ui":"Fira Sans","text":"","mono":""},"textSize":"lg",
            "codeSize":"sm","contentWidth":"limited","uiScalePct":125}}"#;
        let s: Settings = serde_json::from_str(m5_legacy).unwrap();
        assert_eq!(s.appearance.text_size, "lg", "仍可识别的字段照常读取");
        assert_eq!(s.appearance.line_height, "normal");
        assert_eq!(s, Settings { appearance: Appearance { text_size: "lg".into(), line_height: "normal".into() }, ..Settings::default() });
    }
}
