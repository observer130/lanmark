import { create } from "zustand";
import type { OutlineItem } from "../lib/outline";

/**
 * 大纲跳转请求（M10）。
 *
 * Sidebar（桌面）与底部抽屉（移动端）都只负责「请求跳转」，真正的执行在 EditorPane：
 *  - WYSIWYG / 阅读模式走 ProseMirror 顶层 heading 序号；
 *  - 源码模式走 markdown 行号。
 * 用 seq 而不是 item 本身做触发：连点同一个标题两次也要能再次滚动。
 */
interface OutlineStore {
  request: { path: string; item: OutlineItem; seq: number } | null;
  jump: (path: string, item: OutlineItem) => void;
  clear: () => void;
}

let seq = 0;

export const useOutlineStore = create<OutlineStore>((set) => ({
  request: null,
  jump: (path, item) => set({ request: { path, item, seq: ++seq } }),
  clear: () => set({ request: null }),
}));
