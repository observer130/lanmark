/**
 * 大纲索引 ↔ 编辑器顶层 heading 的对应关系护栏（M10）。
 *
 * `extractOutline` 只认行首 0 空格的 h1–h3；`gotoHeading(index)` 数的是 ProseMirror
 * 顶层 heading 节点。两边一旦漂移，点击目录就会跳到别的标题，或「点了没反应」。
 */
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";

import { extractOutline } from "../lib/outline";
import { createProductCrepe } from "./product";

async function mount(md: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = createProductCrepe({ root, defaultValue: md });
  await crepe.create();
  const view = await crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  return { crepe, root, view };
}

describe("大纲索引与顶层 heading 一一对应", () => {
  it("跳过 h4 / 代码块 / 引用内标题 / 缩进标题，文本与层级一致", async () => {
    const md = [
      "# 一级",
      "",
      "## **粗体**与 `代码`",
      "",
      "### 三级",
      "",
      "#### 四级不列",
      "",
      "```md",
      "## 代码里的假标题",
      "```",
      "",
      "> ## 引用里的标题",
      "",
      "    ## 缩进代码里的标题",
      "",
      "## 结尾",
    ].join("\n");

    const items = extractOutline(md);
    expect(items.map((i) => `${i.level}:${i.text}`)).toEqual([
      "1:一级",
      "2:粗体与 代码",
      "3:三级",
      "2:结尾",
    ]);

    const { crepe, root, view } = await mount(md);
    const headings: { pos: number; level: number; text: string }[] = [];
    let pos = 0;
    for (let i = 0; i < view.state.doc.childCount; i += 1) {
      const node = view.state.doc.child(i);
      if (node.type.name === "heading" && (node.attrs.level as number) <= 3) {
        headings.push({ pos, level: node.attrs.level as number, text: node.textContent });
      }
      pos += node.nodeSize;
    }

    expect(headings).toHaveLength(items.length);
    items.forEach((item, i) => {
      expect(headings[i].level).toBe(item.level);
      expect(headings[i].text).toBe(item.text);
      const dom = view.nodeDOM(headings[i].pos);
      expect(dom).toBeInstanceOf(HTMLElement);
      expect((dom as HTMLElement).tagName).toBe(`H${item.level}`);
    });

    await crepe.destroy();
    root.remove();
  });
});
