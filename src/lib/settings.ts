import { invoke } from "@tauri-apps/api/core";

/**
 * M4a 设置：设备级偏好（字体/字号/行距/行宽/编辑器）的前端封装。
 *
 * 存哪：`app_config_dir/config.json`（Rust `AppConfig`），**不在 vault 内、不在 localStorage**。
 * 理由见 docs/08 §4.1：字体是设备偏好，换库不该变；localStorage 会被 Android WebView
 * 清理且不可测。vault 级视图状态（折叠目录）继续留在 localStorage。
 *
 * 与 Rust 的对应关系：Rust 只存枚举 key，**字体栈映射、枚举→像素值全在本文件**
 * （单一来源），Rust 侧不重复一份 CSS 知识。
 */

/* ── 枚举 ── */

export type FontKey = "system" | "sans" | "serif" | "custom";
export type MonoFontKey = "system" | "mono" | "custom";
export type SizeKey = "sm" | "md" | "lg" | "xl";
export type LineHeightKey = "compact" | "normal" | "relaxed";
export type ContentWidthKey = "auto" | "limited";
export type EditorMode = "read" | "wysiwyg" | "source";
export type NewNoteLocation = "root" | "last";

export interface CustomFonts {
  /** 空串 = 未设置 */
  ui: string;
  text: string;
  mono: string;
}

export interface Appearance {
  uiFont: FontKey;
  textFont: FontKey;
  monoFont: MonoFontKey;
  customFonts: CustomFonts;
  textSize: SizeKey;
  codeSize: SizeKey;
  lineHeight: LineHeightKey;
  contentWidth: ContentWidthKey;
  /** P2：界面缩放百分比（100 / 112 / 125） */
  uiScalePct: number;
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

export interface Settings {
  appearance: Appearance;
  editor: EditorPrefs;
  storage: StoragePrefs;
}

/** patch 入参：传入的小节**整体替换**，未传的保持原值 */
export interface SettingsPatch {
  appearance?: Appearance;
  editor?: EditorPrefs;
  storage?: StoragePrefs;
}

/* ── 字体栈映射（唯一来源；key → CSS font-family 栈） ── */

/** `system` 沿用 index.css 里 `--font-sans` 的原栈（即当前视觉，升级无感） */
const SYSTEM_SANS =
  '"Noto Sans", "Segoe UI", system-ui, "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
/** `system` 等宽沿用 `--font-mono` 原栈 */
const SYSTEM_MONO =
  '"JetBrains Mono", "Cascadia Code", ui-monospace, "Noto Sans Mono CJK SC", monospace';

const UI_FONT_STACKS: Record<Exclude<FontKey, "custom">, string> = {
  system: SYSTEM_SANS,
  sans: '"Noto Sans","PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif',
  serif:
    '"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",Georgia,serif',
};

const MONO_FONT_STACKS: Record<Exclude<MonoFontKey, "custom">, string> = {
  system: SYSTEM_MONO,
  mono: '"JetBrains Mono","Cascadia Code","Noto Sans Mono CJK SC",ui-monospace,monospace',
};

/** 界面字体 → CSS 栈 */
export function uiFontStack(a: Appearance): string {
  if (a.uiFont === "custom" && a.customFonts.ui) return a.customFonts.ui;
  return UI_FONT_STACKS[a.uiFont as Exclude<FontKey, "custom">] ?? SYSTEM_SANS;
}

/** 正文字体 → CSS 栈（`mono`/`custom` 之外与界面共用同一张表） */
export function textFontStack(a: Appearance): string {
  if (a.textFont === "custom" && a.customFonts.text) return a.customFonts.text;
  return UI_FONT_STACKS[a.textFont as Exclude<FontKey, "custom">] ?? SYSTEM_SANS;
}

/** 等宽字体 → CSS 栈 */
export function monoFontStack(a: Appearance): string {
  if (a.monoFont === "custom" && a.customFonts.mono) return a.customFonts.mono;
  return MONO_FONT_STACKS[a.monoFont as Exclude<MonoFontKey, "custom">] ?? SYSTEM_MONO;
}

/* ── 枚举 → 数值（四档；正文与源码各查自己的表，docs/08 §3.1） ── */

const TEXT_PX: Record<SizeKey, number> = { sm: 14, md: 16, lg: 18, xl: 20 };
const CODE_PX: Record<SizeKey, number> = { sm: 12, md: 14, lg: 16, xl: 18 };
const LINE_HEIGHT: Record<LineHeightKey, number> = {
  compact: 1.55,
  normal: 1.75,
  relaxed: 2.0,
};

export const textSizePx = (k: SizeKey): number => TEXT_PX[k] ?? TEXT_PX.md;
export const codeSizePx = (k: SizeKey): number => CODE_PX[k] ?? CODE_PX.md;
export const lineHeightValue = (k: LineHeightKey): number => LINE_HEIGHT[k] ?? LINE_HEIGHT.normal;
/** 正文宽度 `limited` 的上限（宽屏防「一行太长」） */
export const CONTENT_MAX_PX = 820;

/* ── UI 档位标签（设置页分段按钮用） ── */

export const SIZE_OPTIONS: { key: SizeKey; label: string }[] = [
  { key: "sm", label: "小" },
  { key: "md", label: "中" },
  { key: "lg", label: "大" },
  { key: "xl", label: "特大" },
];

export const UI_FONT_OPTIONS: { key: FontKey; label: string }[] = [
  { key: "system", label: "系统默认" },
  { key: "sans", label: "无衬线" },
  { key: "serif", label: "衬线" },
  { key: "custom", label: "自定义" },
];

export const MONO_FONT_OPTIONS: { key: MonoFontKey; label: string }[] = [
  { key: "system", label: "系统默认" },
  { key: "mono", label: "等宽" },
  { key: "custom", label: "自定义" },
];

export const LINE_HEIGHT_OPTIONS: { key: LineHeightKey; label: string }[] = [
  { key: "compact", label: "紧凑" },
  { key: "normal", label: "标准" },
  { key: "relaxed", label: "宽松" },
];

export const CONTENT_WIDTH_OPTIONS: { key: ContentWidthKey; label: string }[] = [
  { key: "auto", label: "跟随窗口" },
  { key: "limited", label: "限宽 820px" },
];

export const AUTOSAVE_OPTIONS: { key: number; label: string }[] = [
  { key: 300, label: "0.3 秒" },
  { key: 700, label: "0.7 秒" },
  { key: 1500, label: "1.5 秒" },
  { key: 3000, label: "3 秒" },
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

/* ── CSS 变量写入（applyCssVars 是唯一写入点） ── */

/**
 * 把外观设置写进 `:root` 的 CSS 变量。
 *
 * **为什么走变量**：改字体/字号绝不能重建编辑器实例——Crepe 建实例会发一次伪
 * `markdownUpdated`，若因此重跑就可能「改个字号把笔记重写一遍」（硬约定 3）。
 * 变量只影响渲染，`MilkdownHost` 的 key 不受影响（见 `editorKey`）。
 *
 * 自定义字体串的合法性由 Rust 侧白名单把关（`sanitize_font_stack`），
 * 这里拿到的已是归一化后的值。
 */
export function applyCssVars(a: Appearance, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  const set = (k: string, v: string) => el.style.setProperty(k, v);
  set("--lanmark-font-ui", uiFontStack(a));
  set("--lanmark-font-text", textFontStack(a));
  set("--lanmark-font-mono", monoFontStack(a));
  set("--lanmark-text-size", `${textSizePx(a.textSize)}px`);
  set("--lanmark-code-size", `${codeSizePx(a.codeSize)}px`);
  set("--lanmark-line-height", String(lineHeightValue(a.lineHeight)));
  set(
    "--lanmark-content-max",
    a.contentWidth === "limited" ? `${CONTENT_MAX_PX}px` : "none",
  );
  // 界面缩放（P2）：只改 rem 基准，编辑区字号由上面的 px 变量独立决定
  set("--lanmark-ui-scale", `${a.uiScalePct}%`);
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
