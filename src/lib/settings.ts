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
 */

/* ── 枚举 ── */

export type SizeKey = "sm" | "md" | "lg" | "xl";
export type LineHeightKey = "compact" | "normal" | "relaxed";
export type EditorMode = "read" | "wysiwyg" | "source";
export type NewNoteLocation = "root" | "last";

export interface Appearance {
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

/* ── CSS 变量写入（applyCssVars 是唯一写入点） ── */

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

/* ── IPC ── */

export const settings = {
  /** 读设置（不依赖 vault：未配置笔记库时设置页也可用） */
  get: () => invoke<Settings>("settings_get"),
  /** 改设置：传入的小节整体替换，**以返回值为准**（归一化后的结果） */
  patch: (patch: SettingsPatch) => invoke<Settings>("settings_patch", { patch }),
  /** 恢复默认（保留 vaultPath / syncAuto） */
  reset: () => invoke<Settings>("settings_reset"),
};
