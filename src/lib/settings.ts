import { invoke } from "@tauri-apps/api/core";

/**
 * M4a 设置：设备级偏好（字号/行距/编辑器）的前端封装。
 *
 * 存哪：`app_config_dir/config.json`（Rust `AppConfig`），**不在 vault 内、不在 localStorage**。
 * 理由见 docs/08 §4.1：外观是设备偏好，换库不该变；localStorage 会被 Android WebView
 * 清理且不可测。vault 级视图状态（折叠目录）继续留在 localStorage。
 *
 * 与 Rust 的对应关系：Rust 只存枚举 key，**枚举→像素值全在本文件**（单一来源），
 * Rust 侧不重复一份 CSS 知识。
 *
 * M5 减法：界面字体、自定义字体串、源码字号、正文宽度、界面缩放已移除；
 * 界面壳字体栈常驻 `index.css` 的 `--font-sans`。**M7 只恢复「编辑区正文/标题字体」
 * 三档**（`--lanmark-font-text` 的固定栈，不接受用户输入串），自定义字体仍不做。
 *
 * M6 主题 → M7 解耦：外观拆成 `scheme`（浅色/深色/纸页）与 `font`（默认/宋体/楷体）
 * 两个独立枚举，分别写成 `<html data-scheme>` / `<html data-font>`。色值与字体栈全在
 * `index.css` 的 `:root[data-scheme=…]` / `:root[data-font=…]` 块里（`applyScheme` /
 * `applyFont`）——JS 对「长什么样」零知识，只负责搬 key。
 */

/* ── 枚举 ── */

export type SizeKey = "sm" | "md" | "lg" | "xl";
export type LineHeightKey = "compact" | "normal" | "relaxed";
export type EditorMode = "read" | "wysiwyg" | "source";
export type NewNoteLocation = "root" | "last";
/** M7 配色 key（与 Rust `SCHEME_KEYS` 同序同值）——只决定颜色 token */
export type ColorSchemeKey = "light" | "dark" | "paper";
/** M7 编辑区字体 key（与 Rust `FONT_KEYS` 同序同值）——只决定 `--lanmark-font-text` */
export type FontKey = "sans" | "serif" | "kai";

export interface Appearance {
  scheme: ColorSchemeKey;
  font: FontKey;
  textSize: SizeKey;
  lineHeight: LineHeightKey;
}

export interface EditorPrefs {
  defaultMode: EditorMode;
  autosaveMs: number;
  sourceLineNumbers: boolean;
  newNoteLocation: NewNoteLocation;
}

export interface StoragePrefs {
  /** 0 = 从不清理 */
  trashRetentionDays: number;
}

export interface UpdatePrefs {
  /** 启动时自动检查更新（≥24h 节流；时间戳在 Rust AppConfig.last_update_check_ms） */
  autoCheck: boolean;
}

export interface Settings {
  appearance: Appearance;
  editor: EditorPrefs;
  storage: StoragePrefs;
  update: UpdatePrefs;
}

/** patch 入参：传入的小节**整体替换**，未传的保持原值 */
export interface SettingsPatch {
  appearance?: Appearance;
  editor?: EditorPrefs;
  storage?: StoragePrefs;
  update?: UpdatePrefs;
}

/* ── 枚举 → 数值（四档，docs/08 §3.1） ── */

const TEXT_PX: Record<SizeKey, number> = { sm: 14, md: 16, lg: 18, xl: 20 };
const LINE_HEIGHT: Record<LineHeightKey, number> = {
  compact: 1.55,
  normal: 1.75,
  relaxed: 2.0,
};

export const textSizePx = (k: SizeKey): number => TEXT_PX[k] ?? TEXT_PX.md;
export const lineHeightValue = (k: LineHeightKey): number => LINE_HEIGHT[k] ?? LINE_HEIGHT.normal;

/* ── UI 档位标签（设置页分段按钮用） ── */

export const SIZE_OPTIONS: { key: SizeKey; label: string }[] = [
  { key: "sm", label: "小" },
  { key: "md", label: "中" },
  { key: "lg", label: "大" },
  { key: "xl", label: "特大" },
];

/** 配色清单（设置页分段按钮用）；色值只在 index.css 的 `[data-scheme]` 块 */
export const SCHEME_OPTIONS: { key: ColorSchemeKey; label: string }[] = [
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
  { key: "paper", label: "纸页" },
];

/** 编辑区字体清单；字体栈只在 index.css 的 `[data-font]` 块（界面壳不随动，D3） */
export const FONT_OPTIONS: { key: FontKey; label: string }[] = [
  { key: "sans", label: "默认" },
  { key: "serif", label: "宋体" },
  { key: "kai", label: "楷体" },
];

export const LINE_HEIGHT_OPTIONS: { key: LineHeightKey; label: string }[] = [
  { key: "compact", label: "紧凑" },
  { key: "normal", label: "标准" },
  { key: "relaxed", label: "宽松" },
];

/** 自动保存延迟档位（M5-3 整体调大：原 0.3/0.7/1.5/3s；旧值由 Rust 归一到最近档） */
export const AUTOSAVE_OPTIONS: { key: number; label: string }[] = [
  { key: 1500, label: "1.5 秒" },
  { key: 3000, label: "3 秒" },
  { key: 10000, label: "10 秒" },
  { key: 20000, label: "20 秒" },
];

export const EDITOR_MODE_OPTIONS: { key: EditorMode; label: string }[] = [
  { key: "read", label: "阅读" },
  { key: "wysiwyg", label: "所见即所得" },
  { key: "source", label: "源码" },
];

export const NEW_NOTE_LOCATION_OPTIONS: { key: NewNoteLocation; label: string }[] = [
  { key: "root", label: "根目录" },
  { key: "last", label: "上次所在目录" },
];

/** 回收站保留策略档位（`0` = 从不） */
export const TRASH_RETENTION_OPTIONS: { key: number; label: string }[] = [
  { key: 7, label: "7 天" },
  { key: 30, label: "30 天" },
  { key: 90, label: "90 天" },
  { key: 0, label: "从不" },
];

/* ── 外观写入（applyCssVars / applyScheme / applyFont 是仅有的三个写入点） ── */

/**
 * 把外观设置写进 `:root` 的 CSS 变量（M5 减法后只剩字号/行距两项）。
 *
 * **为什么走变量**：改字号绝不能重建编辑器实例——Crepe 建实例会发一次伪
 * `markdownUpdated`，若因此重跑就可能「改个字号把笔记重写一遍」（硬约定 3）。
 * 变量只影响渲染，`MilkdownHost` 的 key 不受影响（见 `editorKey`）。
 */
export function applyCssVars(a: Appearance, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  const set = (k: string, v: string) => el.style.setProperty(k, v);
  set("--lanmark-text-size", `${textSizePx(a.textSize)}px`);
  set("--lanmark-line-height", String(lineHeightValue(a.lineHeight)));
}

/**
 * M7 配色：把 key 写成 `<html data-scheme="…">`，其余全交给 `index.css` 的
 * `:root[data-scheme=…]` 变量块传导。
 *
 * **为什么不用 style.setProperty 逐个写色值**：那等于把设计 token 复制进 JS，
 * 与「色值只在 CSS、枚举映射只在 TS」的分工相悖（docs/09 §4.1）；改配色是一个
 * DOM 属性写入，同样不重建编辑器实例（硬约定 11）。
 * 非法 key 的兜底在 Rust 归一化（`settings_patch` 返回值为准）+ TS 类型约束。
 */
export function applyScheme(scheme: ColorSchemeKey, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  if (SCHEME_OPTIONS.some((o) => o.key === scheme)) {
    el.dataset.scheme = scheme;
    writeAppearanceCache(SCHEME_CACHE_KEY, scheme);
  } else {
    // 运行时脏值（手改 config / 未来版本回退）不写属性 ⇒ 落在 :root 浅色默认
    delete el.dataset.scheme;
    writeAppearanceCache(SCHEME_CACHE_KEY, null);
  }
}

/**
 * M7 编辑区字体：把 key 写成 `<html data-font="…">`，字体栈由 `index.css` 的
 * `:root[data-font=…]` 块给出（`sans` 无块 = `:root` 的内置 MiSans）。
 *
 * 与配色同理：只写属性不写字体串，也不重建编辑器实例（硬约定 11）；
 * 界面壳 `--font-sans` 不随这个属性变（字体只作用于编辑区，M5 D3 边界）。
 */
export function applyFont(font: FontKey, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  if (FONT_OPTIONS.some((o) => o.key === font)) {
    el.dataset.font = font;
    writeAppearanceCache(FONT_CACHE_KEY, font);
  } else {
    delete el.dataset.font;
    writeAppearanceCache(FONT_CACHE_KEY, null);
  }
}

/** 首帧启动缓存的 key（`index.html` 内联脚本按此读取，两处必须一致） */
export const SCHEME_CACHE_KEY = "lanmark-scheme";
export const FONT_CACHE_KEY = "lanmark-font";

/**
 * M6c：把外观 key 写进 localStorage 作为**启动缓存**。
 *
 * 为什么需要它：`settings_get` 是异步 IPC，赶不上首帧——深色用户每次启动都会
 * 先闪一帧浅色（换字体同理）。`index.html` 的 <head> 内联脚本同步读这两个缓存，
 * 先把 `data-scheme` / `data-font` 落位。**真源仍是 AppConfig**（硬约定 10）：
 * 缓存被清只退化为一帧闪白，不丢设置；隐私模式/配额满时静默忽略。
 */
function writeAppearanceCache(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* 忽略：退化为一帧闪白，不影响功能 */
  }
}

/* ── IPC ── */

export const settings = {
  /** 读设置（不依赖 vault：未配置笔记库时设置页也可用） */
  get: () => invoke<Settings>("settings_get"),
  /** 改设置：传入的小节整体替换，**以返回值为准**（归一化后的结果） */
  patch: (patch: SettingsPatch) => invoke<Settings>("settings_patch", { patch }),
  /** 恢复默认（保留 vaultPath / syncAuto） */
  reset: () => invoke<Settings>("settings_reset"),
};
