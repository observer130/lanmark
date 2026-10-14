import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

import {
  moveUnitTo,
  planUnitMove,
  topBlockIndexAtPos,
  topBlockIndexFromPoint,
  unitLengthAt,
} from "./block-move";

/**
 * 接管「六个点手柄」的拖放：**落点判定 + 落点指示线 + 执行移动**。
 *
 * ## 为什么不让 ProseMirror 内建路径处理
 * 它靠 `view.dragging`（由 `@milkdown/plugin-block` 在 dragstart 时手动赋值）决定「移动还是
 * 复制」，这条链在部分 WebView 上会断——断掉后它回退成「从 `dataTransfer` 解析 HTML 再插入」，
 * 于是**源块不删、目标处多一份**（用户报的「拖了变成复制」）。
 *
 * 更隐蔽的一条：即使链没断，内建路径**只搬一个节点**。所以本插件一旦认定「这是手柄拖拽」，
 * 就必须由自己给出结论（含「不动」），**绝不能 return false 把它交回去**——交回去就是
 * 「拖标题只搬标题」：那次落点算出来是「落回源单元自己范围内」（无操作），于是内建路径接手，
 * 把标题单个搬走（M8 走查反馈，2026-10-13）。
 *
 * ## 落点指示线
 * 拖拽过程必须让用户看见**精确落点**。线只在本插件认领的拖拽里画，并且与真正执行落位用的是
 * **同一个 `computeDropSlot`**——所见即所得；算出来是「不动」时**不画线**，让「这里放不下」
 * 也有反馈。
 *
 * 不复用 ProseMirror 的 `dropCursor`（`CrepeFeature.Cursor`）：它按 `dropPoint` 画在**块级**
 * 位置，而我们的落点是**单元边界**（标题 = 一节），两者在拖标题时必然不一致——那会变成
 * 「线在这儿、东西落在别处」，比没有线更糟。
 */
const blockDragKey = new PluginKey("LANMARK_BLOCK_DRAG");

/** 拖拽源：顶层块序号。null = 当前没有「手柄发起的」拖拽 */
type DragSource = number | null;

interface DropSlot {
  /** 插到第几块之前（用**删除源之前**的块序号） */
  insertBefore: number;
  /** 指示线的视口坐标 */
  y: number;
  left: number;
  right: number;
}

/**
 * 手柄拖拽对应的块序号。
 * ① 优先用 Crepe 在 mousedown 时设下的 `NodeSelection`（与手柄指向的块天然一致）；
 * ② 兜底用**手柄自身的纵向位置**反查——Crepe 的 `#createSelection` 失败时（正是上面说的
 *    那条会退化成复制的路径）也必须能移动，不能跟着一起坏。
 */
function sourceIndexFromHandle(view: EditorView, handle: Element): DragSource {
  const sel = view.state.selection;
  if (sel instanceof NodeSelection) {
    const fromSelection = topBlockIndexAtPos(view.state.doc, sel.from);
    if (fromSelection !== null) return fromSelection;
  }
  const rect = handle.getBoundingClientRect();
  return topBlockIndexFromPoint(view, rect.left, rect.top + rect.height / 2);
}

/**
 * 落点 → 插入序号 + 指示线位置。**判定与画线共用这一个函数**，两边不会漂移。
 *
 * 两处非显然的处理：
 *  ① 用 `.ProseMirror` 的**第 index 个直接子元素**拿盒模型，不用 `view.nodeDOM(pos)`——后者
 *     要走一遍「文档位置 → DOM」的推断，在块边界处可能拿不到元素而静默退化成「插到该块之前」。
 *  ② **标题是一节的「头」，落到它下半区就落到整节之后**。否则被移动的单元会插进这个标题和
 *     它的正文之间，那段正文就改归新节管——语义被偷改。实测（.cache/probe-drag.mjs 场景 A）：
 *     不加这条，拖 h1「甲」到 h1「乙」下缘会得到 [乙, 甲节…, 乙的正文]，乙的正文被甲抢走。
 *     非标题目标仍是逐块粒度，这样节内段落重排不会被放大成整节跳动。
 */
function computeDropSlot(view: EditorView, clientX: number, clientY: number): DropSlot | null {
  const index = topBlockIndexFromPoint(view, clientX, clientY);
  if (index === null) return null;
  const el = view.dom.children.item(index);
  if (!(el instanceof HTMLElement)) return null;
  const rect = el.getBoundingClientRect();
  if (clientY <= rect.top + rect.height / 2) {
    return { insertBefore: index, y: rect.top, left: rect.left, right: rect.right };
  }
  const length = unitLengthAt(view.state.doc, index);
  const endEl = view.dom.children.item(index + length - 1);
  const endRect = endEl instanceof HTMLElement ? endEl.getBoundingClientRect() : rect;
  return { insertBefore: index + length, y: endRect.bottom, left: rect.left, right: rect.right };
}

export const blockDragPlugin = $prose((ctx) => {
  void ctx;
  let source: DragSource = null;

  return new Plugin({
    key: blockDragKey,
    view: (view) => {
      // 手柄挂在 `view.dom.parentElement`（`.milkdown`）上，不在 contenteditable 内，
      // 所以 dragstart 不会冒泡到 ProseMirror——必须自己在根上监听。
      const root = view.dom.parentElement;

      // 指示线：挂 body + fixed 定位，省掉「滚动容器内换算」（编辑器是可滚动的 .editor-host）。
      // pointer-events: none 是必需的——否则它会成为 drop 的命中目标，把落点判定带偏。
      const line = document.createElement("div");
      line.className = "lanmark-drop-line";
      line.hidden = true;
      document.body.appendChild(line);
      let lastPoint: { x: number; y: number } | null = null;

      const hideLine = () => {
        line.hidden = true;
        lastPoint = null;
      };

      /** 只有「会真的移动」才画线：「落回源单元自己范围内」不画，让无操作也有反馈 */
      const paintLine = (clientX: number, clientY: number) => {
        if (source === null) return hideLine();
        lastPoint = { x: clientX, y: clientY };
        const slot = computeDropSlot(view, clientX, clientY);
        if (!slot) return hideLine();
        const plan = planUnitMove(
          view.state.doc,
          source,
          unitLengthAt(view.state.doc, source),
          slot.insertBefore,
        );
        if (!plan) return hideLine();
        line.hidden = false;
        line.style.top = `${slot.y}px`;
        line.style.left = `${slot.left}px`;
        line.style.width = `${slot.right - slot.left}px`;
      };

      const onDragStart = (event: DragEvent) => {
        const target = event.target as Element | null;
        const handle = target?.closest?.(".milkdown-block-handle");
        source = handle ? sourceIndexFromHandle(view, handle) : null;
      };
      const onDragEnd = () => {
        source = null;
        hideLine();
      };
      const onDragOver = (event: DragEvent) => paintLine(event.clientX, event.clientY);
      const onDragLeave = (event: DragEvent) => {
        // 只在真的离开编辑器时才收线（在块之间移动会连续触发 dragleave）
        const to = event.relatedTarget as Node | null;
        if (!to || !root?.contains(to)) hideLine();
      };
      // 拖拽到边缘时 ProseMirror 会自动滚动，指针不动内容却在动——按最后一次指针位置重画
      const onScroll = () => {
        if (lastPoint) paintLine(lastPoint.x, lastPoint.y);
      };

      // 捕获阶段：先于 ProseMirror / Crepe 的处理，避免被它们改写选中态后读到错的块
      root?.addEventListener("dragstart", onDragStart, true);
      root?.addEventListener("dragend", onDragEnd, true);
      view.dom.addEventListener("dragover", onDragOver);
      view.dom.addEventListener("dragleave", onDragLeave);
      window.addEventListener("scroll", onScroll, true);

      return {
        destroy: () => {
          root?.removeEventListener("dragstart", onDragStart, true);
          root?.removeEventListener("dragend", onDragEnd, true);
          view.dom.removeEventListener("dragover", onDragOver);
          view.dom.removeEventListener("dragleave", onDragLeave);
          window.removeEventListener("scroll", onScroll, true);
          line.remove();
        },
      };
    },
    props: {
      handleDrop(view, event) {
        if (source === null) return false; // 不是手柄拖拽（正文选字/外部文件）→ 让原链路处理
        const srcIndex = source;
        source = null;
        // 外部文件拖入：交给 plugin-upload 与 EditorPane 的 drop 监听（图片落盘那条链）
        if (event.dataTransfer?.types?.includes("Files")) return false;
        const slot = computeDropSlot(view, event.clientX, event.clientY);
        if (slot) {
          moveUnitTo(view.state, (tr) => view.dispatch(tr), srcIndex, slot.insertBefore);
        }
        // ⚠️ 无论是否真的移动都返回 true：这是「手柄拖拽」，结果必须由我们定义。
        // 返回 false 会把 drop 交给 prosemirror-view 的内建路径，而它只搬**单个节点**——
        // 表现就是「拖标题只搬标题」（M8 走查反馈）。
        return true;
      },
    },
  });
});

export const blockDragPlugins = [blockDragPlugin];
