import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 返回手势的前端侧契约。
 *
 * 钉两件事：
 * 1. 桌面端（非 Android）**完全不碰 IPC** —— 返回手势是 Android 专属，
 * 桌面误调会报「命令不存在」，且毫无意义。
 * 2. 相同 handler 不重复下发 —— 上报在浮层开关时触发，若不去重，
 * 抽屉动画期间的多次渲染会打出一串跨 IPC 往返。
 *
 * 分发的**决策表**在 Kotlin 侧（BackPlugin.resolve，见
 * gen/android/.../BackPluginTest.kt）；这里只测前端的下发行为。
 */

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  // 返回 promise：reportBackHandler 会 `.catch()`，返回 undefined 会炸在测试里
  invoke: (...args: unknown[]) => {
    invoke(...(args as []));
    return Promise.resolve();
  },
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));

// 必须在 mock 之后 import：模块顶层会读 isAndroid()
const { reportBackHandler, resetBackHandlerForTest } = await import("./back");

describe("返回手势上报", () => {
  beforeEach(() => {
    invoke.mockClear();
    resetBackHandlerForTest();
  });

  it("桌面端不上报（Android 专属，误调会报命令不存在）", () => {
    // vitest 环境是 jsdom，UA 不含 Android → isAndroid() 为 false
    reportBackHandler("drawer");
    reportBackHandler("overlay");
    reportBackHandler("none");
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * 回归（评审 D2）：此前这条分支从未被执行——jsdom 的 UA 不含 Android，
   * 断言「不调 IPC」在假绿：Android 侧真调了也测不出来。
   */
  it("Android：上报去重，DOM 事件能唤起回调且可注销", async () => {
    const orig = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: `${orig} Android 16`,
      configurable: true,
    });
    try {
      const { listenBackPress } = await import("./back");
      reportBackHandler("drawer");
      expect(invoke).toHaveBeenCalledWith("set_ui_back_handler", { handler: "drawer" });

      // 去重：同一 handler 不重复跨 IPC
      reportBackHandler("drawer");
      expect(invoke).toHaveBeenCalledTimes(1);

      reportBackHandler("none");
      expect(invoke).toHaveBeenCalledTimes(2);

      // 原生派发的 DOM 事件 → 回调；注销后不再触发
      const onBack = vi.fn();
      const off = listenBackPress(onBack);
      window.dispatchEvent(new CustomEvent("lanmark:back"));
      expect(onBack).toHaveBeenCalledTimes(1);
      off();
      window.dispatchEvent(new CustomEvent("lanmark:back"));
      expect(onBack).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: orig, configurable: true });
    }
  });
});
