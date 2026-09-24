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

/// 字体方案的合法枚举；`custom` 表示用 `custom_fonts` 里的用户串。
const FONT_KEYS_UI: [&str; 4] = ["system", "sans", "serif", "custom"];
const FONT_KEYS_MONO: [&str; 3] = ["system", "mono", "custom"];
/// 字号 / 行距 / 行宽的合法枚举。
const SIZE_KEYS: [&str; 4] = ["sm", "md", "lg", "xl"];
const LINE_HEIGHT_KEYS: [&str; 3] = ["compact", "normal", "relaxed"];
const CONTENT_WIDTH_KEYS: [&str; 2] = ["auto", "limited"];
const EDITOR_MODE_KEYS: [&str; 3] = ["read", "wysiwyg", "source"];
const NEW_NOTE_LOCATION_KEYS: [&str; 2] = ["root", "last"];
/// 自动保存延迟档位（ms）：仅改防抖时长，不改尾沿纪律（docs/08 §3.2 B2）。
const AUTOSAVE_KEYS: [u32; 4] = [300, 700, 1500, 3000];
/// 界面缩放的合法枚举（P2，docs/08 §3.1 A8）。
const UI_SCALE_KEYS: [u16; 3] = [100, 112, 125];

/// 自定义字体串最长 200 字符：够放一个完整字体栈，又不给畸形串留空间。
const CUSTOM_FONT_MAX: usize = 200;

// ---------- 数据结构 ----------

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Appearance {
    pub ui_font: String,
    pub text_font: String,
    pub mono_font: String,
    pub custom_fonts: CustomFonts,
    /// 正文字号档位；`md` = 16px（与既往硬编码一致 ⇒ 默认视觉不变）
    pub text_size: String,
    /// 源码字号档位；`md` = 14px（既往 13.5px 取整）
    pub code_size: String,
    pub line_height: String,
    pub content_width: String,
    pub ui_scale_pct: u16,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomFonts {
    /// 空串 = 未设置（用空串而非 Option：整节替换即可表达「清除自定义字体」，
    /// 避开 `Option<Option<T>>` 三态，见 docs/08 §4.3）
    pub ui: String,
    pub text: String,
    pub mono: String,
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
            ui_font: "system".into(),
            text_font: "sans".into(),
            mono_font: "system".into(),
            custom_fonts: CustomFonts::default(),
            text_size: "md".into(),
            code_size: "md".into(),
            line_height: "normal".into(),
            content_width: "auto".into(),
            ui_scale_pct: 100,
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

/// 自定义字体串白名单校验：允许字母数字、空格与 `, - _ " ' ( )`，长度 ≤200。
///
/// **安全要点**：该串由 `applyCssVars` 写进 `:root` 的 CSS 变量（`setProperty`）。
/// 未过滤可构造声明注入（如 `x; --c-ink: red`），进而篡改全站配色甚至布局。
/// 这里拒绝一切控制/结构性字符（`;{}<>@!\/` 等），非法即回退 `system`。
pub fn sanitize_font_stack(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None; // 空串 = 清除自定义
    }
    if s.chars().count() > CUSTOM_FONT_MAX {
        return None;
    }
    let ok = s.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, ' ' | ',' | '-' | '_' | '"' | '\'' | '(' | ')')
            // 中文字体名（如 "思源宋体"）需放行；注入字符全是 ASCII，不冲突
            || (!c.is_ascii() && !c.is_control())
    });
    if !ok {
        return None;
    }
    Some(s.to_string())
}

/// 归一化单个字体字段：合法枚举保留；`custom` 需自定义串通过白名单，
/// 否则回退（UI/正文回退 `system`，等宽回退 `system`）。
fn norm_font(key: &str, custom: &str, allowed: &[&str]) -> String {
    let k = pick(key, allowed, "system");
    if k != "custom" {
        return k;
    }
    if sanitize_font_stack(custom).is_some() {
        "custom".to_string()
    } else {
        "system".to_string()
    }
}

impl Appearance {
    /// 逐字段归一化；返回值即前端应采用的最终值。
    pub fn normalize(mut self) -> Self {
        self.custom_fonts = CustomFonts {
            ui: sanitize_font_stack(&self.custom_fonts.ui).unwrap_or_default(),
            text: sanitize_font_stack(&self.custom_fonts.text).unwrap_or_default(),
            mono: sanitize_font_stack(&self.custom_fonts.mono).unwrap_or_default(),
        };
        self.ui_font = norm_font(&self.ui_font, &self.custom_fonts.ui, &FONT_KEYS_UI);
        self.text_font = norm_font(&self.text_font, &self.custom_fonts.text, &FONT_KEYS_UI);
        self.mono_font = norm_font(&self.mono_font, &self.custom_fonts.mono, &FONT_KEYS_MONO);
        self.text_size = pick(&self.text_size, &SIZE_KEYS, "md");
        self.code_size = pick(&self.code_size, &SIZE_KEYS, "md");
        self.line_height = pick(&self.line_height, &LINE_HEIGHT_KEYS, "normal");
        self.content_width = pick(&self.content_width, &CONTENT_WIDTH_KEYS, "auto");
        if !UI_SCALE_KEYS.contains(&self.ui_scale_pct) {
            self.ui_scale_pct = 100;
        }
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
        assert_eq!(a.ui_font, "system");
        assert_eq!(a.text_font, "sans");
        assert_eq!(a.text_size, "md"); // 16px
        assert_eq!(a.code_size, "md"); // 14px
        assert_eq!(a.line_height, "normal"); // 1.75
        assert_eq!(a.content_width, "auto");
        assert_eq!(a.ui_scale_pct, 100);
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
            ui_font: "comic".into(),
            text_font: "comic".into(),
            mono_font: "comic".into(),
            text_size: "huge".into(),
            code_size: "".into(),
            line_height: "loose".into(),
            content_width: "wide".into(),
            ui_scale_pct: 999,
            ..Appearance::default()
        }
        .normalize();
        assert_eq!(a.ui_font, "system");
        assert_eq!(a.text_font, "system");
        assert_eq!(a.mono_font, "system");
        assert_eq!(a.text_size, "md");
        assert_eq!(a.code_size, "md");
        assert_eq!(a.line_height, "normal");
        assert_eq!(a.content_width, "auto");
        assert_eq!(a.ui_scale_pct, 100);

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
        for pct in UI_SCALE_KEYS {
            let a = Appearance { ui_scale_pct: pct, ..Appearance::default() }.normalize();
            assert_eq!(a.ui_scale_pct, pct);
        }
    }

    #[test]
    fn font_stack_whitelist_rejects_injection() {
        // CSS 声明注入：能写进分号就能篡改 :root 其它变量
        assert!(sanitize_font_stack("x; --c-ink: red").is_none());
        assert!(sanitize_font_stack("x} .a{display:none").is_none());
        assert!(sanitize_font_stack("url(/etc/passwd)").is_none());
        assert!(sanitize_font_stack("<script>").is_none());
        assert!(sanitize_font_stack("@import 'x'").is_none());
        assert!(sanitize_font_stack("a\\b").is_none());
        assert!(sanitize_font_stack("a!important").is_none());
        // 长度上限
        assert!(sanitize_font_stack(&"a".repeat(CUSTOM_FONT_MAX + 1)).is_none());
        assert_eq!(sanitize_font_stack(&"a".repeat(CUSTOM_FONT_MAX)).unwrap().len(), CUSTOM_FONT_MAX);
        // 空串 = 清除自定义，不是合法栈
        assert!(sanitize_font_stack("").is_none());
        assert!(sanitize_font_stack("   ").is_none());
        // 正常栈放行（含引号、逗号、连字符、括号与中文字体名）
        let ok = r#""Noto Serif CJK SC", "思源宋体", Songti SC, serif"#;
        assert_eq!(sanitize_font_stack(ok).unwrap(), ok);
        assert!(sanitize_font_stack("Fira Code, ui-monospace").is_some());
    }

    #[test]
    fn custom_font_requires_valid_stack() {
        let a = Appearance {
            ui_font: "custom".into(),
            custom_fonts: CustomFonts { ui: "x; --c-ink: red".into(), ..Default::default() },
            ..Appearance::default()
        }
        .normalize();
        // 非法串 → 枚举本身被回退，且串被清空（不留死数据在 config 里）
        assert_eq!(a.ui_font, "system");
        assert_eq!(a.custom_fonts.ui, "");

        let a = Appearance {
            ui_font: "custom".into(),
            custom_fonts: CustomFonts { ui: "Fira Sans".into(), ..Default::default() },
            ..Appearance::default()
        }
        .normalize();
        assert_eq!(a.ui_font, "custom");
        assert_eq!(a.custom_fonts.ui, "Fira Sans");
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
    }
}
