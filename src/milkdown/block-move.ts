import { commandsCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $command, $useKeymap } from "@milkdown/kit/utils";

/**
 * 块移动（上移 / 下移顶层块）——**不依赖拖拽**的第二条路。
 *
 * 为什么自研：ProseMirror 没有内置的「移动块」命令，而 Crepe 的块移动只走 HTML5 拖拽
 * （`@milkdown/plugin-block` 挂 `dragstart` + ProseMirror `handleDrop`）。拖拽在触屏上
 * 根本不工作，在宿主吞掉 HTML5 拖放时也不工作（见 AGENTS.md 关于 `dragDropEnabled`
 * 的硬约定），所以必须有这条不依赖拖放的通路：长按/右键菜单、`Alt-↑/↓` 都走这里。
 *
 * **作用域**：只操作 **doc 的直接子节点**（顶层块）。光标在表格单元格或嵌套列表里时，
 * 移动的是整个表格 / 整个顶层列表——语义可预期，且**绝不会破坏内部结构**。
 * 更细的粒度（列表项、表格行）不在本期范围。
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
 * 规划「把第 index 个顶层块与相邻块交换」：已在首/末则返回 null（无操作）。
 *
 * 事务做法是**先删自己、再插到目标位置**，而不是整篇 `replaceWith`——后者会让整篇的
 * 位置映射失效，选区也就找不回来了。`insertAt` 是**删除 cur 之后**坐标系里的绝对位置：
 *  - 下移：cur 删掉后 other 顶上来，占 `[cur.from, cur.from + other.nodeSize)`，故插到其末尾
 *  - 上移：other 在 cur 之前，删 cur 不影响它，故插到 `other.from`
 */
export function planBlockMove(doc: PMNode, index: number, dir: BlockMoveDirection) {
  const cur = topBlockAt(doc, index);
  const other = topBlockAt(doc, index + dir);
  if (!cur || !other) return null;
  const insertAt = dir === 1 ? cur.from + other.node.nodeSize : other.from;
  return { cur, other, insertAt };
}

function moveBlock(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  dir: BlockMoveDirection,
): boolean {
  const index = currentTopBlockIndex(state);
  if (index === null) return false;
  const plan = planBlockMove(state.doc, index, dir);
  if (!plan) return false;
  if (!dispatch) return true; // 仅查询可用性（canExec）

  const { cur, insertAt } = plan;
  const tr = state.tr.delete(cur.from, cur.to).insert(insertAt, cur.node);
  // 选区落回被移动的块内（+1 即进入块内容），并滚动到可见
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
  tr.scrollIntoView();
  dispatch(tr);
  return true;
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
