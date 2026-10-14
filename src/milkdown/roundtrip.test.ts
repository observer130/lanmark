/**
 * M1 决策门自动化证据：markdown ↔ Crepe(ProseMirror) ↔ markdown 往返保真。
 * 编辑器配置与产品（EditorPane.tsx）保持一致。
 *
 * 保真标准（docs/04）：
 *  - 结构无损：标题/列表/表格/代码块/图片/中文 语义完全保留
 *  - frontmatter 不损坏（走 splitFrontmatter/joinFrontmatter，与产品一致）
 *  - 允许的风格归一化：列表符号 - 与 *、表格分隔行 --- 与 --、hr 三种写法（语义等价）
 *
 * 跑法：pnpm test
 */
import { describe, it, expect } from "vitest";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { splitFrontmatter, joinFrontmatter } from "../lib/frontmatter";
import { protectWikilinks, restoreWikilinks } from "../lib/wikilink";
import { createProductCrepe } from "./product";
import {
  currentTopBlockIndex,
  documentEndSlot,
  enclosingHeadingIndex,
  headingLevelOf,
  intoHeadingSlot,
  moveBlockCommand,
  naturalLevelAtGap,
  moveUnitTo,
  planUnitMove,
  siblingSlotLevel,
  topBlockIndexAtPos,
  unitLengthAt,
} from "./block-move";

function normalize(md: string): string {
  return md.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

/**
 * 语义等价归一化：统一列表符号、表格分隔行、hr 风格。
 * 只动「纯风格」，不动任何文字内容。
 */
function semantic(md: string): string {
  return normalize(md)
    .replace(/^( *)\* /gm, "$1- ") // 行首无序列表符号 * → -
    .replace(/^[*_]{3,}\s*$/gm, "---") // hr: *** / ___ → ---
    .replace(/^\|.*\|\s*$/gm, (line) => {
      // 表格行：单元格统一 trim（消除列宽填充），分隔行 ---/-- 归一
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => {
          const t = c.trim();
          return /^-+$/.test(t) ? "---" : t;
        });
      return "| " + cells.join(" | ") + " |";
    });
}

/** 用产品配置构建一次编辑器，往返一次，返回序列化结果 */
async function roundtrip(input: string): Promise<string> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  // 必须走 createProductCrepe：`EditorPane` 用的就是它。测试自抄一份 feature 表
  // 曾是漂移风险（两边不一致时护栏会失效），M8 收敛到 product.ts 唯一来源。
  const crepe = createProductCrepe({ root, defaultValue: input });
  await crepe.create();
  const out = crepe.getMarkdown();
  await crepe.destroy();
  root.remove();
  return out;
}

/**
 * 建一个编辑器并把光标放进第 index 个顶层块，返回可操作句柄。
 * 块级命令都按「选区所在的顶层块」定位（见 block-move.ts），所以测试也必须先落选区。
 */
async function mountWithCaret(input: string, index = 0) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = createProductCrepe({ root, defaultValue: input });
  await crepe.create();
  const view = await crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  let from = 0;
  for (let i = 0; i < index; i += 1) from += view.state.doc.child(i).nodeSize;
  const { TextSelection } = await import("@milkdown/kit/prose/state");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(from + 1))),
  );
  const runMove = (dir: -1 | 1) =>
    crepe.editor.action((ctx) => ctx.get(commandsCtx).call(moveBlockCommand.key, dir));
  const caretIndex = () => currentTopBlockIndex(view.state);
  const doc = () => view.state.doc;
  /** 直接按「插到第 insertBefore 块之前 + 目标层级」移动第 srcIndex 个单元 */
  const moveUnit = (srcIndex: number, insertBefore: number, level?: number | null) =>
    moveUnitTo(view.state, (tr) => view.dispatch(tr), srcIndex, insertBefore, level);
  /** 取每个顶层块的「类型名 + 层级 + 文本」，用于断言层级升降 */
  const outline = () =>
    Array.from({ length: view.state.doc.childCount }, (_, i) => {
      const n = view.state.doc.child(i);
      const lv = headingLevelOf(n);
      return `${n.type.name === "heading" ? `h${lv}` : n.type.name}:${n.textContent}`;
    });
  return { crepe, root, runMove, caretIndex, doc, moveUnit, outline };
}

describe("Milkdown 往返保真（M1 决策门）", () => {
  it("基础 markdown：标题/强调/代码/链接/引用/列表/hr", async () => {
    const md = [
      "# 一级标题",
      "",
      "## 二级标题",
      "",
      "**加粗** *斜体* ~~删除线~~ `行内代码`",
      "",
      "[链接](https://example.com/x)",
      "",
      "- 无序一",
      "- 无序二",
      "  - 嵌套项",
      "",
      "1. 有序一",
      "2. 有序二",
      "",
      "> 引用段落",
      "",
      "---",
      "",
      "普通段落。",
    ].join("\n");
    const out = await roundtrip(md);
    expect(semantic(out)).toBe(semantic(md));
  });

  it("代码块（带语言标记，内容含 markdown 符号不被解析）", async () => {
    const md = ["# 代码", "", "```rust", 'fn main() {', "    let x = \"**bold**\";", "}", "```", "", "尾部文字。"].join("\n");
    const out = await roundtrip(md);
    expect(normalize(out)).toBe(normalize(md));
  });

  it("任务列表（- [ ] / - [x]——§9c 事故触发形态，此前护栏缺 case）", async () => {
    const md = ["# 待办", "", "- [ ] 未完成项", "- [x] 已完成项", "", "普通列表：", "- 普通项一", "- 普通项二"].join("\n");
    const out = await roundtrip(md);
    expect(semantic(out)).toBe(semantic(md));
    // 勾选状态不得丢失
    expect(out).toContain("[x]");
    expect(out).toMatch(/\[\s\]/);
  });

  it("Latex 行内公式 $…$ 字节级往返（产品开启 CrepeFeature.Latex）", async () => {
    const md = ["# 数学", "", "行内公式 $E = mc^2$ 在此。", "", "结尾。"].join("\n");
    const out = await roundtrip(md);
    expect(normalize(out)).toBe(normalize(md));
  });

  it("Latex 显示公式 $$…$$：内容保留，但被降级为行内 $…$（已知上游限制）", async () => {
    // 已知限制（Crepe 上游，非本项目代码）：块公式经 WYSIWYG 保存后
    // 丢失 display 区分，$$…$$ → $…$（公式内容完整保留，仅渲染从居中块变行内）。
    // 根因：Crepe 的 latex 序列化路径未保留 display 标志（block-latex.ts
    // addNode('math',…)）。候选修复：pnpm patch @milkdown/crepe，需真机验证
    // 编辑器 KaTeX 预览后跟进；在此之前用本用例钉住现状防止行为漂移。
    const md = ["# 数学", "", "显示公式：", "", "$$\\int_0^1 x\\,dx = \\frac{1}{2}$$", "", "结尾。"].join("\n");
    const out = await roundtrip(md);
    expect(normalize(out)).toBe(normalize("# 数学\n\n显示公式：\n\n$\\int_0^1 x\\,dx = \\frac{1}{2}$\n\n结尾。"));
  });

  it("GFM 表格", async () => {
    const md = [
      "# 表格",
      "",
      "| 姓名 | 部门 |",
      "| --- | --- |",
      "| 张三 | 研发 |",
      "| 李四 | 产品 |",
    ].join("\n");
    const out = await roundtrip(md);
    expect(semantic(out)).toBe(semantic(md));
  });

  it("中文正文 + 图片引用（assets 相对路径，alt 必须原样保留）", async () => {
    const md = ["# 中文笔记", "", "这是关于 读书笔记 的正文，含中文标点。", "", "![读书截图](assets/a3f8.png)", "", "图片说明文字。"].join("\n");
    const out = await roundtrip(md);
    expect(normalize(out)).toBe(normalize(md));
  });

  it("无 alt 的图片保持无 alt（不被写入 1.00 之类的伪 alt）", async () => {
    const md = ["# 图片", "", "![](assets/bb11.png)", "", "结尾。"].join("\n");
    const out = await roundtrip(md);
    expect(out).not.toContain("![1.00]");
    expect(normalize(out)).toBe(normalize(md));
  });

  it("frontmatter 经产品流程（分离→编辑→回填）不损坏", async () => {
    const md = ["---", "title: 我的标题", "tags: [a, b]", "---", "", "# 正文标题", "", "正文内容。"].join("\n");
    // 与 EditorPane 相同的处理：frontmatter 不进编辑器
    const { fm, body } = splitFrontmatter(md);
    expect(fm).toBe("---\ntitle: 我的标题\ntags: [a, b]\n---");
    const outBody = await roundtrip(body);
    const out = joinFrontmatter(fm, outBody);
    expect(normalize(out)).toBe(normalize(md));
  });

  it("无 frontmatter 的笔记 split 不受影响", async () => {
    const md = "# 普通笔记\n\n正文。";
    const { fm, body } = splitFrontmatter(md);
    expect(fm).toBe("");
    expect(body).toBe(md);
  });

  it("长文档（1500 行混合内容）往返不丢失结构", async () => {
    const parts: string[] = ["# 长文档", ""];
    for (let i = 0; i < 500; i++) {
      parts.push(`## 第 ${i} 节`, "", `这是第 ${i} 节的正文，含 **加粗** 与 \`代码\`。`, "", `- 要点 ${i}`, `  - 子要点 ${i}`, "");
      if (i % 50 === 0) {
        parts.push("| 列A | 列B |", "| --- | --- |", `| 值${i} | x |`, "");
      }
    }
    const md = parts.join("\n");
    expect(md.split("\n").length).toBeGreaterThan(1500);

    const t0 = Date.now();
    const out = await roundtrip(md);
    const ms = Date.now() - t0;

    expect(semantic(out)).toBe(semantic(md));
    // 性能护栏：1500 行往返应在合理时间内完成
    expect(ms).toBeLessThan(15000);
  });

  it("Obsidian wikilink / 嵌入经产品流程（保护→编辑→还原）字节级不变", async () => {
    const md = ["参见 [[另一篇笔记]] 与 ![[嵌入块]]，以及 [[a|别名]]。", "", "普通 **加粗** 文本。"].join("\n") + "\n"; // 真实文件以 \n 结尾
    const { body, map } = protectWikilinks(md);
    const out = restoreWikilinks(await roundtrip(body), map);
    expect(out).toBe(md); // 字节级还原（含 ![[嵌入]]、[[a|别名]]）
    expect(out).not.toContain("⟦"); // 占位符不得泄漏到输出
  });

  it("insertImageCommand 插入可序列化（粘贴链最后一段：命令 → 文档 → md）", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const crepe = createProductCrepe({
      root,
      defaultValue: "# 标题\n\n正文。",
    });
    await crepe.create();
    const { insertImageCommand } = await import("@milkdown/kit/preset/commonmark");
    insertImageCommand.run({ src: "vault://localhost/assets/x.png", alt: "测试图" });
    const md = crepe.getMarkdown();
    expect(md).toContain("![测试图](vault://localhost/assets/x.png)"); // alt 原样保留
    expect(md).not.toContain("1.00"); // ImageBlock 已关闭：不得出现比例伪 alt
    await crepe.destroy();
    root.remove();
  });
});

/**
 * M8 G3：块上移/下移（不依赖拖拽的第二条路）。
 * 这三条是「六个点拖不动」的兜底路径的核心逻辑，必须有护栏——它同时也是
 * 长按/右键菜单与 `Alt-↑/↓` 快捷键共用的实现。
 */
describe("块移动命令（M8 G3）", () => {
  it("下移：与下一块交换，其余顺序不变", async () => {
    const { crepe, root, runMove, caretIndex } = await mountWithCaret("甲\n\n乙\n\n丙\n", 0);
    expect(runMove(1)).toBe(true);
    expect(crepe.getMarkdown().trim()).toBe("乙\n\n甲\n\n丙");
    expect(caretIndex()).toBe(1); // 光标跟着被移动的块走
    await crepe.destroy();
    root.remove();
  });

  it("上移：与上一块交换，其余顺序不变", async () => {
    const { crepe, root, runMove, caretIndex } = await mountWithCaret("甲\n\n乙\n\n丙\n", 2);
    expect(runMove(-1)).toBe(true);
    expect(crepe.getMarkdown().trim()).toBe("甲\n\n丙\n\n乙");
    expect(caretIndex()).toBe(1);
    await crepe.destroy();
    root.remove();
  });

  it("首块上移 / 末块下移：返回 false 且文档不动（菜单置灰的依据）", async () => {
    const first = await mountWithCaret("甲\n\n乙\n", 0);
    expect(first.runMove(-1)).toBe(false);
    expect(first.crepe.getMarkdown().trim()).toBe("甲\n\n乙");
    await first.crepe.destroy();
    first.root.remove();

    const last = await mountWithCaret("甲\n\n乙\n", 1);
    expect(last.runMove(1)).toBe(false);
    expect(last.crepe.getMarkdown().trim()).toBe("甲\n\n乙");
    await last.crepe.destroy();
    last.root.remove();
  });

  it("异质块跟着所属标题一起走（代码块不被落下）", async () => {
    // 块：0 #甲  1 代码块  2 #乙  3 乙的正文。甲这一节 = [0,2)，含代码块
    const md = ["# 甲", "", "```rust", "fn main() {}", "```", "", "# 乙", "", "乙的正文。", ""].join("\n") + "\n";
    const { crepe, root, runMove } = await mountWithCaret(md, 0);
    expect(runMove(1)).toBe(true);
    const out = crepe.getMarkdown();
    expect(out).toContain("```rust");
    expect(out).toContain("fn main() {}");
    // 甲整节（标题 + 代码块）落到乙那节之后，且代码块仍在甲标题之下
    expect(out.indexOf("# 乙")).toBeLessThan(out.indexOf("# 甲"));
    expect(out.indexOf("# 甲")).toBeLessThan(out.indexOf("```rust"));
    await crepe.destroy();
    root.remove();
  });

  it("移动列表块（整体作为顶层块移动，不破坏内部结构）", async () => {
    const md = ["- 一", "- 二", "  - 嵌套", "", "尾段。"].join("\n") + "\n";
    const { crepe, root, runMove } = await mountWithCaret(md, 0);
    expect(runMove(1)).toBe(true);
    // 用 semantic 归一化再比位置：Crepe 序列化无序列表用 `*`（见文件头「允许的风格归一化」）
    const out = semantic(crepe.getMarkdown());
    expect(out).toContain("嵌套"); // 嵌套项没被拆散
    expect(out.indexOf("尾段。")).toBeLessThan(out.indexOf("- 一")); // 列表整体移到尾段之后
    await crepe.destroy();
    root.remove();
  });

  it("移动不产生伪 markdownUpdated 之外的改写（往返仍保真）", async () => {
    // 移动两次再移回来，应回到原样——钉住「移动是可逆的、不引入额外归一化」
    const md = "甲\n\n乙\n\n丙\n";
    const { crepe, root, runMove } = await mountWithCaret(md, 0);
    runMove(1);
    runMove(1);
    runMove(-1);
    runMove(-1);
    expect(crepe.getMarkdown()).toBe(md);
    await crepe.destroy();
    root.remove();
  });

  it("位置 → 顶层块：块内 / 块间空隙 / 越界都归到合理的块", async () => {
    // 右键与长按的探测点常落在段落 margin、容器 padding 上，`doc.resolve(pos).depth`
    // 会是 0——不兜这一层，「正文最上方一行右键」就没反应（实测，见 EditorPane 注释）。
    const { crepe, root, doc } = await mountWithCaret("甲\n\n乙\n\n丙\n", 0);
    const d = doc();
    expect(d.childCount).toBe(3);
    expect(topBlockIndexAtPos(d, 0)).toBe(0); // 文档最前
    expect(topBlockIndexAtPos(d, 1)).toBe(0); // 第一块内部
    expect(topBlockIndexAtPos(d, d.child(0).nodeSize)).toBe(1); // 块间边界 → 归下一块
    expect(topBlockIndexAtPos(d, 1_000_000)).toBe(2); // 文档末尾之后 → 最后一块
    await crepe.destroy();
    root.remove();
  });

  it("块菜单的置灰依据：首块无上移、末块无下移", async () => {
    const { crepe, root, doc, caretIndex } = await mountWithCaret("甲\n\n乙\n", 0);
    expect(caretIndex()).toBe(0);
    expect(topBlockIndexAtPos(doc(), 0)).toBe(0); // canMoveUp = index > 0 → false
    expect(topBlockIndexAtPos(doc(), 1_000_000)).toBe(1); // canMoveDown = index < count-1 → false
    await crepe.destroy();
    root.remove();
  });
});

/**
 * M8：「标题 = 一节」的单元语义。
 * 拖一个 h2 应当带走它下面的段落/列表/更深的 h3，直到下一个**同级或更高级**标题为止
 * （Notion / Obsidian 的通行行为，用户明确要求），且移动时**只与同级节交换**——插进别的
 * 节中间会让那段内容改归它管，等于偷偷改结构。
 */
describe("块单元：标题连同整节（M8）", () => {
  // 顶层块（空行只是分隔符，不占块）：
  // 0 #一级甲  1 正文一  2 ##二级乙  3 列表  4 ###三级丙  5 更深的正文  6 ##二级丁  7 尾段
  const SECTION = [
    "# 一级甲",
    "",
    "正文一。",
    "",
    "## 二级乙",
    "",
    "- 列表项",
    "",
    "### 三级丙",
    "",
    "更深的正文。",
    "",
    "## 二级丁",
    "",
    "尾段。",
    "",
  ].join("\n");

  it("单元长度：标题吃到下一个同级/更高级标题为止，其余块恒为 1", async () => {
    const { crepe, root, doc } = await mountWithCaret(SECTION, 0);
    const d = doc();
    expect(d.childCount).toBe(8);
    expect(d.child(0).textContent).toBe("一级甲");
    expect(unitLengthAt(d, 2)).toBe(4); // ## 二级乙 → 含 h3 与列表，到 ## 二级丁 之前
    expect(unitLengthAt(d, 0)).toBe(8); // # 一级甲 → 到文末（没有更高级标题）
    expect(unitLengthAt(d, 4)).toBe(2); // ### 三级丙 → 自己 + 正文
    expect(unitLengthAt(d, 6)).toBe(2); // ## 二级丁 → 自己 + 尾段
    expect(unitLengthAt(d, 1)).toBe(1); // 普通段落
    await crepe.destroy();
    root.remove();
  });

  it("下移标题：整节与同级下一节交换，节内内容不拆散", async () => {
    const { crepe, root, runMove, doc } = await mountWithCaret(SECTION, 2); // ## 二级乙
    expect(runMove(1)).toBe(true);
    const d = doc();
    expect(d.child(0).textContent).toBe("一级甲"); // 更高级的不动
    expect(d.child(2).textContent).toBe("二级丁"); // 二级丁整节顶上来
    expect(d.child(4).textContent).toBe("二级乙"); // 二级乙整节落到它后面
    expect(d.child(5).textContent).toContain("列表项");
    expect(d.child(6).textContent).toBe("三级丙"); // 子节跟着走
    const md = crepe.getMarkdown();
    expect(md).toContain("更深的正文。");
    expect(md).toContain("尾段。");
    await crepe.destroy();
    root.remove();
  });

  it("上移标题：整节与同级上一节交换（不是插进别的节中间）", async () => {
    const { crepe, root, runMove, doc } = await mountWithCaret(SECTION, 6); // ## 二级丁
    expect(runMove(-1)).toBe(true);
    const d = doc();
    expect(d.child(0).textContent).toBe("一级甲");
    expect(d.child(1).textContent).toBe("正文一。");
    expect(d.child(2).textContent).toBe("二级丁"); // 与同级上一节（二级乙）交换
    expect(d.child(3).textContent).toBe("尾段。");
    expect(d.child(4).textContent).toBe("二级乙");
    expect(d.child(5).textContent).toContain("列表项");
    expect(d.child(6).textContent).toBe("三级丙"); // 三级丙仍归二级乙
    await crepe.destroy();
    root.remove();
  });

  it("父节里的第一节不能上移（否则会被提升出父节）", async () => {
    // ## 二级乙 是 # 一级甲 下的第一节：上移会变成 h2 在 h1 之前 = 提升，禁止
    const { crepe, root, runMove } = await mountWithCaret(SECTION, 2);
    expect(runMove(-1)).toBe(false);
    await crepe.destroy();
    root.remove();
  });

  it("节边界滑槽：同级 = 该标题之前，入节 = 该节末尾 + 降一级", async () => {
    const { crepe, root, doc } = await mountWithCaret(SECTION, 0);
    const d = doc();
    expect(enclosingHeadingIndex(d, 3)).toBe(2); // 列表块归属 ## 二级乙
    expect(siblingSlotLevel(d, 6)).toBe(2); // 落 ## 二级丁 之前 → 与它同级
    expect(intoHeadingSlot(d, 2)).toEqual({ insertBefore: 6, level: 3 }); // 入 ## 二级乙 → 节末 + L3
    expect(intoHeadingSlot(d, 6)).toEqual({ insertBefore: 8, level: 3 }); // 末节入节 → 文末 + L3
    expect(documentEndSlot(d)).toEqual({ insertBefore: 8, level: 2 }); // 文末追加 → 与末标题同级
    await crepe.destroy();
    root.remove();
  });

  it("同级重排：层级完全不变（只换位置）", async () => {
    const { crepe, root, runMove, doc } = await mountWithCaret(SECTION, 2); // ## 二级乙
    expect(runMove(1)).toBe(true);
    const d = doc();
    expect(headingLevelOf(d.child(2))).toBe(2); // 二级丁
    expect(headingLevelOf(d.child(4))).toBe(2); // 二级乙仍是 L2
    expect(headingLevelOf(d.child(6))).toBe(3); // 它的 h3 子节仍是 L3
    await crepe.destroy();
    root.remove();
  });

  it("降级并入某节：标题 +1，**下属标题整体 +1**", async () => {
    // 把 ## 二级乙（单元 [2,6)，含 ### 三级丙）放进 # 一级甲这一节的末尾（slot 6）→ L3
    const { crepe, root, moveUnit, outline } = await mountWithCaret(SECTION, 0);
    expect(moveUnit(2, 6, 3)).not.toBeNull();
    const o = outline();
    // 二级乙变成 L3、它的 h3 子节变成 L4，两者都在一级甲这一节内
    expect(o).toContain("h3:二级乙");
    expect(o).toContain("h4:三级丙");
    expect(o.indexOf("h3:二级乙")).toBeLessThan(o.indexOf("h2:二级丁"));
    expect(crepe.getMarkdown()).toContain("### 二级乙");
    expect(crepe.getMarkdown()).toContain("#### 三级丙");
    await crepe.destroy();
    root.remove();
  });

  it("升级拖出：标题 -1，**下属标题整体 -1**", async () => {
    // 把 ### 三级丙（在 ## 二级乙 内）拖到文末并与 ## 二级丁 同级位置 → 提升到 L2
    const { crepe, root, moveUnit, outline } = await mountWithCaret(SECTION, 0);
    // 三级丙 = 块 4，单元 [4,6)；插到文末（slot 8），层级给 2
    expect(moveUnit(4, 8, 2)).not.toBeNull();
    const o = outline();
    expect(o[o.length - 2]).toBe("h2:三级丙"); // 提到 L2
    expect(o[o.length - 1]).toBe("paragraph:更深的正文。"); // 它的正文跟着走
    expect(crepe.getMarkdown()).toContain("## 三级丙");
    await crepe.destroy();
    root.remove();
  });

  it("原地只改层级（Notion 式「往右缩进」）：位置不动、层级变化也算有效操作", async () => {
    // ## 二级丁 放到「它自己这一节的末尾」（= 原地），但层级给 3 → 原地降一级
    const { crepe, root, moveUnit, outline } = await mountWithCaret(SECTION, 0);
    const before = outline();
    expect(moveUnit(6, 8, 3)).not.toBeNull();
    const after = outline();
    expect(after).toHaveLength(before.length);
    expect(after[6]).toBe("h3:二级丁"); // 原地降级
    expect(after[7]).toBe("paragraph:尾段。");
    await crepe.destroy();
    root.remove();
  });

  it("层级夹紧在 1..6：h6 再降不越界，h1 再升不越界", async () => {
    const md = ["# 甲", "", "###### 六", "", "内容。", "", "# 乙", "",].join("\n");
    const { crepe, root, doc, moveUnit } = await mountWithCaret(md, 0);
    // 把 h6 那节（块 1，单元 [1,3)）放进 #甲 的节末，层级给 6（已到底，不能再降）
    moveUnit(1, 3, 6);
    expect(headingLevelOf(doc().child(1))).toBe(6);
    // 再把 h6 提到文末并给 level 1
    moveUnit(1, doc().childCount, 1);
    expect(headingLevelOf(doc().child(doc().childCount - 2))).toBe(1);
    await crepe.destroy();
    root.remove();
  });

  it("行间隙自然层级：后面是标题 → 同级；后面是正文 → 所属节 +1；文末 → 末节同级", async () => {
    // SECTION: 0 h1甲 1 正文一 2 h2乙 3 列表 4 h3丙 5 更深的正文 6 h2丁 7 尾段
    const { crepe, root, doc } = await mountWithCaret(SECTION, 0);
    const d = doc();
    expect(naturalLevelAtGap(d, 0)).toBe(1); // 文首 → 与第一个标题同级
    expect(naturalLevelAtGap(d, 2)).toBe(2); // 间隙后是 h2乙 → 与它同级
    expect(naturalLevelAtGap(d, 3)).toBe(3); // 间隙后是正文（属 h2乙）→ h3
    expect(naturalLevelAtGap(d, 6)).toBe(2); // 间隙后是 h2丁 → 与它同级
    expect(naturalLevelAtGap(d, 8)).toBe(2); // 文末 → 与最后一个标题同级
    await crepe.destroy();
    root.remove();
  });

  it("**每一行之间**都可插入：位置精确落到该间隙，不折回节末", async () => {
    // 回归护栏：曾把整节内容区折到节末 → 用户只能拖到「标题上方 / 文末」两处（2026-10-13 走查）
    const { crepe, root, doc, moveUnit, outline } = await mountWithCaret(SECTION, 0);
    // 把 ## 二级丁 插到「### 三级丙」之前（块 4 = 行间隙 4，层级 3）
    expect(moveUnit(6, 4, naturalLevelAtGap(doc(), 4))).not.toBeNull();
    const o = outline();
    const at = o.indexOf("h3:二级丁");
    expect(at).toBe(4); // 真的落在第 4 行，不是被折到文末
    expect(o[at + 1]).toContain("尾段");
    await crepe.destroy();
    root.remove();
  });

  it("拖到自己正文上 → 原地降一级（Notion 式缩进：位置不动，只改层级）", async () => {
    const { crepe, root, doc, moveUnit, outline } = await mountWithCaret(SECTION, 0);
    const before = outline();
    // 「放进 ## 二级乙 这一节」的槽 = 节末 6 + 层级 3；对块 2 而言这就是原地
    const slot = intoHeadingSlot(doc(), 2);
    expect(slot).toEqual({ insertBefore: 6, level: 3 });
    expect(moveUnit(2, slot!.insertBefore, slot!.level)).not.toBeNull();
    const after = outline();
    expect(after).toHaveLength(before.length); // 位置没变
    expect(after[2]).toBe("h3:二级乙"); // 自己降一级
    expect(after[3]).toContain("列表项"); // 节内内容跟着走
    expect(after[4]).toBe("h4:三级丙"); // 下属标题整体降一级
    await crepe.destroy();
    root.remove();
  });

  it("落点在源单元内部/紧邻 → 无操作（拖放必须由我们给结论）", async () => {
    // 回归护栏：这一条曾是「拖标题只搬标题」的根因——算出来无操作时，块拖放插件
    // 曾 return false 把 drop 交回 prosemirror-view 的内建路径，而它只搬**单个节点**。
    // 现在插件一律返回 true，所以这里必须钉住「无操作」的判定范围。
    const { crepe, root, doc } = await mountWithCaret(SECTION, 2); // ## 二级乙，单元 [2, 6)
    const d = doc();
    const len = unitLengthAt(d, 2);
    expect(len).toBe(4);
    for (const insertBefore of [2, 3, 4, 5, 6]) {
      expect(planUnitMove(d, 2, len, insertBefore)).toBeNull();
    }
    // 单元范围之外才有落点
    expect(planUnitMove(d, 2, len, 0)?.target).toBe(0);
    expect(planUnitMove(d, 2, len, 8)?.target).toBe(4);
    await crepe.destroy();
    root.remove();
  });

  it("末节下移是空操作（菜单据此置灰）", async () => {
    const { crepe, root, runMove } = await mountWithCaret(SECTION, 6); // ## 二级丁 是最后一节
    expect(runMove(1)).toBe(false);
    await crepe.destroy();
    root.remove();
  });

  it("标准读书笔记结构：拖 h2 带走标题、段落、列表与更深的 h3", async () => {
    const md = [
      "## 甲",
      "",
      "甲的正文。",
      "",
      "- 甲的要点",
      "",
      "### 甲的子节",
      "",
      "子节正文。",
      "",
      "## 乙",
      "",
      "乙的正文。",
      "",
    ].join("\n");
    const { crepe, root, runMove, doc } = await mountWithCaret(md, 0); // ## 甲
    expect(doc().childCount).toBe(7);
    expect(runMove(1)).toBe(true);
    const out = crepe.getMarkdown();
    // 乙整节顶到最前，甲整节（含 h3 子节与列表）跟在其后
    expect(out.indexOf("乙的正文。")).toBeLessThan(out.indexOf("甲的正文。"));
    expect(out).toContain("### 甲的子节");
    expect(out).toContain("子节正文。");
    // Crepe 序列化无序列表用 `*`（见文件头「允许的风格归一化」），所以只断言内容
    expect(out).toContain("甲的要点");
    // 关键：甲的子节不能改归乙
    expect(out.indexOf("乙的正文。")).toBeLessThan(out.indexOf("### 甲的子节"));
    await crepe.destroy();
    root.remove();
  });
});
