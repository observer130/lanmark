import { commandsCtx } from "@milkdown/kit/core";
import { Fragment } from "@milkdown/kit/prose/model";
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

/** 块的标题级别（1..6）；**非标题返回 0**（0 是「不是标题」的哨兵，不参与比较） */
export function headingLevelOf(node: PMNode): number {
  if (node.type.name !== "heading") return 0;
  return Math.min(6, Math.max(1, Number(node.attrs.level ?? 1)));
}

/**
 * 第 index 块所属的**最内层上层标题**序号；文首没有标题时返回 null。
 *
 * 「最内层」= 往上第一个标题：正文永远归属离它最近的那个标题（节按就近嵌套）。
 */
export function enclosingHeadingIndex(doc: PMNode, index: number): number | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (doc.child(i).type.name === "heading") return i;
  }
  return null;
}

/**
 * 「插到标题 `headIndex` 之前」这一落点的层级 = 该标题自己的级别（成为它的同级）。
 */
export function siblingSlotLevel(doc: PMNode, headIndex: number): number {
  return headingLevelOf(doc.child(headIndex)) || 1;
}

/**
 * 「放进标题 `headIndex` 这一节」的落点：插到**该节末尾**（下一个同级/更高级标题之前，或文末），
 * 层级 = 该标题级别 + 1。
 *
 * 为什么必须是**节末**而不是紧跟标题之后：后者会把该节原有的正文挤到新区块之下、改归新区块管
 * （markdown 的节由「最近的上层标题」决定，插入标题必然重划边界）。落在节末则原有内容一块不动，
 * 新区块成为该节的**最后一个子节**——这也是文件管理器「拖进文件夹」的语义。
 */
export function intoHeadingSlot(
  doc: PMNode,
  headIndex: number,
): { insertBefore: number; level: number } | null {
  const node = doc.child(headIndex);
  if (node.type.name !== "heading") return null;
  const insertBefore = headIndex + unitLengthAt(doc, headIndex);
  return { insertBefore, level: Math.min(6, headingLevelOf(node) + 1) };
}

/** 文末落点：插到最后一块之后，层级取**最后一个标题的级别**（与它同级，最常见的追加意图） */
export function documentEndSlot(doc: PMNode): { insertBefore: number; level: number } {
  for (let i = doc.childCount - 1; i >= 0; i -= 1) {
    const level = headingLevelOf(doc.child(i));
    if (level > 0) return { insertBefore: doc.childCount, level };
  }
  return { insertBefore: doc.childCount, level: 1 };
}

/** 把单元里的顶层标题整体升降 `delta` 级（夹在 1..6）。非标题原样返回 */
function shiftHeadingLevels(fragment: Fragment, delta: number): Fragment {
  if (delta === 0) return fragment;
  const out: PMNode[] = [];
  fragment.forEach((node: PMNode) => {
    const level = headingLevelOf(node);
    if (level > 0) {
      const next = Math.min(6, Math.max(1, level + delta));
      out.push(node.type.create({ ...node.attrs, level: next }, node.content, node.marks));
    } else {
      out.push(node);
    }
  });
  return Fragment.fromArray(out);
}

/**
 * **大纲刻度起点**：拖拽层级刻度（指示线圆点）以哪一级为第 0 格。
 *
 * 约定是**绝对**的，不看文档里 `#` 的数量：`#` 在笔记里是**文档标题**，`##` 及以下才是分节。
 * 所以起点 = **文档里最浅的「大于 `#`」的那一级**（`##`/`###`… 里最浅的那个）；没有这样的级别
 * （例如全篇只有 `#`）时取 `##`。
 *
 * 两次踩坑记录（别再回到计数判据）：
 *  - 最初用「绝对层级 − 1」当刻度 → `##` 落在第 2 格、圆点明显偏右（走查：视觉误导）。
 *  - 改成「全篇恰好一个 `#` 才算文档标题」→ 用户那篇测试文档里 `# 测试` 与 `# Hello world!`
 *    都是 H1（两个），判据直接不成立，刻度毫无变化（走查：真机验收不通过）。
 * **只要文档里存在 `##` 这一级，`##` 就必须贴内容列左边缘**——这是用户明确的期望，
 * 不该被「`#` 出现了几次」左右。
 */
export function outlineBaseline(doc: PMNode): number {
  let base = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    const level = headingLevelOf(doc.child(i));
    if (level >= 2 && (base === 0 || level < base)) base = level;
  }
  return base === 0 ? 2 : base;
}

/**
 * 某个**行间隙**的天然层级。`gap` 是「插到第 gap 块之前」的块序号（0..childCount）。
 *
 * 这是「每一行之间都能插入」的关键：间隙决定**位置**，间隙决定**层级**，两者都不折叠到节末。
 * 规则只有两条：
 *  - 间隙后面紧跟着标题 M → 与该标题**同级**（M）。这就是「插到两个同级节之间」。
 *  - 间隙后面是正文（或文末）→ 成为**所属节**的子节（P+1）。P = 最近的上层标题。
 *
 * 为什么 P+1 是「吞得最少」的层级：L 层标题的节到「下一个层级 ≤ L 的标题」为止。取 P+1 时，
 * 该节会在下一个比 P 更深的标题处就结束；取 P（同级）则会一直吞到 P 这一节的末尾。
 * **吞并本身无法避免**——把标题插进正文中间，markdown 只能让后面的正文归它管，手打一个
 * 标题在那里也是同样结果。
 */
export function naturalLevelAtGap(doc: PMNode, gap: number): number {
  if (doc.childCount === 0) return 1;
  // **不把层级收口到刻度起点**：那会让「拖动一个已有的 `#` 块」被强制降成 `##`。
  // 刻度只决定「指示线画在哪」（`#` 与 `##` 共用最左格），不改变落点层级本身。
  return rawLevelAtGap(doc, gap);
}

function rawLevelAtGap(doc: PMNode, gap: number): number {
  if (gap >= doc.childCount) return documentEndSlot(doc).level;
  const next = doc.child(Math.max(0, gap));
  if (next.type.name === "heading") return headingLevelOf(next);
  if (gap <= 0) {
    // 文首正文：与后面第一个标题同级
    for (let i = 0; i < doc.childCount; i += 1) {
      const lv = headingLevelOf(doc.child(i));
      if (lv > 0) return lv;
    }
    return 1;
  }
  const owner = enclosingHeadingIndex(doc, gap);
  return owner === null ? 1 : Math.min(6, headingLevelOf(doc.child(owner)) + 1);
}

export interface UnitMovePlan {
  srcFrom: number;
  srcTo: number;
  /** **删除源之后**坐标系里，单元应插入到的块序号 */
  target: number;
  /** 标题层级变化量：0 = 不变，null = 该单元不是标题单元（不调层级） */
  levelDelta: number | null;
}

/**
 * 规划「把 `[srcIndex, srcIndex+length)` 这段单元移到第 `insertBefore` 块之前」。
 *
 * `insertBefore` 用**删除前**的块序号表述（「插到那一块前面」），这样调用方不必先做
 * 坐标换算。`level` 给出目标标题级别（1..6）：标题单元会按差值整体升降，非标题单元忽略它。
 *
 * 两种情况返回 null（= 不动）：位置与层级都没变化。**只变层级也算有效操作**——把一节原地
 * 降级成上一节的子节（Notion 里「往右拖缩进」）就是只改层级。
 */
export function planUnitMove(
  doc: PMNode,
  srcIndex: number,
  length: number,
  insertBefore: number,
  level?: number | null,
): UnitMovePlan | null {
  if (length <= 0) return null;
  const head = topBlockAt(doc, srcIndex);
  const tail = topBlockAt(doc, srcIndex + length - 1);
  if (!head || !tail) return null;
  const headLevel = headingLevelOf(head.node);
  const targetLevel = level != null ? Math.min(6, Math.max(1, level)) : headLevel;
  const levelDelta = headLevel > 0 && level != null ? targetLevel - headLevel : null;
  // 落点在源单元自身范围内（含紧邻两端）→ 位置不变。
  // 这里**不做安全边界吸附**：吸附会把「两行之间」折回该节末尾，等于让整节内容区共用一个
  // 落点（2026-10-13 走查：用户只能拖到标题上方或文末，判定为不可用）。
  const slot = insertBefore;
  const inPlace = slot >= srcIndex && slot <= srcIndex + length;
  if (inPlace) {
    if (levelDelta === null || levelDelta === 0) return null;
    return { srcFrom: head.from, srcTo: tail.to, target: srcIndex, levelDelta };
  }
  const target = slot > srcIndex ? slot - length : slot;
  if (target < 0 || target > doc.childCount - length) return null;
  return { srcFrom: head.from, srcTo: tail.to, target, levelDelta };
}

/**
 * 执行单元移动（含标题层级升降），返回**移动后单元的新序号**；无操作返回 null。
 *
 * 事务做法是**先删源、再按删除后的文档重算插入点**，而不是整篇 `replaceWith`——后者会让
 * 位置映射失效、选区找不回来。返回新序号是给块菜单用的：新序号不一定是 `index ± 1`。
 */
export function moveUnitTo(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  srcIndex: number,
  insertBefore: number,
  level?: number | null,
): number | null {
  const plan = planUnitMove(
    state.doc,
    srcIndex,
    unitLengthAt(state.doc, srcIndex),
    insertBefore,
    level,
  );
  if (!plan) return null;
  if (!dispatch) return plan.target; // 仅查询可用性（canExec）
  const slice = state.doc.slice(plan.srcFrom, plan.srcTo);
  const content = plan.levelDelta
    ? shiftHeadingLevels(slice.content, plan.levelDelta)
    : slice.content;
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
 * 触发点（右键 / 长按 / 拖放落点）→ 顶层块序号。
 *
 * 触发点常落在正文之外：左侧槽位（手柄所在的留白）、`.ProseMirror` 自身 padding、手机上
 * 手指偏出文本列——这些位置 `posAtCoords` **直接返回 null**。所以横向出内容列时只按纵向
 * 定位、横向取内容列中线（留白处的语义本来就是「这一行对应的块」）。
 *
 * ⚠️ 块菜单的**命中判定**与这里的**定位**必须同一口径（都用内容列），否则会出现「判定通过
 * 但定位失败 → 点了没反应」。实测数据见 `.cache/probe-blockmenu.mjs`。
 */
/** 正文**内容列**的左右边界（去掉 `.ProseMirror` 自身 padding）。命中判定、坐标定位、
 *  落点指示线的横向范围都用它——**只能有一份**，否则「判定通过但定位失败」。 */
export function contentColumn(view: EditorView): { left: number; right: number } {
  const rect = view.dom.getBoundingClientRect();
  const cs = getComputedStyle(view.dom);
  return {
    left: rect.left + (parseFloat(cs.paddingLeft) || 0),
    right: rect.right - (parseFloat(cs.paddingRight) || 0),
  };
}

export function topBlockIndexFromPoint(
  view: EditorView,
  x: number,
  y: number,
): number | null {
  const rect = view.dom.getBoundingClientRect();
  const { left, right } = contentColumn(view);
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
