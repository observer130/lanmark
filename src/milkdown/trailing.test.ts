/**
 * 尾空段落护栏（2026-10-20 复现）。
 *
 * Crepe 启用了 @milkdown/plugin-trailing：当笔记最后一个顶层块不是 heading/paragraph
 * 时，它会在**第一次事务**（常常只是点进正文的选区事务）往文末插一个空段落。
 * 序列化成 markdown 就是末尾多一个空行——用户看到的是「点一下笔记，文本里自动多了空行」。
 *
 * 这里钉住两件事：
 *  1. 该行为确实存在（防止上游/配置变化后我们误以为已经不用防）；
 *  2. 经过 trimDocTail / compareKey 后，它不得产生任何可落盘差异。
 */
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";

import { compareKey, trimDocTail } from "../lib/markdown-format";
import { createProductCrepe } from "./product";

async function mount(md: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = createProductCrepe({ root, defaultValue: md });
  await crepe.create();
  const view = await crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  return { crepe, root, view };
}

/** 只改选区、不改文档的事务：模拟「点进正文 / 落光标」 */
function selectionOnly(view: Awaited<ReturnType<typeof mount>>["view"]) {
  view.dispatch(view.state.tr.setSelection(view.state.selection));
}

describe("Milkdown trailing 插件的伪空段落", () => {
  it("末尾是列表：首次选区事务会插空段落，但规范化后与原文等价", async () => {
    const md = "* 一\n* 二\n";
    const { crepe, root, view } = await mount(md);
    expect(view.state.doc.childCount).toBe(1);

    selectionOnly(view);
    expect(view.state.doc.childCount).toBe(2);
    const out = crepe.getMarkdown();
    expect(out.endsWith("\n\n")).toBe(true);

    // 关键：保存守卫看到的「规范化内容」必须与原文一致 ⇒ 不写盘
    expect(trimDocTail(out)).toBe(md);
    expect(compareKey(out)).toBe(compareKey(md));

    await crepe.destroy();
    root.remove();
  });

  it("磁盘用 - 列表：编辑器基线必须吸收 * 归一化，否则伪事件仍会置 dirty", async () => {
    const md = "- 一\n- 二\n";
    const { crepe, root, view } = await mount(md);
    const baseline = crepe.getMarkdown(); // EditorPane 建实例后用同一结果当 lastEmitted

    selectionOnly(view);
    const after = crepe.getMarkdown();

    // 编辑器把 - 归一化成 *：拿磁盘原文当基线会误判成「有改动」
    expect(baseline).not.toBe(md);
    expect(compareKey(after)).not.toBe(compareKey(md));
    // 拿编辑器自己的序列化当基线，则只剩尾空行差异 ⇒ 规范化后等价
    expect(compareKey(after)).toBe(compareKey(baseline));

    await crepe.destroy();
    root.remove();
  });

  it("末尾是代码块 / 表格：同样只在规范化前有差异", async () => {
    const cases = ["```js\nconst x = 1;\n```\n", "| a | b |\n| - | - |\n| 1 | 2 |\n"];
    for (const md of cases) {
      const { crepe, root, view } = await mount(md);
      selectionOnly(view);
      expect(compareKey(crepe.getMarkdown())).toBe(compareKey(md));
      await crepe.destroy();
      root.remove();
    }
  });

  it("末尾是段落 / 标题：不插空段落", async () => {
    for (const md of ["甲\n", "# 标题\n"]) {
      const { crepe, root, view } = await mount(md);
      const before = view.state.doc.childCount;
      selectionOnly(view);
      expect(view.state.doc.childCount).toBe(before);
      await crepe.destroy();
      root.remove();
    }
  });
});
