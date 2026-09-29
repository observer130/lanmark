import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "../lib/sync";

/**
 * M4i 移动端返回手势（仅 Android）。
 *
 * 分工：**原生管「返回发生了」，前端管「返回该做什么」**。
 *
 * - 下行：前端在浮层开关时调 `set_ui_back_handler` 报告当前状态
 *   （`drawer` / `overlay` / `none`）；因为返回由系统直接派发给原生，
 *   原生没机会先问前端。
 * - 上行：原生只在**有浮层**时拦下返回，用 `evaluateJavascript` 派发 DOM
 *   CustomEvent `lanmark:back`；这里监听它并关掉浮层。
 *
 * **不用 `addPluginListener`**：真机 2510DRK44C / Android 16 实测注册后
 * Kotlin 侧 `hasListener=false`，事件收不到。直接派发 DOM 事件更可靠
 * （Tauri 的 WebView 与前端同页面上下文，CustomEvent 一定能收到）。
 *
 * 桌面端全部 no-op（`isAndroid()` 判定）：桌面不注册返回手势。
 */

export type BackHandler = "drawer" | "overlay" | "none";

/** 前端监听的 DOM 事件名（与 BackPlugin.DISPATCH_JS 配对） */
export const BACK_EVENT = "lanmark:back";

/** 最近一次上报的 handler：去重，避免每次 state 抖动都跨 IPC 往返 */
let current: BackHandler | null = null;

/**
 * 上报「当前返回该做什么」。
 * 语义：**有抽屉/浮层 → 返回关它；都没有 → 原生不拦截，正常退出**。
 */
export function reportBackHandler(next: BackHandler): void {
  if (!isAndroid()) return;
  if (current === next) return;
  current = next;
  // 失败不抛：返回手势降级成「直接退出」，不影响其它功能
  void invoke("set_ui_back_handler", { handler: next }).catch(() => {});
}

/**
 * 监听原生的返回事件 → 关掉当前浮层。
 * @returns 取消监听的函数
 */
export function listenBackPress(onBack: () => void): () => void {
  if (!isAndroid()) return () => {};
  window.addEventListener(BACK_EVENT, onBack);
  return () => window.removeEventListener(BACK_EVENT, onBack);
}

/** 仅测试用：重置去重状态 */
export function resetBackHandlerForTest(): void {
  current = null;
}
