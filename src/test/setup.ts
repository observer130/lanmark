// vitest 全局 setup：补齐 jsdom 缺失的浏览器 API
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] {
    return [];
  }
}

if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

// `__TAURI_INTERNALS__.metadata`：@tauri-apps/api 的 getCurrentWindow() 在**模块顶层**
// 就读它，而 WindowControls.tsx 被 EditorPane 引用（`editorKey` 的护栏用例要导入
// EditorPane，于是连带触发）。补个最小桩，纯逻辑模块就不必为 Tauri 运行时 mock 一整条链。
const g = globalThis as Record<string, unknown>;
if (!g.__TAURI_INTERNALS__) {
  g.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: () => Promise.reject(new Error("invoke 未在本用例中打桩")),
    transformCallback: (cb: unknown) => cb,
    convertFileSrc: (p: string) => p,
  };
}
