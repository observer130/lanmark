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
 * M5 减法：字体（界面/正文/等宽/自定义）、源码字号、正文宽度、界面缩放已移除，
 * 字体栈常驻 `index.css`（`--font-sans` / `--lanmark-font-text` / `--lanmark-font-mono`）；
 * 旧 config.json 里的相关字段由 serde 静默忽略、下次保存自然清除，无需迁移。
 *
 * M6 主题：新增 `theme` 枚举（晨窗/夜航/纸页/文楷）。色值与主题字体栈全在
 * `index.css` 的 `:root[data-theme=…]` 块里，本文件只负责把 key 写成
 * `<html data-theme>` 属性（`applyTheme`）——JS 对「主题长什么样」零知识。
 */

/* ── 枚举 ── */

export type SizeKey = "sm" | "md" | "lg" | "xl";
export type LineHeightKey = "compact" | "normal" | "relaxed";
export type EditorMode = "read" | "wysiwyg" | "source";
export type NewNoteLocation = "root" | "last";
/** M6 主题 key（与 Rust `THEME_KEYS` 同序同值，docs/09 §6） */
export type ThemeKey = "morning" | "night" | "paper" | "wenkai";

export interface Appearance {
  theme: ThemeKey;
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

/** 主题清单（设置页分段按钮用）；配色/字体在 index.css 的 `[data-theme]` 块 */
export const THEME_OPTIONS: { key: ThemeKey; label: string }[] = [
  { key: "morning", label: "晨窗" },
  { key: "night", label: "夜航" },
  { key: "paper", label: "纸页" },
  { key: "wenkai", label: "文楷" },
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

/* ── 外观写入（applyCssVars / applyTheme 是仅有的两个写入点） ── */

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
 * M6 主题：把 key 写成 `<html data-theme="…">`，其余全交给 `index.css` 的
 * `:root[data-theme=…]` 变量块（配色 + 编辑区字体栈）传导。
 *
 * **为什么不用 style.setProperty 逐个写色值**：那等于把设计 token 复制进 JS，
 * 与「色值只在 CSS、枚举映射只在 TS」的分工相悖（docs/09 §4.1）；改主题是一个
 * DOM 属性写入，同样不重建编辑器实例（硬约定 11）。
 * 非法 key 的兜底在 Rust 归一化（`settings_patch` 返回值为准）+ TS 类型约束。
 */
export function applyTheme(theme: ThemeKey, root?: HTMLElement): void {
  const el = root ?? document.documentElement;
  if (THEME_OPTIONS.some((o) => o.key === theme)) {
    el.dataset.theme = theme;
    writeThemeCache(theme);
  } else {
    // 运行时脏值（手改 config / 未来版本回退）不写属性 ⇒ 落在 :root 晨窗默认
    delete el.dataset.theme;
    writeThemeCache(null);
  }
}

/** 首帧启动缓存的 key（`index.html` 内联脚本按此读取，两处必须一致） */
export const THEME_CACHE_KEY = "lanmark-theme";

/**
 * M6c：把主题 key 写进 localStorage 作为**启动缓存**。
 *
 * 为什么需要它：`settings_get` 是异步 IPC，赶不上首帧——深色用户每次启动都会
 * 先闪一帧浅色。`index.html` 的 <head> 内联脚本同步读这个缓存，先把
 * `data-theme` 落位。**真源仍是 AppConfig**（硬约定 10）：缓存被清只退化为一帧
 * 闪白，不丢设置；隐私模式/配额满时静默忽略。
 */
function writeThemeCache(theme: ThemeKey | null): void {
  try {
    if (theme) localStorage.setItem(THEME_CACHE_KEY, theme);
    else localStorage.removeItem(THEME_CACHE_KEY);
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
