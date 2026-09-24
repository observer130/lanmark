import { create } from "zustand";
import {
  applyCssVars,
  settings as settingsApi,
  type Appearance,
  type EditorPrefs,
  type Settings,
  type SettingsPatch,
  type StoragePrefs,
} from "../lib/settings";

/**
 * M4a 设置 store（与 vault / sync 同构）。
 *
 * 应用顺序（docs/08 §6.3）：
 *   UI 改动 → 乐观 set state → applyCssVars（立即可见） → settings_patch
 *           → 以 Rust 返回值覆盖 state（归一化结果）
 *           └→ 失败：回滚上一版 state + 复原 CSS 变量 + error 提示
 *
 * 乐观更新的意义：字号/字体点一下就要变，不能等 IPC 往返；而失败必须回滚，
 * 否则界面显示的和盘上的不一致，重启后「设置自己变回去了」。
 */

/** 与 Rust `settings::Appearance::default()` 逐字段一致的兜底默认值 */
export const DEFAULT_APPEARANCE: Appearance = {
  uiFont: "system",
  textFont: "sans",
  monoFont: "system",
  customFonts: { ui: "", text: "", mono: "" },
  textSize: "md",
  codeSize: "md",
  lineHeight: "normal",
  contentWidth: "auto",
  uiScalePct: 100,
};

export const DEFAULT_EDITOR: EditorPrefs = {
  defaultMode: "wysiwyg",
  autosaveMs: 700,
  sourceLineNumbers: true,
  newNoteLocation: "root",
};

export const DEFAULT_STORAGE: StoragePrefs = { trashRetentionDays: 30 };

export const DEFAULT_SETTINGS: Settings = {
  appearance: DEFAULT_APPEARANCE,
  editor: DEFAULT_EDITOR,
  storage: DEFAULT_STORAGE,
};

interface SettingsStore {
  settings: Settings;
  loading: boolean;
  error: string | null;
  /** 设置页是否打开（侧栏「设置」行 / 首启页齿轮触发） */
  dialogOpen: boolean;
  /** 设置页当前分组（窄屏单列分节时用于滚动定位） */
  activeSection: SectionKey;
  /**
   * D3：「管理设备与配对」的跳转请求。设置页不复制一套配对 UI，
   * 而是关掉自己 + 请侧栏把同步面板展开（docs/08 §3.4 D3）。
   * 计数器而非布尔：连点两次也要能再次触发（布尔会因「已经是 true」失效）。
   */
  syncPanelRequest: number;
  /**
   * 窄屏专用：D3 跳转请求同时要**打开侧栏抽屉**——否则同步面板会在一个
   * 已收起（`-translate-x-full`）的容器里展开，视觉上被挤出屏幕左侧
   * （真机走查发现）。桌面无抽屉，此值恒不消费。
   */
  navDrawerRequest: number;

  load: () => Promise<void>;
  /** 改某个小节：乐观更新 → 应用 CSS 变量 → 落库 → 以返回值覆盖 */
  patch: (patch: SettingsPatch) => Promise<void>;
  reset: () => Promise<void>;
  openDialog: (section?: SectionKey) => void;
  closeDialog: () => void;
  /** D3：关设置页并请求展开侧栏同步面板 */
  requestSyncPanel: () => void;
  setActiveSection: (s: SectionKey) => void;
  clearError: () => void;
}

export type SectionKey = "appearance" | "editor" | "storage" | "sync" | "about";

let loadSeq = 0;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loading: true,
  error: null,
  dialogOpen: false,
  activeSection: "appearance",
  syncPanelRequest: 0,
  navDrawerRequest: 0,

  load: async () => {
    const seq = ++loadSeq;
    try {
      const s = await settingsApi.get();
      if (seq !== loadSeq) return;
      set({ settings: s, loading: false, error: null });
      applyCssVars(s.appearance);
    } catch (e) {
      if (seq !== loadSeq) return;
      // 读失败也要落地 CSS 变量：否则界面停在「无变量」状态，
      // index.css 的 var() 全部落空 → 字号/字体塌成浏览器默认
      set({ loading: false, error: String(e) });
      applyCssVars(DEFAULT_APPEARANCE);
    }
  },

  patch: async (patch) => {
    const prev = get().settings;
    // 乐观合并：只动 patch 里出现的小节（与 Rust 的「整节替换」语义一致）
    const optimistic: Settings = {
      appearance: patch.appearance ?? prev.appearance,
      editor: patch.editor ?? prev.editor,
      storage: patch.storage ?? prev.storage,
    };
    set({ settings: optimistic });
    applyCssVars(optimistic.appearance);
    try {
      const saved = await settingsApi.patch(patch);
      set({ settings: saved, error: null });
      // 以返回值为准再写一次：非法字体串会被 Rust 回退成 system，
      // 乐观那一下显示的是用户输入，这里必须纠正
      applyCssVars(saved.appearance);
    } catch (e) {
      set({ settings: prev, error: String(e) });
      applyCssVars(prev.appearance);
    }
  },

  reset: async () => {
    const prev = get().settings;
    set({ settings: DEFAULT_SETTINGS });
    applyCssVars(DEFAULT_APPEARANCE);
    try {
      const saved = await settingsApi.reset();
      set({ settings: saved, error: null });
      applyCssVars(saved.appearance);
    } catch (e) {
      set({ settings: prev, error: String(e) });
      applyCssVars(prev.appearance);
    }
  },

  openDialog: (section) =>
    set({ dialogOpen: true, activeSection: section ?? get().activeSection }),
  closeDialog: () => set({ dialogOpen: false }),
  requestSyncPanel: () =>
    set((s) => ({
      dialogOpen: false,
      syncPanelRequest: s.syncPanelRequest + 1,
      navDrawerRequest: s.navDrawerRequest + 1,
    })),
  setActiveSection: (s) => set({ activeSection: s }),
  clearError: () => set({ error: null }),
}));

/** 便捷读取（非 React 上下文，如 EditorPane 的 CodeMirror 配置） */
export const currentEditor = (): EditorPrefs => useSettingsStore.getState().settings.editor;
export const currentAppearance = (): Appearance =>
  useSettingsStore.getState().settings.appearance;
