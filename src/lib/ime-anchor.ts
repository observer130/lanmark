/**
 * Windows / WebView2：宿主窗口被拖拽缩放后，输入法（TSF）候选框跑到**屏幕左上角**
 * 而不是光标附近的修复。
 *
 * ## 现象与成因
 *
 * 用鼠标拖窗口边框缩放后（真实 WM_ENTERSIZEMOVE 路径）立刻用输入法打字，预编辑与
 * 候选框会浮在屏幕左上角，且**不再自愈**：光标还在正文里、文字也能提交，只有选词框
 * 位置错。程序化改窗口大小（SetWindowPos）不会触发，真实拖拽必现。
 *
 * 成因在 WebView2 宿主层（Chromium 侧一致，Edge/Chrome 不复现）：宿主缩放后浏览器
 * 进程侧的 TSF 文本库丢了 caret 布局（`GetTextExt` 拿不到位置），输入法退回默认位置
 * ——屏幕原点。要把它喂回去，必须让渲染进程重发一次 `TextInputState`。
 *
 * 上游记录：MicrosoftEdge/WebView2Feedback#5675（复现环境就是 Tauri 2.11.5 /
 * wry 0.55.1 / webview2-com 0.38.2，与本仓库同版本）。
 *
 * ## 本地实测（2026-10-07，WebView2 154.0.4258.53，微软拼音）哪些手段有效
 *
 * | 手段                                   | 结果 |
 * |----------------------------------------|------|
 * | `blur()` → **等 60ms** → `focus()`      | 修复（所见即所得与源码模式都过） |
 * | `blur()` → `setTimeout(0)` → `focus()`  | 所见即所得修复，**源码模式无效** |
 * | 同一任务内同步 `blur()` + `focus()`    | 无效 |
 * | 只调 `focus()`（元素本就是 activeElement）| 无效 |
 * | 只挪 DOM 选区（+1 字符再回原位）        | 无效 |
 * | `NotifyParentWindowPositionChanged`    | 无效（上游报告同结论） |
 *
 * 结论：只有**真的发生一次焦点转移**、且两次状态变化分开到渲染进程来得及各自上报
 * （间隔太短会被合并成「没变过」）才会重发 TextInputState。ProseMirror 对间隔不敏感，
 * CodeMirror 6 的 contenteditable 需要 60ms 才稳，故统一取 60ms。
 * 所以这里的做法是：窗口尺寸变化后（防抖）把当前可编辑元素重锚一次——blur，等
 * {@link IME_ANCHOR_FOCUS_DELAY_MS} 再 focus 回来，并还原选区与滚动位置。
 *
 * 只在 Windows/WebView2 上启用：Linux(WebKitGTK)/macOS(WKWebView) 的输入法行为不同，
 * 没必要替它们做这个动作。
 */

/** 缩放拖动期间 resize 事件连发；等它稳定下来再重锚一次 */
export const IME_ANCHOR_DEBOUNCE_MS = 120;

/**
 * blur 与 focus 之间必须留的间隔。
 *
 * 不能是 0：同一任务内（含 `setTimeout(0)`）的 blur+focus 会被渲染进程合并，
 * 浏览器进程侧看不到焦点转移，TSF 布局就不会重发——源码模式（CodeMirror 6）
 * 实测无效；60ms 两个模式都稳（见文件头表格）。
 */
export const IME_ANCHOR_FOCUS_DELAY_MS = 60;

/** 当前是不是 Windows 上的 WebView2（Tauri 桌面端 Windows 前端 UA 带 `Windows NT`） */
export function isWindowsWebView(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/** 可编辑目标：输入框 / 文本域 / contenteditable（ProseMirror、CodeMirror 6 都属于后者） */
export function isEditableTarget(el: Element | null): el is HTMLElement {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  const attr = el.getAttribute("contenteditable");
  return el.isContentEditable === true || attr === "" || attr === "true" || attr === "plaintext-only";
}

export interface ImeAnchorGuardOptions {
  /** 注入用（默认真实 window；测试传 jsdom window） */
  target?: Window;
  debounceMs?: number;
  /** blur 与 focus 的间隔，默认 {@link IME_ANCHOR_FOCUS_DELAY_MS} */
  focusDelayMs?: number;
  /** 默认按平台判定；测试可强制开启/关闭 */
  enabled?: boolean;
}

interface ScrollState {
  el: HTMLElement;
  top: number;
  left: number;
}

function saveScroll(el: HTMLElement): ScrollState[] {
  const out: ScrollState[] = [];
  let node: HTMLElement | null = el;
  while (node) {
    if (node.scrollTop !== 0 || node.scrollLeft !== 0) {
      out.push({ el: node, top: node.scrollTop, left: node.scrollLeft });
    }
    node = node.parentElement;
  }
  return out;
}

function restoreScroll(states: ScrollState[]): void {
  for (const s of states) {
    if (!s.el.isConnected) continue;
    s.el.scrollTop = s.top;
    s.el.scrollLeft = s.left;
  }
}

/**
 * 装上「缩放后重锚输入焦点」护栏，返回卸载函数。
 * 任何时候调用都安全：没有可编辑焦点时是空操作。
 */
export function installImeAnchorGuard(opts: ImeAnchorGuardOptions = {}): () => void {
  const w = opts.target ?? window;
  const enabled = opts.enabled ?? isWindowsWebView();
  if (!enabled) return () => {};

  const doc = w.document;
  const debounceMs = opts.debounceMs ?? IME_ANCHOR_DEBOUNCE_MS;
  const focusDelayMs = opts.focusDelayMs ?? IME_ANCHOR_FOCUS_DELAY_MS;
  let timer: number | undefined;
  let focusTimer: number | undefined;
  let disposed = false;
  // 合成中的输入法不能被 blur 打断（会吞掉预编辑）；等 compositionend 再补做
  let composing = false;
  let pending = false;

  const reanchor = (): void => {
    const el = doc.activeElement;
    if (!isEditableTarget(el)) return;
    const sel = w.getSelection();
    // clone：原 Range 会随 blur 后的选区变化而被改写
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    const scrolls = saveScroll(el);
    el.blur();
    // 必须等一会儿：紧挨着（同一任务，甚至 setTimeout(0)）的 blur+focus 会被渲染进程
    // 合并，浏览器进程侧看不到焦点转移，TSF 布局就不会重发（CodeMirror 6 实测无效）
    focusTimer = w.setTimeout(() => {
      focusTimer = undefined;
      if (disposed) return;
      if (el.isConnected) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          el.focus();
        }
        if (range) {
          const s = w.getSelection();
          if (s) {
            s.removeAllRanges();
            s.addRange(range);
          }
        }
      }
      restoreScroll(scrolls);
    }, focusDelayMs);
  };

  const schedule = (): void => {
    if (timer !== undefined) w.clearTimeout(timer);
    timer = w.setTimeout(() => {
      timer = undefined;
      if (composing) {
        pending = true;
        return;
      }
      reanchor();
    }, debounceMs);
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    if (pending) {
      pending = false;
      schedule();
    }
  };

  w.addEventListener("resize", schedule);
  w.addEventListener("compositionstart", onCompositionStart, true);
  w.addEventListener("compositionend", onCompositionEnd, true);
  return () => {
    disposed = true;
    if (timer !== undefined) w.clearTimeout(timer);
    if (focusTimer !== undefined) w.clearTimeout(focusTimer);
    w.removeEventListener("resize", schedule);
    w.removeEventListener("compositionstart", onCompositionStart, true);
    w.removeEventListener("compositionend", onCompositionEnd, true);
  };
}
