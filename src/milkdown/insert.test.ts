/**
 * M8 批次 2「插入块」的行为护栏。
 *
 * 两条不变量是这一层最容易踩的坑：
 *  ① **不许删用户的字**——Crepe 斜杠菜单每条命令前面都挂了 `clearTextInCurrentBlockCommand`
 *     （用来抹掉用户敲的 `/h2`），照抄就会把当前块的正文整段删掉。
 *  ② **块类不许劈开正文**——`addBlockTypeCommand` = `replaceSelectionWith`，光标在「你好」中间时
 *     会得到 `你` + 块 + `好`。菜单是点按钮打开的、不是敲 `/`，语义应是「在下方插入一块」。
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";

import { createProductCrepe } from "./product";
import { insertBlock, type BlockKind } from "./block-insert";
import { applyHighlightInputRule, highlightSchema } from "./highlight";

/** 建编辑器，把光标放到**末段文字中间**（劈开/删字的问题都只在中段光标下才暴露），返回句柄 */
async function mountWithCaretInLastParagraph(md: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = createProductCrepe({ root, defaultValue: md });
  await crepe.create();
  const ctx = await crepe.editor.action((c) => c);
  const view = await crepe.editor.action((c) => c.get(editorViewCtx));
  const doc = view.state.doc;
  let pos = 0;
  for (let i = 0; i < doc.childCount - 1; i += 1) pos += doc.child(i).nodeSize;
  // pos+1 是末段内容的第一个位置，+2 = 往文字中间挪一个字符
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, pos + 2)));
  const run = (kind: BlockKind) => insertBlock(ctx, kind);
  return { crepe, root, run };
}

const DOC = "# 测试\n\n## 这是二级标题\n\n这是一行文本\n\n你好\n";

describe("插入块（M8 批次 2）", () => {
  it.each([
    ["h1", "# 你好"],
    ["h2", "## 你好"],
    ["h3", "### 你好"],
  ] as [BlockKind, string][])("%s：转换末段为标题且**保留文字**", async (kind, expectLine) => {
    const { crepe, root, run } = await mountWithCaretInLastParagraph(DOC);
    run(kind);
    const out = crepe.getMarkdown();
    expect(out).toContain(expectLine);
    expect(out).toContain("# 测试");
    expect(out).toContain("## 这是二级标题");
    expect(out).toContain("这是一行文本");
    // 一个字都没丢：原来的「你好」仍在
    expect(out).toContain("你好");
    await crepe.destroy();
    root.remove();
  });

  it("引用 / 无序 / 有序 / 任务列表：包住末段且保留文字", async () => {
    for (const [kind, expectLine] of [
      ["quote", "> 你好"],
      ["bullet", "* 你好"],
      ["ordered", "1. 你好"],
      ["task", "* [ ] 你好"],
    ] as [BlockKind, string][]) {
      const { crepe, root, run } = await mountWithCaretInLastParagraph(DOC);
      run(kind);
      const out = crepe.getMarkdown();
      // 列表符号由 Crepe 序列化决定（无序用 *），这里只断言语义
      expect(out.replace(/^[-*] /gm, "* ")).toContain(expectLine.replace(/^[-*] /, "* "));
      await crepe.destroy();
      root.remove();
    }
  });

  it("代码块：转换末段且保留文字", async () => {
    const { crepe, root, run } = await mountWithCaretInLastParagraph(DOC);
    run("code");
    const out = crepe.getMarkdown();
    expect(out).toContain("```");
    expect(out).toContain("你好");
    await crepe.destroy();
    root.remove();
  });

  it.each(["divider", "table", "math"] as BlockKind[])(
    "%s：在当前块**之后**新增一块，**不劈开正文**",
    async (kind) => {
      const { crepe, root, run } = await mountWithCaretInLastParagraph(DOC);
      run(kind);
      const out = crepe.getMarkdown();
      // 关键：末段仍是完整的「你好」，没有被切成「你」「好」两半
      expect(out).toContain("\n你好\n");
      expect(out).not.toMatch(/\n你\n/);
      expect(out).not.toMatch(/\n好\n/);
      // 新块出现在「你好」之后
      const at = out.indexOf("你好");
      const rest = out.slice(at);
      expect(
        kind === "divider" ? rest.includes("***") : kind === "table" ? rest.includes("|") : rest.includes("$$"),
      ).toBe(true);
      await crepe.destroy();
      root.remove();
    },
  );

  it("正文：对已是段落的块是空操作（不产生多余改动）", async () => {
    const { crepe, root, run } = await mountWithCaretInLastParagraph(DOC);
    run("text");
    expect(crepe.getMarkdown()).toBe(DOC);
    await crepe.destroy();
    root.remove();
  });
});

describe("荧光笔输入规则（M8 走查修复：不再借 Milkdown 的 markRule）", () => {
  /**
   * 上游 `markRule` 会算出越界的 `to` 交给 `doc.nodesBetween`，prosemirror-model 直接抛
   * `Cannot read properties of undefined (reading 'nodeSize')`。这条用例钉住「不抛、且 mark 正确」。
   */
  const RE = /(?<![=\w])(==)(?!\s)([^\n]+?)(?<!\s)\1(?![\w=])$/;

  async function setup(text = "前缀") {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const crepe = createProductCrepe({ root, defaultValue: `${text}\n` });
    await crepe.create();
    const ctx = await crepe.editor.action((c) => c);
    const view = await crepe.editor.action((c) => c.get(editorViewCtx));
    const markType = highlightSchema.type(ctx);
    return { crepe, root, view, markType };
  }

  it("正常情形：删掉分隔符、给中间文字加 mark", async () => {
    const { crepe, root, view, markType } = await setup();
    // 模拟「刚输入完 ==高亮==」：先把文本插进文档，再按输入规则的位置调用
    const insertAt = 1 + view.state.doc.child(0).content.size;
    view.dispatch(view.state.tr.insertText("==高亮==", insertAt));
    const text = view.state.doc.textContent;
    const m = RE.exec(text)!;
    const start = 1 + (m.index ?? 0);
    const end = start + m[0].length;
    let threw: unknown = null;
    let tr: unknown = null;
    try {
      tr = applyHighlightInputRule(view.state, m, start, end, markType);
    } catch (e) {
      threw = e;
    }
    expect(threw, `不应抛异常，实际：${String(threw)}`).toBeNull();
    expect(tr).not.toBeNull();
    view.dispatch(tr as never);
    const md = crepe.getMarkdown();
    expect(md).toContain("==高亮==");          // 序列化回原语法
    expect(view.state.doc.textContent).toBe("前缀高亮");
    expect(view.state.doc.textContent).not.toContain("==");
    await crepe.destroy();
    root.remove();
  });

  it("**越界位置一律放弃**（上游就是在这里抛的），不抛异常、不改文档", async () => {
    const { crepe, root, view, markType } = await setup();
    const before = view.state.doc.toJSON();
    for (const [start, end] of [
      [0, 0],
      [1, view.state.doc.content.size + 5],   // end 越界
      [-1, 3],
      [5, 2],                                  // start > end
    ] as [number, number][]) {
      const m = RE.exec("==高亮==");
      let threw: unknown = null;
      let tr: unknown = "skipped";
      try {
        tr = applyHighlightInputRule(view.state, m, start, end, markType);
      } catch (e) {
        threw = e;
      }
      expect(threw, `(${start},${end}) 不应抛异常`).toBeNull();
      expect(tr, `(${start},${end}) 应放弃`).toBeNull();
    }
    expect(view.state.doc.toJSON()).toEqual(before);
    await crepe.destroy();
    root.remove();
  });

  it("代码块内不转换（用父块 spec.code 判，不上上游那套 code-span 判定）", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const crepe = createProductCrepe({ root, defaultValue: "```\n==高亮==\n```\n" });
    await crepe.create();
    const ctx = await crepe.editor.action((c) => c);
    const view = await crepe.editor.action((c) => c.get(editorViewCtx));
    const markType = highlightSchema.type(ctx);
    // 光标放进代码块
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    const m = RE.exec("==高亮==")!;
    const tr = applyHighlightInputRule(view.state, m, 2, 2 + m[0].length, markType);
    expect(tr).toBeNull();
    await crepe.destroy();
    root.remove();
  });
});
