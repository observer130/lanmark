import { describe, expect, it } from "vitest";
import { extractOutline, plainHeadingText } from "./outline";

describe("extractOutline", () => {
  it("提取 h1–h3，保留行号与序号", () => {
    const md = ["# 一", "", "## 二", "", "正文", "", "### 三", "", "#### 四"].join("\n");
    const items = extractOutline(md);
    expect(items).toEqual([
      { level: 1, text: "一", line: 1, index: 0 },
      { level: 2, text: "二", line: 3, index: 1 },
      { level: 3, text: "三", line: 7, index: 2 },
    ]);
  });

  it("跳过 frontmatter", () => {
    const md = "---\ntitle: x\n---\n\n## 正文标题\n";
    expect(extractOutline(md)).toEqual([
      { level: 2, text: "正文标题", line: 5, index: 0 },
    ]);
  });

  it("未闭合 frontmatter 当普通正文（与 splitFrontmatter 一致）", () => {
    const md = "---\ntitle: x\n## 标题\n";
    expect(extractOutline(md).map((i) => i.text)).toEqual(["标题"]);
  });

  it("跳过围栏代码块（``` / ~~~）", () => {
    const md = [
      "# 真标题",
      "",
      "```md",
      "## 代码里的假标题",
      "```",
      "",
      "~~~",
      "# 也是假的",
      "~~~",
      "",
      "## 真二级",
    ].join("\n");
    expect(extractOutline(md).map((i) => i.text)).toEqual(["真标题", "真二级"]);
  });

  it("围栏未闭合 → 后面全部不列（与 CommonMark 一致）", () => {
    const md = "# 一\n\n```\n## 假\n";
    expect(extractOutline(md).map((i) => i.text)).toEqual(["一"]);
  });

  it("`##标题`（无空格）不是标题", () => {
    expect(extractOutline("##标题\n")).toEqual([]);
  });

  it("去掉闭合 # 与行内标记", () => {
    const md = "## **粗体** 与 `代码` 与 ==高亮== ##\n";
    expect(extractOutline(md)[0]?.text).toBe("粗体 与 代码 与 高亮");
  });

  it("空标题保留 text 空串", () => {
    const items = extractOutline("# \n");
    expect(items).toEqual([{ level: 1, text: "", line: 1, index: 0 }]);
  });

  it("CRLF 与 BOM 不影响行号", () => {
    const md = "\uFEFF# 一\r\n\r\n## 二\r\n";
    expect(extractOutline(md)).toEqual([
      { level: 1, text: "一", line: 1, index: 0 },
      { level: 2, text: "二", line: 3, index: 1 },
    ]);
  });

  it("4 空格缩进的 # 不算标题", () => {
    expect(extractOutline("    # 缩进代码\n")).toEqual([]);
  });
});

describe("plainHeadingText", () => {
  it("wikilink 取别名或目标", () => {
    expect(plainHeadingText("[[目标|别名]]")).toBe("别名");
    expect(plainHeadingText("[[目标]]")).toBe("目标");
  });

  it("链接 / 图片 / HTML / 删除线", () => {
    expect(plainHeadingText("[文字](https://x)")).toBe("文字");
    expect(plainHeadingText("![图](a.png)")).toBe("图");
    expect(plainHeadingText("<span>文字</span>")).toBe("文字");
    expect(plainHeadingText("~~删~~")).toBe("删");
  });
});
