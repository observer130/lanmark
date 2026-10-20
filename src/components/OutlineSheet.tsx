import { useEffect, useRef } from "react";
import type { OutlineItem } from "../lib/outline";
import { listenBackPress, reportBackHandler } from "../stores/back";
import { useDismissable } from "./useDismissable";
import { OutlineList } from "./OutlineList";

/**
 * 移动端「大纲」底部抽屉（M10）。
 *
 * 调研结论（Obsidian / Bear / Craft / Notion）：手机上的目录入口应该是**一个按钮 + 面板**，
 * 而不是藏进侧栏。这里沿用 BlockMenu / InsertMenu 的抽屉语言：遮罩不挂 onClick、
 * 关闭只认 useDismissable 的 pointerdown，抽屉不监听 scroll/resize。
 */
export function OutlineSheet({
  open,
  items,
  onPick,
  onClose,
}: {
  open: boolean;
  items: OutlineItem[];
  onPick: (item: OutlineItem) => void;
  onClose: () => void;
}) {
  const ref = useDismissable(open, onClose);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Android 返回键：抽屉开着时先关抽屉，而不是退出应用。
  // 原生只在前端上报 overlay 时才派发 lanmark:back（见 AGENTS.md 平台三坑）；
  // 这里必须在开/关时维护 handler，否则返回会直接把 App 杀掉。
  useEffect(() => {
    if (!open) return;
    reportBackHandler("overlay");
    const unlisten = listenBackPress(() => closeRef.current());
    return () => {
      unlisten();
      reportBackHandler("none");
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" />
      <div
        ref={ref}
        role="menu"
        aria-label="笔记目录"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-card pb-[env(safe-area-inset-bottom)] shadow-pop"
      >
        <div className="sticky top-0 z-10 border-b border-line bg-card px-3 pb-2 pt-1.5">
          <div className="mx-auto mb-1.5 h-1 w-9 rounded-full bg-line" />
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink">笔记目录</span>
            <span className="text-[11px] text-ink-3">{items.length} 个标题</span>
          </div>
        </div>
        <div className="px-2 py-1">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-ink-3">
              这篇笔记还没有 1–3 级标题
            </div>
          ) : (
            <OutlineList items={items} onPick={onPick} />
          )}
        </div>
      </div>
    </>
  );
}
