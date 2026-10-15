import type { Ctx } from "@milkdown/kit/ctx";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  blockquoteSchema,
  bulletListSchema,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  listItemSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark";
import { createTable } from "@milkdown/kit/preset/gfm";

import { currentTopBlockIndex, topBlockAt } from "./block-move";

/**
 * 「插入块」——移动端头部「+」菜单的执行层（M8 批次 2）。
 *
 * 与 Crepe 斜杠菜单的**唯一也是关键的区别**：**不要**调 `clearTextInCurrentBlockCommand`。
 * 那条命令会把当前块的文字整段删掉——它在斜杠菜单里是对的（用来抹掉用户敲的 `/h2`），
 * 但我们的菜单是点按钮打开的，**当前块里是用户的正文**，照抄就会删字。
 * 结果上：文本类「转换当前块」（`setBlockTypeCommand` / `wrapInBlockTypeCommand`，保留文字），
 * 块类「新增一块」（`addBlockTypeCommand`）。
 *
 * 逐条的命令组合对齐 Crepe 同版本的斜杠菜单（那是已验证可用的实现），只去掉清字这一条。
 */

export type BlockKind =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  | "divider"
  | "code"
  | "table"
  | "math";

export interface BlockItem {
  kind: BlockKind;
  label: string;
  /** 分组标题（窄屏抽屉里分组显示） */
  group: "文本" | "列表" | "高级";
}

/**
 * 菜单条目（顺序即展示顺序）。**标题只列 1–3**：窄屏抽屉里 h1–h6 六项会把列表撑得很长，
 * 而 h4–h6 在笔记里极少用；需要时按 `Ctrl+1..6`（Milkdown 自带）或源码模式改。
 * 真机走查若发现需要更多级别，再加回来即可。
 */
export const BLOCK_ITEMS: BlockItem[] = [
  { kind: "text", label: "正文", group: "文本" },
  { kind: "h1", label: "一级标题", group: "文本" },
  { kind: "h2", label: "二级标题", group: "文本" },
  { kind: "h3", label: "三级标题", group: "文本" },
  { kind: "quote", label: "引用", group: "文本" },
  { kind: "divider", label: "分割线", group: "文本" },
  { kind: "bullet", label: "无序列表", group: "列表" },
  { kind: "ordered", label: "有序列表", group: "列表" },
  { kind: "task", label: "任务列表", group: "列表" },
  { kind: "code", label: "代码块", group: "高级" },
  { kind: "table", label: "表格", group: "高级" },
  { kind: "math", label: "公式块", group: "高级" },
];

/**
 * 在当前**顶层块之后**插入一个整块，并把光标落到它后面。
 *
 * 为什么不用 `addBlockTypeCommand`（= `replaceSelectionWith`）：那会把**当前块从光标处劈开**。
 * 实测（.cache/probe-insert.mjs）：光标在「你好」中间时插分割线，得到 `你` + `***` + `好`——
 * 用户的正文被切成两半。斜杠菜单里这么干没问题（那是敲了 `/` 的块，本来就该被替换），
 * 但我们的菜单是点按钮打开的，语义是「在下方插入一块」（与桌面 hover「+」一致）。
 */
function insertBlockAfterCurrent(ctx: Ctx, node: PMNode): void {
  const view = ctx.get(editorViewCtx);
  const index = currentTopBlockIndex(view.state);
  const block = index === null ? null : topBlockAt(view.state.doc, index);
  const pos = block ? block.to : view.state.doc.content.size;
  const tr = view.state.tr.insert(pos, node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + node.nodeSize)));
  view.dispatch(tr.scrollIntoView());
}

/** 执行插入。`ctx` 由调用方（EditorPane）在建好编辑器后捕获一次 */
export function insertBlock(ctx: Ctx, kind: BlockKind): void {
  const commands = ctx.get(commandsCtx);
  const heading = (level: number) => ({
    nodeType: headingSchema.type(ctx),
    attrs: { level },
  });

  switch (kind) {
    // ── 文本类：转换当前块，保留文字 ──
    case "text":
      commands.call(setBlockTypeCommand.key, { nodeType: paragraphSchema.type(ctx) });
      return;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      commands.call(setBlockTypeCommand.key, heading(Number(kind[1])));
      return;
    case "code":
      commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx) });
      return;
    case "quote":
      commands.call(wrapInBlockTypeCommand.key, { nodeType: blockquoteSchema.type(ctx) });
      return;
    case "bullet":
      commands.call(wrapInBlockTypeCommand.key, { nodeType: bulletListSchema.type(ctx) });
      return;
    case "ordered":
      commands.call(wrapInBlockTypeCommand.key, { nodeType: orderedListSchema.type(ctx) });
      return;
    case "task":
      commands.call(wrapInBlockTypeCommand.key, {
        nodeType: listItemSchema.type(ctx),
        attrs: { checked: false },
      });
      return;

    // ── 块类：新增一块 ──
    case "divider":
      insertBlockAfterCurrent(ctx, hrSchema.type(ctx).createAndFill()!);
      return;
    case "table":
      insertBlockAfterCurrent(ctx, createTable(ctx, 3, 3));
      return;
    case "math":
      // 块公式在本产品里就是「语言为 LaTeX 的代码块」——与 Crepe 斜杠菜单一致
      insertBlockAfterCurrent(
        ctx,
        codeBlockSchema.type(ctx).createAndFill({ language: "LaTeX" })!,
      );
      return;
    default:
      return;
  }
}
