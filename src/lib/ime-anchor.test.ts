import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  installImeAnchorGuard,
  isEditableTarget,
  isWindowsWebView,
  IME_ANCHOR_DEBOUNCE_MS,
  IME_ANCHOR_FOCUS_DELAY_MS,
} from "./ime-anchor";

/** jsdom 默认 UA 不是 Windows；按需改写 */
function stubUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

describe("isWindowsWebView", () => {
  const original = window.navigator.userAgent;
  afterEach(() => stubUserAgent(original));
  it("Windows NT 的 UA 才判定为需要护栏", () => {
    stubUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0",
    );
    expect(isWindowsWebView()).toBe(true);
    stubUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    expect(isWindowsWebView()).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("输入框 / 文本域可编辑", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
  });
  it("contenteditable 可编辑（ProseMirror / CodeMirror 6 都是它）", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isEditableTarget(div)).toBe(true);
    div.setAttribute("contenteditable", "plaintext-only");
    expect(isEditableTarget(div)).toBe(true);
  });
  it("普通元素 / body / null 不算", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("installImeAnchorGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("非 Windows 平台整段空操作（不装监听）", () => {
    stubUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
    const add = vi.spyOn(window, "addEventListener");
    const dispose = installImeAnchorGuard();
    expect(add).not.toHaveBeenCalled();
    dispose();
    add.mockRestore();
  });

  it("缩放稳定后：blur → 等 focusDelay → focus，并还原选区", () => {
    const input = document.createElement("input");
    input.value = "hello";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(2, 3);
    const focus = vi.spyOn(input, "focus");
    const blur = vi.spyOn(input, "blur");

    const debounceMs = 50;
    const focusDelayMs = 40;
    const dispose = installImeAnchorGuard({ enabled: true, debounceMs, focusDelayMs });
    window.dispatchEvent(new Event("resize"));

    // 未到防抖时间：不动手（避免拖拽中途反复抢焦点）
    vi.advanceTimersByTime(debounceMs - 1);
    expect(blur).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(blur).toHaveBeenCalledTimes(1);
    // blur 与 focus 之间必须留间隔：贴在一起会被渲染进程合并，等于没转移焦点
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(focusDelayMs - 1);
    expect(focus).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(3);
    dispose();
  });

  it("默认间隔不是 0（0 会让源码模式失效，见文件头实测表）", () => {
    expect(IME_ANCHOR_FOCUS_DELAY_MS).toBeGreaterThan(0);
    expect(IME_ANCHOR_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it("重锚后还原编辑容器的滚动位置", () => {
    const scroller = document.createElement("div");
    const input = document.createElement("input");
    scroller.appendChild(input);
    document.body.appendChild(scroller);
    input.focus();
    Object.defineProperty(scroller, "scrollTop", { value: 120, writable: true });
    const dispose = installImeAnchorGuard({ enabled: true, debounceMs: 10, focusDelayMs: 10 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(80);
    expect(scroller.scrollTop).toBe(120);
    dispose();
  });

  it("连续 resize 只重锚一次（防抖）", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const blur = vi.spyOn(input, "blur");

    const dispose = installImeAnchorGuard({ enabled: true, debounceMs: 50 });
    for (let i = 0; i < 8; i++) window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60);
    vi.runAllTimers();
    expect(blur).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("焦点不在可编辑元素上时是空操作", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const blur = vi.spyOn(div, "blur");
    const dispose = installImeAnchorGuard({ enabled: true, debounceMs: 50 });
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60);
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
    dispose();
  });

  it("输入法合成中不打断，compositionend 后再补锚", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const blur = vi.spyOn(input, "blur");

    const dispose = installImeAnchorGuard({ enabled: true, debounceMs: 50 });
    window.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(60);
    expect(blur).not.toHaveBeenCalled();

    window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    vi.advanceTimersByTime(60);
    vi.runAllTimers();
    expect(blur).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("卸载后不再响应 resize", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const blur = vi.spyOn(input, "blur");
    const dispose = installImeAnchorGuard({ enabled: true, debounceMs: 50 });
    dispose();
    window.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(200);
    vi.runAllTimers();
    expect(blur).not.toHaveBeenCalled();
  });
});
