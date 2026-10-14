import { NodeSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

import {
  contentColumn,
  headingLevelOf,
  intoHeadingSlot,
  moveUnitTo,
  naturalLevelAtGap,
  outlineBaseline,
  planUnitMove,
  topBlockIndexAtPos,
  topBlockIndexFromPoint,
  unitLengthAt,
} from "./block-move";

/**
 * 接管「六个点手柄」的拖放：**落点判定（含层级）+ 落点指示线 + 执行移动与升降级**。
 *
 * ## 落点 = 行间隙；层级 = 该间隙的天然层级
 * 标题单元（拖一个标题会带走整节）的落点就是**两个顶层块之间的间隙**，上半区插到该行之前、
 * 下半区插到该行之后——**每一行之间都能插入**，绝不折叠到节末。
 *
 * ⚠️ 早期版本把「非标题块」的落点折叠到所属节末尾（理由是「插入标题必然把后面内容划进新节」），
 * 结果整节内容区共用一个落点：一篇「H1 + 两个 H2」的文档里，除标题行外全部指向文末，用户只能
 * 拖到两处（2026-10-13 走查判定不可用）。**吞并是 markdown 的固有语义**（手打一个标题在那里
 * 也一样），不该用牺牲落点精度来回避；层级取 `naturalLevelAtGap` = 该间隙下**吞得最少**的层级。
 *
 * **主动作**：落在标题**下半区** = 放进该节**末尾**、成为它的最后一个子节（降一级，**整块高亮
 * 该标题**）。落在节末而不是紧跟标题之后，是为了不把该节原有正文挤到新区块之下。
 *
 * 于是三种常见操作各有明确手势：同级重排 / 插到两行之间（落间隙）、降级并入某节（落标题下沿）、
 * 升级拖出（落到更高级标题所在的行间隙）。**不做横向拖动映射层级**——本编辑器标题不缩进，
 * 横向只能是武断的像素阶梯，且手柄在左侧、指针自然落在右侧，会导致「永远最深层级」。
 *
 * ## 为什么不让 ProseMirror 内建路径处理
 * ① 内建路径靠 `view.dragging` 决定「移动还是复制」，这条链在部分 WebView 上会断，断掉后它
 * 回退成「从 `dataTransfer` 解析 HTML 再插入」→ 源块不删、目标处多一份（用户报的「拖了变成
 * 复制」）。② 内建路径**只搬一个节点**。所以本插件一旦认定「这是手柄拖拽」就必须自己给出结论
 * （含「不动」），**绝不能 return false 交回去**——交回去就是「拖标题只搬标题」。
 *
 * ## 落点指示线
 * 线的位置 = 真正的插入点；**左端缩进 + 圆点横向位置 = 落点层级**（以 `outlineBaseline` 为第 0 格，
 * 层级越深越靠右）；
 * 「放进某节」时该节标题整块高亮。线与落位共用同一个 `computeDropSlot`：**线画在哪就必须落在哪**。
 * 算出来是「不动」时不画线，让「这里放不下」也有反馈。
 */
const blockDragKey = new PluginKey("LANMARK_BLOCK_DRAG");

/** 每深一级，指示线左端与圆点右移的像素数 */
const INDENT_PX = 22;

/** 拖拽源：顶层块序号。null = 当前没有「手柄发起的」拖拽 */
type DragSource = number | null;

interface DropSlot {
  /** 插到第几块之前（用**删除源之前**的块序号） */
  insertBefore: number;
  /** 目标标题层级；null = 不调层级（拖的不是标题单元） */
  level: number | null;
  /** 「放进某节」时的父标题序号（用于高亮）；null = 不放进任何节 */
  parentIndex: number | null;
  /** 指示线的视口几何（left 已按层级缩进） */
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

function computeDropSlot(
  view: EditorView,
  clientX: number,
  clientY: number,
  srcIndex: number,
): DropSlot | null {
  const doc = view.state.doc;
  if (srcIndex < 0 || srcIndex >= doc.childCount) return null;
  const col = contentColumn(view);
  const kids = view.dom.children;
  const rectOf = (i: number): DOMRect | null => {
    const el = kids.item(i);
    return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
  };
  // 刻度起点 = 大纲最外层分节级别（`#` 是文档标题时从 `##` 起算），见 outlineBaseline
  const baseline = outlineBaseline(doc);
  const inset = (level: number) => col.left + Math.max(0, level - baseline) * INDENT_PX;
  const index = topBlockIndexFromPoint(view, clientX, clientY);
  if (index === null) return null;
  const targetRect = rectOf(index);
  if (!targetRect) return null;
  /**
   * 落点指示线的纵向位置：画在**它将要插入的那一块的顶边**上（`gap === childCount` 时取末块底边）。
   * 不用「上一块的底边」——标题自带 24px 下边距，那条线会浮在空白区上方约一行，指不准。
   */
  const gapY = (gap: number) =>
    gap < doc.childCount
      ? (rectOf(gap) ?? targetRect).top
      : (rectOf(doc.childCount - 1) ?? targetRect).bottom;
  const lowerHalf = clientY > targetRect.top + targetRect.height / 2;
  const target = doc.child(index);
  const unitLength = unitLengthAt(doc, srcIndex);
  const isHeadingUnit = headingLevelOf(doc.child(srcIndex)) > 0;

  // 非标题单元：逐块移动，不涉及层级（它自己不含标题，插到哪都不会改结构）
  if (!isHeadingUnit) {
    const gap = lowerHalf ? index + unitLengthAt(doc, index) : index;
    const y = gapY(gap);
    return { insertBefore: gap, level: null, parentIndex: null, y, left: col.left, right: col.right };
  }

  // ── 标题单元 ──
  // 主动作：落在标题**下半区** = 放进这一节的**末尾**，成为它的最后一个子节。
  // 落在节末而不是紧跟标题之后，是为了不把该节原有正文挤到新区块之下（那才是真的改结构）。
  if (target.type.name === "heading" && lowerHalf) {
    const slot = intoHeadingSlot(doc, index);
    if (!slot) return null;
    return {
      ...slot,
      parentIndex: index,
      y: gapY(slot.insertBefore),
      left: inset(slot.level),
      right: col.right,
    };
  }

  // 其余情况 = 落在某个**行间隙**上：上半区插到该行之前、下半区插到该行之后。
  // 「每一行之间都能插入」就是这一条——不折叠到节末。层级取该间隙的天然层级。
  const gap = lowerHalf ? index + 1 : index;
  // 落在自己身上（自己这一节的范围之内）→ 不动，避免拖歪一点就被降级
  if (gap >= srcIndex && gap <= srcIndex + unitLength) return null;
  const level = naturalLevelAtGap(doc, gap);
  const y = gapY(gap);
  return { insertBefore: gap, level, parentIndex: null, y, left: inset(level), right: col.right };
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
      let litParent: HTMLElement | null = null;

      const clearParent = () => {
        litParent?.classList.remove("lanmark-drop-parent");
        litParent = null;
      };
      const hideLine = () => {
        line.hidden = true;
        lastPoint = null;
        clearParent();
      };

      /** 只有「会真的改变结果」才画线：「原地不动且层级不变」不画，让无操作也有反馈 */
      const paintLine = (clientX: number, clientY: number) => {
        if (source === null) return hideLine();
        lastPoint = { x: clientX, y: clientY };
        const slot = computeDropSlot(view, clientX, clientY, source);
        if (!slot) return hideLine();
        const plan = planUnitMove(
          view.state.doc,
          source,
          unitLengthAt(view.state.doc, source),
          slot.insertBefore,
          slot.level,
        );
        if (!plan) return hideLine();
        line.hidden = false;
        line.style.top = `${slot.y}px`;
        line.style.left = `${slot.left}px`;
        line.style.width = `${Math.max(0, slot.right - slot.left)}px`;
        clearParent();
        if (slot.parentIndex !== null) {
          const el = view.dom.children.item(slot.parentIndex);
          if (el instanceof HTMLElement) {
            el.classList.add("lanmark-drop-parent");
            litParent = el;
          }
        }
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
        const slot = computeDropSlot(view, event.clientX, event.clientY, srcIndex);
        if (slot) {
          moveUnitTo(
            view.state,
            (tr) => view.dispatch(tr),
            srcIndex,
            slot.insertBefore,
            slot.level,
          );
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
