/**
 * 运行平台判断（纯函数，不依赖 Tauri）。
 *
 * 单独成文件而不是塞在 `sync.ts`：`vault-url.ts` 要用它来决定协议前缀，
 * 而 `sync.ts` 顶层 import 了 `@tauri-apps/api` —— 往返/URL 这类纯逻辑测试
 * 不该为了一个 UA 判断把整条 IPC 依赖拖进来。
 */

/** Android WebView 的 UA 必含 Android；桌面端（Win/Linux/macOS）不含 */
export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Android");
}
