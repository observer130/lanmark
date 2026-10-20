/**
 * 保存整理护栏：只动空白，代码块 / frontmatter / 硬换行 / 缩进行必须原样。
 * 需求来源：点一下列表/代码/表格结尾的笔记会多一个空行（Milkdown trailing 插件）。
 */
import { describe, expect, it } from "vitest";
import { compareKey, formatMarkdown, trimDocTail } from "./markdown-format";

describe("trimDocTail", () => {
  it("去掉文末多余空行，只留一个换行", () => {
    expect(trimDocTail("甲\n\n乙\n\n\n")).toBe("甲\n\n乙\n");
  });

  it("没有尾换行时补一个", () => {
    expect(trimDocTail("甲")).toBe("甲\n");
  });

  it("空文件仍为空", () => {
    expect(trimDocTail("")).toBe("");
    expect(trimDocTail("\n\n")).toBe("");
  });

  it("保留 CRLF 与 BOM", () => {
    expect(trimDocTail("甲\r\n\r\n")).toBe("甲\r\n");
    expect(trimDocTail("\uFEFF甲\n\n")).toBe("\uFEFF甲\n");
  });
});

describe("formatMarkdown：空白规则", () => {
  it("文末空行裁到一个换行", () => {
    expect(formatMarkdown("甲\n\n乙\n\n\n")).toBe("甲\n\n乙\n");
  });

  it("行尾空格去掉，但硬换行两个空格保留", () => {
    expect(formatMarkdown("甲 \n乙  \n丙\n")).toBe("甲\n乙  \n丙\n");
  });

  it("反斜杠硬换行不动", () => {
    expect(formatMarkdown("甲\\\n乙\n")).toBe("甲\\\n乙\n");
  });

  it("连续空行压成一个空行", () => {
    expect(formatMarkdown("甲\n\n\n\n乙\n")).toBe("甲\n\n乙\n");
  });

  it("ATX 标题内多余空格与闭合 # 整理", () => {
    expect(formatMarkdown("##  标题\n")).toBe("## 标题\n");
    expect(formatMarkdown("## 标题 ##\n")).toBe("## 标题\n");
    expect(formatMarkdown("#\t标题\n")).toBe("# 标题\n");
  });

  it("缺空格的 ##标题 不改（它不是标题）", () => {
    expect(formatMarkdown("##标题\n")).toBe("##标题\n");
  });

  it("围栏代码块逐字保留（含行尾空格与空行）", () => {
    const md = "```ts\nconst a = 1;   \n\n\n\nconst b = 2;\n```\n";
    expect(formatMarkdown(md)).toBe(md);
  });

  it("~~~ 围栏与嵌套长度判断", () => {
    const md = "~~~md\n```\n甲   \n```\n~~~\n";
    expect(formatMarkdown(md)).toBe(md);
  });

  it("frontmatter 逐字保留", () => {
    const md = "---\ntitle: x   \n---\n\n\n正文 \n";
    expect(formatMarkdown(md)).toBe("---\ntitle: x   \n---\n\n正文\n");
  });

  it("4 空格缩进行整行不动", () => {
    const md = "    代码行   \n";
    expect(formatMarkdown(md)).toBe(md);
  });

  it("缩进代码块内部的空行不压（没有围栏可依赖）", () => {
    const md = "    代码\n\n\n\n    更多\n";
    expect(formatMarkdown(md)).toBe(md);
  });

  it("CRLF 文件仍写 CRLF", () => {
    expect(formatMarkdown("甲 \r\n\r\n\r\n乙\r\n")).toBe("甲\r\n\r\n乙\r\n");
  });

  it("BOM 保留且只出现一次", () => {
    const out = formatMarkdown("\uFEFF# 标题\n\n");
    expect(out).toBe("\uFEFF# 标题\n");
    expect(out.startsWith("\uFEFF")).toBe(true);
  });

  it("空文档 / 纯空行", () => {
    expect(formatMarkdown("")).toBe("");
    expect(formatMarkdown("\n\n\n")).toBe("");
  });

  it("幂等：format(format(x)) === format(x)", () => {
    const samples = [
      "甲   \n\n\n\n乙\n\n",
      "---\ntitle: x\n---\n\n\n##  标题 ##\n\n正文   \n\n",
      "```js\nconst x = 1;   \n\n```\n\n\n",
      "甲  \n乙\\\n丙\n",
    ];
    for (const s of samples) {
      const once = formatMarkdown(s);
      expect(formatMarkdown(once)).toBe(once);
    }
  });
});

describe("compareKey", () => {
  it("只差文末空行 / 行尾符时等价", () => {
    expect(compareKey("甲\n\n乙\n\n")).toBe(compareKey("甲\n\n乙\n"));
    expect(compareKey("甲\r\n乙\r\n")).toBe(compareKey("甲\n乙\n"));
  });

  it("真实内容不同则不等价", () => {
    expect(compareKey("甲\n")).not.toBe(compareKey("乙\n"));
  });
});
