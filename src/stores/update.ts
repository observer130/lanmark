import { create } from "zustand";
import { update, type UpdateInfo } from "../lib/update";
import { useSettingsStore } from "./settings";

/**
 * M5-4 更新检测状态（关于页展示）。
 *
 * 两条触发路径：
 * - `autoCheck`：启动时静默检查（仅 `settings.update.autoCheck` 开启时）。
 *   **契约：须在 settings load 完成后调用**（App.tsx 里 `load().then(autoCheck)`
 *   链式保证——否则读到的 autoCheck 还是默认值，用户关掉的开关形同虚设）。
 *   Rust 侧 24h 节流；skipped 视为无新信息；失败完全静默（无网/限流不打扰，
 *   且 Rust 侧失败不记时间戳，下次启动自动重试）。
 * - `checkNow`：关于页手动「检查更新」，force=true 无视节流，错误浮出到页面。
 *
 * 提示纪律（M5 定稿）：发现新版本**只在关于页**展示，不弹窗、不挂红点。
 */
interface UpdateStore {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  autoCheck: () => Promise<void>;
  checkNow: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStore>((set) => ({
  info: null,
  checking: false,
  error: null,

  autoCheck: async () => {
    if (useSettingsStore.getState().settings.update.autoCheck !== true) return;
    try {
      const info = await update.check(false);
      if (!info.skipped) set({ info, error: null });
    } catch {
      /* 静默：自动检查失败不打扰 */
    }
  },

  checkNow: async () => {
    set({ checking: true, error: null });
    try {
      const info = await update.check(true);
      set({ info, checking: false });
    } catch (e) {
      set({ checking: false, error: String(e) });
    }
  },
}));
