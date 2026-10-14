import { commandsCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $command, $useKeymap } from "@milkdown/kit/utils";

/**
 * 块定位与块移动——**不依赖拖拽**的通路，同时也是拖放的落点实现。
 *
 * 为什么自研：ProseMirror 没有内置的「移动块」命令，而 Crepe 的块移动只走 HTML5 拖拽
 * （`@milkdown/plugin-block` 挂 `dragstart` + ProseMirror `handleDrop`）。两个理由要求
 * 我们接管它（M8 批次 1 实测）：
 *  ① 依赖 ProseMirror 内建的 `view.dragging` 路径时，某些 WebView 上会**退化成复制**：
 *     `view.dragging` 缺失 → 回退到「从 dataTransfer 解析 HTML 再插入」，源块不被删除。
 *  ② 内建路径只搬**一个节点**，而笔记语义要的是「标题 = 一节」（见 `unitLengthAt`）。
 * 所以拖放的最终落点由 `src/milkdown/block-drag.ts` 交给这里的 `moveUnitTo` 执行：
 * 菜单、`Alt-↑/↓`、拖放三条路共用同一个移动原语。
 */

export type BlockMoveDirection = -1 | 1;

/** doc 顶层块的定位结果（`from`/`to` 是它在 doc 中的位置区间） */
export interface TopBlock {
  node: PMNode;
  index: number;
  from: number;
  to: number;
}

/** 取 doc 第 index 个顶层块；越界返回 null */
export function topBlockAt(doc: PMNode, index: number): TopBlock | null {
  if (index < 0 || index >= doc.childCount) return null;
  let from = 0;
  for (let i = 0; i < index; i += 1) from += doc.child(i).nodeSize;
  const node = doc.child(index);
  return { node, index, from, to: from + node.nodeSize };
}

/** 选区所在的顶层块序号；选区不在 doc 的子节点内时返回 null */
export function currentTopBlockIndex(state: EditorState): number | null {
  const { $from } = state.selection;
  if ($from.depth < 1) return null;
  return $from.index(0);
}

/**
 * 「位置 → 顶层块序号」，容错版：位置落在块之间的空隙、或文档最前/最后之外时，
 * 归给**所在或最近**的那一块，而不是放弃。
 *
 * 为什么需要它：右键/长按的探测点常落在段落 margin、容器 padding 这类空档上，
 * `doc.resolve(pos).depth` 会是 0（`currentTopBlockIndex` 于是返回 null）。
 * 实测（`.cache/probe-blockmenu.mjs`）：不兜这一层，正文最上方一行右键打不开块菜单。
 * 语义：取第一个满足 `to > pos` 的块；都不满足（pos 在文档末尾之后）就是最后一块。
 */
export function topBlockIndexAtPos(doc: PMNode, pos: number): number | null {
  if (doc.childCount === 0) return null;
  let from = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    const to = from + doc.child(i).nodeSize;
    if (pos < to) return i;
    from = to;
  }
  return doc.childCount - 1;
}

/**
 * 块的**单元长度**：标题连同它下属的小节，其余块各自为 1。
 *
 * 「标题 = 一节」是笔记软件的通行语义（Notion / Obsidian / 飞书都一样）：拖一个 h2 应当
 * 带走它下面的段落、列表、以及更深层的 h3/h4，直到**下一个同级或更高级**的标题为止。
 * 只有标题有这种「下属内容」，所以其余块一律返回 1。
 */
export function unitLengthAt(doc: PMNode, index: number): number {
  const node = topBlockAt(doc, index)?.node;
  if (!node || node.type.name !== "heading") return 1;
  const level = Number(node.attrs.level ?? 1);
  let length = 1;
  for (let i = index + 1; i < doc.childCount; i += 1) {
    const next = doc.child(i);
    // 同级或更高级的标题 = 新一节的开始，本节到此为止
    if (next.type.name === "heading" && Number(next.attrs.level ?? 1) <= level) break;
    length += 1;
  }
  return length;
}

export interface UnitMovePlan {
  srcFrom: number;
  srcTo: number;
  /** **删除源之后**坐标系里，单元应插入到的块序号 */
  target: number;
}

/**
 * 规划「把 `[srcIndex, srcIndex+length)` 这段单元移到第 `insertBefore` 块之前」。
 *
 * `insertBefore` 用**删除前**的块序号表述（「插到那一块前面」），这样调用方不必先做
 * 坐标换算；越界/落回自身（含紧邻两端）一律返回 null = 不动。
 */
export function planUnitMove(
  doc: PMNode,
  srcIndex: number,
  length: number,
  insertBefore: number,
): UnitMovePlan | null {
  if (length <= 0) return null;
  const head = topBlockAt(doc, srcIndex);
  const tail = topBlockAt(doc, srcIndex + length - 1);
  if (!head || !tail) return null;
  // 落点在源单元自身范围内（含紧邻两端）→ 位置不变
  if (insertBefore >= srcIndex && insertBefore <= srcIndex + length) return null;
  const target = insertBefore > srcIndex ? insertBefore - length : insertBefore;
  if (target < 0 || target > doc.childCount - length) return null;
  return { srcFrom: head.from, srcTo: tail.to, target };
}

/**
 * 上下移动一个单元时的「插到哪一块之前」；无操作返回 null（菜单置灰也用它）。
 *
 * 两种块两种规则：
 *  - **标题**：与**同级**的上一/下一节整体交换。这是唯一不会「悄悄改结构」的走法——
 *    若允许它插进别的节中间（例如把 h2 插到上一节的 h3 之前），那段内容就会改归它管，
 *    语义被偷改。所以扫描时跳过更深的标题，遇到**更高级**的标题就停（说明已经是父节里的
 *    第一节，不能再上移 / 下一节更高级则不能在降级）。
 *  - **非标题**：与相邻块换位（字面「上移/下移一格」），与批次 1 行为一致。
 */
export function unitInsertBefore(
  doc: PMNode,
  index: number,
  dir: BlockMoveDirection,
): number | null {
  if (index < 0 || index >= doc.childCount) return null;
  const node = doc.child(index);

  if (node.type.name === "heading") {
    const level = Number(node.attrs.level ?? 1);
    if (dir === -1) {
      for (let j = index - 1; j >= 0; j -= 1) {
        const prev = doc.child(j);
        if (prev.type.name !== "heading") continue;
        const prevLevel = Number(prev.attrs.level ?? 1);
        if (prevLevel === level) return j; // 同级上一节 → 交换
        if (prevLevel < level) return null; // 更高级 → 已是父节首节，不动
        // 更深 → 属于上一节的内容，跳过
      }
      return index === 0 ? null : 0; // 上方没有任何标题 → 移到最前
    }
    const next = index + unitLengthAt(doc, index);
    if (next >= doc.childCount) return null;
    const nextNode = doc.child(next);
    // next 处必然是 level <= 本节的标题（否则本节还没结束）
    if (nextNode.type.name === "heading" && Number(nextNode.attrs.level ?? 1) < level) {
      return null; // 下一节更高级 → 下移会把它降级，不动
    }
    return next + unitLengthAt(doc, next); // 越过下一节整节 = 与它交换
  }

  if (dir === -1) return index === 0 ? null : index - 1;
  return index + 1 >= doc.childCount ? null : index + 2;
}

/**
 * 执行单元移动，返回**移动后单元的新序号**；无操作返回 null。
 *
 * 事务做法是**先删源、再按删除后的文档重算插入点**，而不是整篇 `replaceWith`——后者会让
 * 位置映射失效、选区找不回来。返回新序号是给块菜单用的：标题移动的是整节，新序号不一定
 * 是 `index ± 1`，菜单据此刷新置灰状态才不会错。
 */
export function moveUnitTo(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  srcIndex: number,
  insertBefore: number,
): number | null {
  const plan = planUnitMove(
    state.doc,
    srcIndex,
    unitLengthAt(state.doc, srcIndex),
    insertBefore,
  );
  if (!plan) return null;
  if (!dispatch) return plan.target; // 仅查询可用性（canExec）
  const content = state.doc.slice(plan.srcFrom, plan.srcTo).content;
  const tr = state.tr.delete(plan.srcFrom, plan.srcTo);
  let insertPos = 0;
  for (let i = 0; i < plan.target; i += 1) insertPos += tr.doc.child(i).nodeSize;
  tr.insert(insertPos, content);
  // 选区落回被移动的单元内（+1 即进入块内容），并滚动到可见
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
  tr.scrollIntoView();
  dispatch(tr);
  return plan.target;
}

/**
 * 触发点（右键 / 长按 / 拖放落点）→ 顶层块序号。
 *
 * 触发点常落在正文之外：左侧槽位（手柄所在的留白）、`.ProseMirror` 自身 padding、手机上
 * 手指偏出文本列——这些位置 `posAtCoords` **直接返回 null**。所以横向出内容列时只按纵向
 * 定位、横向取内容列中线（留白处的语义本来就是「这一行对应的块」）。
 *
 * ⚠️ 块菜单的**命中判定**与这里的**定位**必须同一口径（都用内容列），否则会出现「判定通过
 * 但定位失败 → 点了没反应」。实测数据见 `.cache/probe-blockmenu.mjs`。
 */
export function topBlockIndexFromPoint(
  view: EditorView,
  x: number,
  y: number,
): number | null {
  const rect = view.dom.getBoundingClientRect();
  const cs = getComputedStyle(view.dom);
  const left = rect.left + (parseFloat(cs.paddingLeft) || 0);
  const right = rect.right - (parseFloat(cs.paddingRight) || 0);
  const outsideX = x < left || x > right;
  const coords = view.posAtCoords({
    left: outsideX ? (left + right) / 2 : x,
    top: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
  });
  if (!coords) return null;
  return topBlockIndexAtPos(view.state.doc, coords.pos);
}

function moveBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: BlockMoveDirection,
): boolean {
  const index = currentTopBlockIndex(state);
  if (index === null) return false;
  const insertBefore = unitInsertBefore(state.doc, index, dir);
  if (insertBefore === null) return false;
  return moveUnitTo(state, dispatch, index, insertBefore) !== null;
}

/** 命令载荷：移动方向。缺省/非法载荷一律不动作（不猜方向，避免静默乱移） */
export const moveBlockCommand = $command(
  "MoveBlock",
  () => (dir?: BlockMoveDirection) => (state, dispatch) => {
    if (dir !== 1 && dir !== -1) return false;
    return moveBlock(state, dispatch, dir);
  },
);

/**
 * 快捷键 `Alt-↑` / `Alt-↓`。
 * 选 Alt 而非 `Mod-Shift-↑/↓`：后者在 WebView 里常被浏览器/系统抢走（选区扩到文首文末），
 * Alt+方向键在三大平台上都不是编辑器默认绑定（milkdown 全家也没有占用，已核对）。
 */
export const blockMoveKeymap = $useKeymap("blockMoveKeymap", {
  MoveBlockUp: {
    shortcuts: "Alt-ArrowUp",
    command: (ctx) => () => ctx.get(commandsCtx).call(moveBlockCommand.key, -1),
  },
  MoveBlockDown: {
    shortcuts: "Alt-ArrowDown",
    command: (ctx) => () => ctx.get(commandsCtx).call(moveBlockCommand.key, 1),
  },
});

/** 注册进编辑器的一组插件（见 `product.ts`） */
export const blockMovePlugins = [moveBlockCommand, ...blockMoveKeymap];
