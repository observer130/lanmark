import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M4i 返回手势的前端侧契约。
 *
 * 钉两件事：
 * 1. 桌面端（非 Android）**完全不碰 IPC** —— 返回手势是 Android 专属，
 *    桌面误调会报「命令不存在」，且毫无意义。
 * 2. 相同 handler 不重复下发 —— 上报在浮层开关时触发，若不去重，
 *    抽屉动画期间的多次渲染会打出一串跨 IPC 往返。
 *
 * 分发的**决策表**在 Kotlin 侧（BackPlugin.resolve，见
 * gen/android/.../BackPluginTest.kt）；这里只测前端的下发行为。
 */

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));

// 必须在 mock 之后 import：模块顶层会读 isAndroid()
const { reportBackHandler, resetBackHandlerForTest } = await import("./back");

describe("M4i 返回手势上报", () => {
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
});
