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

/// M6 主题 key（docs/09 §6）：晨窗 / 夜航 / 纸页 / 文楷。
/// `morning` 即 M3 以来的硬编码视觉 ⇒ 作默认值，升级用户界面不突变。
const THEME_KEYS: [&str; 4] = ["morning", "night", "paper", "wenkai"];
/// 字号 / 行距的合法枚举。
const SIZE_KEYS: [&str; 4] = ["sm", "md", "lg", "xl"];
const LINE_HEIGHT_KEYS: [&str; 3] = ["compact", "normal", "relaxed"];
const EDITOR_MODE_KEYS: [&str; 3] = ["read", "wysiwyg", "source"];
const NEW_NOTE_LOCATION_KEYS: [&str; 2] = ["root", "last"];
/// 自动保存延迟档位（ms）：仅改防抖时长，不改尾沿纪律（docs/08 §3.2 B2）。
/// M5-3 整体调大（原 0.3/0.7/1.5/3s）；旧值归一到最近档（见 `nearest_autosave`）。
const AUTOSAVE_KEYS: [u32; 4] = [1500, 3000, 10_000, 20_000];

// ---------- 数据结构 ----------

/// M5 减法说明：M4a 曾有字体（界面/正文/等宽/自定义）、源码字号、正文宽度、
/// 界面缩放等字段。移除后旧 config.json 里的残留字段由 serde 静默忽略
/// （无 deny_unknown_fields），下次保存自然清除，无需迁移代码。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    /// M6 主题 key；前端据此写 `<html data-theme>`（配色 + 编辑区字体，docs/09 §6）
    pub theme: String,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatePrefs {
    /// 启动时自动检查更新（≥24h 节流；时间戳在 AppConfig.last_update_check_ms）
    pub auto_check: bool,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        Self { auto_check: true }
    }
}

impl UpdatePrefs {
    /// 布尔开关无非法值；归一化占位保持三小节同构
    pub fn normalize(self) -> Self {
        self
    }
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "morning".into(),
            text_size: "md".into(),
            line_height: "normal".into(),
        }
    }
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            default_mode: "wysiwyg".into(),
            // M5-3：默认 3s（原 700ms；档位整体调大，用户仍可选手动档）
            autosave_ms: 3000,
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
    /// M5-4：更新检测偏好（检测本体在 `update.rs`）
    pub update: UpdatePrefs,
}

/// patch 入参：**传入即整体替换该小节**（缺省 = 该小节不动）。
/// 整节替换让「清除自定义字体」= 传空串，前端持有完整对象，天然表达意图。
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub appearance: Option<Appearance>,
    pub editor: Option<EditorPrefs>,
    pub storage: Option<StoragePrefs>,
    pub update: Option<UpdatePrefs>,
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
        self.theme = pick(&self.theme, &THEME_KEYS, "morning");
        self.text_size = pick(&self.text_size, &SIZE_KEYS, "md");
        self.line_height = pick(&self.line_height, &LINE_HEIGHT_KEYS, "normal");
        self
    }
}

/// 自动保存延迟归一到**最近档**（M5-3）：存量用户的 0.3/0.7s 档归到 1.5s，
/// 而不是一律回默认 3s——保留「用户选了快档」的意图。并列距离取先出现的档。
fn nearest_autosave(ms: u32) -> u32 {
    let mut best = AUTOSAVE_KEYS[0];
    for &k in &AUTOSAVE_KEYS {
        if (i64::from(ms) - i64::from(k)).abs() < (i64::from(ms) - i64::from(best)).abs() {
            best = k;
        }
    }
    best
}

impl EditorPrefs {
    pub fn normalize(mut self) -> Self {
        self.default_mode = pick(&self.default_mode, &EDITOR_MODE_KEYS, "wysiwyg");
        self.autosave_ms = nearest_autosave(self.autosave_ms);
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
            update: patch.update.unwrap_or(self.update).normalize(),
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
        assert_eq!(a.theme, "morning", "M6：默认主题 = 现状晨窗，升级不突变");
        assert_eq!(a.text_size, "md"); // 16px
        assert_eq!(a.line_height, "normal"); // 1.75
        let e = EditorPrefs::default();
        assert_eq!(e.default_mode, "wysiwyg");
        assert_eq!(e.autosave_ms, 3000); // M5-3 默认档（原 SAVE_DEBOUNCE_MS 700）
        assert!(e.source_line_numbers);
        assert_eq!(e.new_note_location, "root");
        assert_eq!(StoragePrefs::default().trash_retention_days, 30);
    }

    #[test]
    fn normalize_falls_back_on_illegal_enums() {
        let a = Appearance {
            theme: "neon".into(),
            text_size: "huge".into(),
            line_height: "loose".into(),
        }
        .normalize();
        assert_eq!(a.theme, "morning", "非法主题回退默认");
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
        assert_eq!(e.autosave_ms, 1500, "非法值归到最近档（不再按默认回退）");
        assert_eq!(e.new_note_location, "root");
    }

    #[test]
    fn autosave_maps_to_nearest_gear() {
        // M5-3：旧档位与任意值都归到最近档，保留「选了快档」的意图
        assert_eq!(nearest_autosave(300), 1500);
        assert_eq!(nearest_autosave(700), 1500);
        assert_eq!(nearest_autosave(1200), 1500);
        assert_eq!(nearest_autosave(3000), 3000, "档位值原样保留");
        assert_eq!(nearest_autosave(4000), 3000);
        assert_eq!(nearest_autosave(15_000), 10_000);
        assert_eq!(nearest_autosave(25_000), 20_000);
        assert_eq!(nearest_autosave(0), 1500);
    }

    #[test]
    fn normalize_keeps_legal_enums() {
        for k in THEME_KEYS {
            assert_eq!(pick(k, &THEME_KEYS, "morning"), k);
        }
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
        assert_eq!(patched.editor.autosave_ms, 1500);
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
        assert!(json.contains("\"theme\""), "M6 主题字段进 JSON: {json}");
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
        assert_eq!(s.appearance.theme, "morning", "M6：老配置无 theme 字段 ⇒ 默认晨窗");
        assert_eq!(s.appearance.line_height, "normal");
        assert_eq!(s.editor.autosave_ms, 3000);
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
        assert_eq!(s, Settings { appearance: Appearance { theme: "morning".into(), text_size: "lg".into(), line_height: "normal".into() }, ..Settings::default() });
    }
}
