import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

import {
  moveUnitTo,
  topBlockIndexAtPos,
  topBlockIndexFromPoint,
  unitLengthAt,
} from "./block-move";

/**
 * 接管「六个点手柄」拖放的落点（M8 批次 1 修复）。
 *
 * **为什么不让 ProseMirror 内建路径处理**：它靠 `view.dragging`（由 `@milkdown/plugin-block`
 * 在 dragstart 时手动赋值）来决定「移动还是复制」，而这条链在部分 WebView 上会断——断掉后
 * ProseMirror 回退成「从 `dataTransfer` 解析 HTML 再插入」，于是**源块不删、目标处多一份**，
 * 也就是用户报的「拖了变成复制」。两处都不可靠：`view.dragging` 是不是设上了，取决于
 * Crepe 内部 `#createSelection` 与 `NodeSelection.isSelectable` 的细节。
 *
 * 这里改为**自己记录拖拽源**（在 dragstart 上按手柄 DOM 反查块），自己算落点，自己执行
 * `moveUnitTo`。于是：
 *  - 不再依赖 `view.dragging` / `dragCopies` / `node.replace` 任何一环；
 *  - 与菜单、`Alt-↑/↓` 共用同一个移动原语，语义一致（**标题连同整节一起搬**）；
 *  - 行为在 WebKitGTK / WebView2 / Android WebView 上相同。
 *
 * **只认手柄发起的拖拽**：`source` 仅在 dragstart 的 target 落在 `.milkdown-block-handle`
 * 内时才被赋值，所以正文里选中文字拖动、以及外部文件拖入都原样走原有链路（返回 false）。
 */
const blockDragKey = new PluginKey("LANMARK_BLOCK_DRAG");

/** 拖拽源：顶层块序号。null = 当前没有「手柄发起的」拖拽 */
type DragSource = number | null;

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
 * 落点在目标块的**上半区还是下半区** → 插到它前面还是后面（拖到块的下缘就该落到它下面）。
 *
 * 两处非显然的处理：
 *  ① 用 `.ProseMirror` 的**第 index 个直接子元素**拿盒模型，不用 `view.nodeDOM(pos)`——后者
 *     要走一遍「文档位置 → DOM」的推断，在块边界处可能拿不到元素而静默退化成「插到该块之前」。
 *  ② **标题是一节的「头」，落到它下半区就落到整节之后**。否则被移动的单元会插进这个标题和
 *     它的正文之间，那段正文就改归新节管——语义被偷改。实测（.cache/probe-drag.mjs 场景 A）：
 *     不加这条，拖 h1「甲」到 h1「乙」下缘会得到 [乙, 甲节…, 乙的正文]，乙的正文被甲抢走。
 *     非标题目标仍是逐块粒度（`unitLengthAt` 为 1），这样节内段落重排不会被放大成整节跳动。
 */
function dropInsertBefore(view: EditorView, index: number, clientY: number): number {
  const el = view.dom.children.item(index);
  const rect = el instanceof HTMLElement ? el.getBoundingClientRect() : null;
  const lowerHalf = rect ? clientY > rect.top + rect.height / 2 : false;
  if (!lowerHalf) return index;
  return index + unitLengthAt(view.state.doc, index);
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
      if (!root) return {};
      const onDragStart = (event: DragEvent) => {
        const target = event.target as Element | null;
        const handle = target?.closest?.(".milkdown-block-handle");
        source = handle ? sourceIndexFromHandle(view, handle) : null;
      };
      const onDragEnd = () => {
        source = null;
      };
      // 捕获阶段：先于 ProseMirror / Crepe 的处理，避免被它们改写选中态后读到错的块
      root.addEventListener("dragstart", onDragStart, true);
      root.addEventListener("dragend", onDragEnd, true);
      return {
        destroy: () => {
          root.removeEventListener("dragstart", onDragStart, true);
          root.removeEventListener("dragend", onDragEnd, true);
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
        const index = topBlockIndexFromPoint(view, event.clientX, event.clientY);
        if (index === null) return false;
        const insertBefore = dropInsertBefore(view, index, event.clientY);
        // 返回 true 才算「我处理了」——prosemirror-view 会据此 preventDefault 并跳过内建插入
        const moved = moveUnitTo(
          view.state,
          (tr) => view.dispatch(tr),
          srcIndex,
          insertBefore,
        );
        return moved !== null;
      },
    },
  });
});

export const blockDragPlugins = [blockDragPlugin];
