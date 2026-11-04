import { afterEach, describe, it, expect } from "vitest";
import {
  decodeRefPath,
  isExternal,
  resolveFrom,
  relativeFrom,
  toVaultUrl,
  fromVaultUrl,
  vaultUrlsToRelative,
  vaultUrlPrefix,
  stripVaultPrefix,
} from "./vault-url";

describe("isExternal", () => {
  it("外部/绝对 URL 不走 vault 协议", () => {
    expect(isExternal("https://example.com/x.png")).toBe(true);
    expect(isExternal("http://x/y")).toBe(true);
    expect(isExternal("data:image/png;base64,AAA")).toBe(true);
    expect(isExternal("vault://localhost/a/b.png")).toBe(true);
    expect(isExternal("/abs/path.png")).toBe(true);
    expect(isExternal("C:\\img\\x.png")).toBe(true);
  });
  it("相对引用走 vault 协议", () => {
    expect(isExternal("assets/x.png")).toBe(false);
    expect(isExternal("../img/x.png")).toBe(false);
    expect(isExternal("x.png")).toBe(false);
  });
});

describe("resolveFrom（相对笔记目录 → vault 相对路径）", () => {
  it("根目录笔记", () => {
    expect(resolveFrom("", "assets/x.png")).toBe("assets/x.png");
  });
  it("子目录笔记引用本目录资源", () => {
    expect(resolveFrom("工作", "assets/x.png")).toBe("工作/assets/x.png");
  });
  it("向上跳转", () => {
    expect(resolveFrom("a/b", "../x.png")).toBe("a/x.png");
    expect(resolveFrom("a/b", "../../x.png")).toBe("x.png");
  });
  it("越出根目录截断（协议层 404 兜底）", () => {
    expect(resolveFrom("a", "../../../x.png")).toBe("x.png");
  });
});

describe("relativeFrom（Obsidian 风格引用生成）", () => {
  it("根笔记 → 根资源", () => {
    expect(relativeFrom("", "assets/x.png")).toBe("assets/x.png");
  });
  it("子目录笔记 → 根资源", () => {
    expect(relativeFrom("工作", "assets/x.png")).toBe("../assets/x.png");
  });
  it("同目录", () => {
    expect(relativeFrom("a", "a/x.png")).toBe("x.png");
  });
  it("深层 → 浅层", () => {
    expect(relativeFrom("a/b/c", "a/x.png")).toBe("../../x.png");
  });
});

describe("toVaultUrl / fromVaultUrl", () => {
  it("中文路径 percent-encode", () => {
    expect(toVaultUrl("读书/图.png")).toBe(
      "vault://localhost/" + encodeURIComponent("读书") + "/" + encodeURIComponent("图.png"),
    );
  });
  it("fromVaultUrl 还原", () => {
    expect(fromVaultUrl(toVaultUrl("a/b.png"))).toBe("a/b.png");
    expect(fromVaultUrl("plain.png")).toBe("plain.png"); // 非协议 URL 原样
  });
  it("encode/decode 对称（中文路径——曾因漏 decode 把编码引用写回磁盘）", () => {
    expect(fromVaultUrl(toVaultUrl("assets/示例图片.png"))).toBe("assets/示例图片.png");
    expect(fromVaultUrl(toVaultUrl("工作/读书笔记/截图 v2.png"))).toBe("工作/读书笔记/截图 v2.png");
  });
});

describe("特殊字符文件名（' ( ) !——此前 URL 在这些字符处被截断写坏引用）", () => {
  it("toVaultUrl/fromVaultUrl 对称", () => {
    for (const name of ["a/b'c/x.png", "d/e(f).png", "g/h!i.png", "截图 (最终)'v2.png"]) {
      const url = toVaultUrl(name);
      expect(url.match(/[!'()]/)).toBeNull(); // 生成的 URL 不含裸特殊字符
      expect(fromVaultUrl(url)).toBe(name);
    }
  });

  it("图片引用正确还原（回归：截断路径曾产出错误的 .. 层数）", () => {
    const md = `![](${toVaultUrl("a/b'c/x.png")})`;
    // 生成端把 ' 编码为 %27，保存侧再编码回去（裸 ' 会被 title 解析误伤）
    expect(vaultUrlsToRelative(md, "a/b")).toBe("![](../b%27c/x.png)");
  });

  it("正文手写的 vault:// 文本不得被改写（回归：此前全局正则静默改写）", () => {
    const text = "见 vault://localhost/工作/笔记.md 这里";
    expect(vaultUrlsToRelative(text, "工作")).toBe(text);
  });

  it("链接（非图片）src 中的 vault URL 也还原", () => {
    const md = `[链接](${toVaultUrl("工作/笔记.md")})`;
    expect(vaultUrlsToRelative(md, "工作")).toBe("[链接](笔记.md)");
  });
});

describe("vaultUrlsToRelative（保存时 URL → 笔记相对引用）", () => {
  it("子目录笔记的根资源 → ../ 引用", () => {
    const md = `文字\n\n![](${toVaultUrl("assets/x.png")})\n`;
    expect(vaultUrlsToRelative(md, "工作")).toContain("../assets/x.png");
    expect(vaultUrlsToRelative(md, "工作")).not.toContain("vault://");
  });
  it("根笔记 → 原样相对路径", () => {
    const md = `![](${toVaultUrl("assets/x.png")})`;
    expect(vaultUrlsToRelative(md, "")).toBe("![](assets/x.png)");
  });
  it("外部 URL 不动", () => {
    const md = "![a](https://x.com/y.png) ![b](assets/z.png)";
    expect(vaultUrlsToRelative(md, "a")).toBe(md);
  });
  it("多个图片引用", () => {
    const md = `![](${toVaultUrl("assets/a.png")})\n![](${toVaultUrl("assets/b.png")})`;
    const out = vaultUrlsToRelative(md, "a/b");
    expect(out).toBe("![](../../assets/a.png)\n![](../../assets/b.png)");
  });
});

/**
 * 保存侧扫描器（替代 `]\([^()\s]+\)` 正则）：
 * 旧正则的三类硬伤——title 导致整条失配、alt 里的 `\]` 截断、代码区域被误改。
 */
describe("vaultUrlsToRelative 扫描器（title / 转义 / 代码区域 / 空格）", () => {
  it("带 title 的图片：URL 还原，title 原样保留", () => {
    expect(vaultUrlsToRelative('![a](vault://localhost/assets/x.png "标题")', "")).toBe(
      '![a](assets/x.png "标题")',
    );
    expect(vaultUrlsToRelative("![a](vault://localhost/assets/x.png '标题')", "")).toBe(
      "![a](assets/x.png '标题')",
    );
    expect(vaultUrlsToRelative("![a](vault://localhost/assets/x.png (标题))", "")).toBe(
      "![a](assets/x.png (标题))",
    );
    expect(vaultUrlsToRelative('![a](vault://localhost/a.md "标题 (v2)")', "工作")).toBe(
      '![a](../a.md "标题 (v2)")',
    );
  });

  it("alt 含转义 `\\]`：标签配对不被截断", () => {
    const md = "![截图 \\[1\\]](vault://localhost/assets/x.png)";
    expect(vaultUrlsToRelative(md, "")).toBe("![截图 \\[1\\]](assets/x.png)");
  });

  it("alt 含嵌套 [ ]：按平衡配对", () => {
    const md = "[![图 [1]](vault://localhost/assets/x.png)](https://x.com)";
    expect(vaultUrlsToRelative(md, "")).toBe("[![图 [1]](assets/x.png)](https://x.com)");
  });

  it("链接里嵌图片：两处 vault URL 都还原（编辑顺序不串位）", () => {
    const md = "[![a](vault://localhost/assets/x.png)](vault://localhost/b.md)";
    expect(vaultUrlsToRelative(md, "")).toBe("[![a](assets/x.png)](b.md)");
  });

  it("同一篇里非 vault 目标原样保留（含空格 / title）", () => {
    const md = '[x](assets/a b.md "标题") ![y](vault://localhost/assets/y.png)';
    expect(vaultUrlsToRelative(md, "")).toBe('[x](assets/a b.md "标题") ![y](assets/y.png)');
  });

  it("空格：URL 里 %20 → 相对引用仍写 %20（CommonMark 合法）", () => {
    expect(vaultUrlsToRelative("![a](vault://localhost/assets/my%20pic.png)", "")).toBe(
      "![a](assets/my%20pic.png)",
    );
    // 中文 + 空格 + 百分号：先解码再编码，且 % 不双重编码
    const url = "vault://localhost/assets/100%25%20%E5%9B%BE.png";
    // 中文不强制编码（CommonMark 允许；落盘后与既有中文引用一致）
    expect(vaultUrlsToRelative(`![a](${url})`, "")).toBe("![a](assets/100%25%20图.png)");
  });

  it("跨级：笔记在 工作/ 下 → ../assets/x.png", () => {
    expect(vaultUrlsToRelative("![a](vault://localhost/assets/x.png)", "工作")).toBe(
      "![a](../assets/x.png)",
    );
    expect(vaultUrlsToRelative("![a](vault://localhost/assets/x.png)", "工作/读书")).toBe(
      "![a](../../assets/x.png)",
    );
  });

  it("fenced code / 行内 code 里的 vault:// 不动", () => {
    const md = [
      "```md",
      "![a](vault://localhost/assets/x.png)",
      "```",
      "",
      "~~~~",
      "![b](http://vault.localhost/assets/y.png)",
      "~~~~",
      "",
      "行内 `![c](vault://localhost/assets/z.png)` 与 ``vault://localhost/a b``。",
    ].join("\n");
    expect(vaultUrlsToRelative(md, "")).toBe(md);
    // 代码块之外的引用照常还原（扫描器不能因第一个围栏就停摆）
    expect(vaultUrlsToRelative(`![ok](vault://localhost/assets/ok.png)\n\n${md}`, "")).toBe(
      `![ok](assets/ok.png)\n\n${md}`,
    );
  });

  it("围栏长度必须匹配（4 个反引号包围 3 个反引号的代码块）", () => {
    const inside = "```js\n![a](vault://localhost/assets/x.png)\n```";
    const md = ["````md", inside, "````", "", "![b](vault://localhost/assets/y.png)"].join("\n");
    expect(vaultUrlsToRelative(md, "")).toBe(
      ["````md", inside, "````", "", "![b](assets/y.png)"].join("\n"),
    );
  });

  it("CRLF 换行的围栏同样跳过", () => {
    const md =
      "```\r\n![a](vault://localhost/assets/x.png)\r\n```\r\n\r\n![b](vault://localhost/assets/y.png)\r\n";
    expect(vaultUrlsToRelative(md, "")).toBe(
      "```\r\n![a](vault://localhost/assets/x.png)\r\n```\r\n\r\n![b](assets/y.png)\r\n",
    );
  });

  it("普通链接（非图片）仍还原", () => {
    expect(vaultUrlsToRelative("[x](vault://localhost/a.md)", "")).toBe("[x](a.md)");
    expect(vaultUrlsToRelative("[x](vault://localhost/a.md)", "工作")).toBe("[x](../a.md)");
  });

  it("无 vault 前缀的 md 逐字节不变（含空格/中文/%20 的既有引用）", () => {
    const md = [
      "![a](assets/my pic.png)",
      "[b](工作/图%20表.md)",
      "![c](<assets/a b.png>)",
      "[d](a\\)b.md)",
      "正文里的 vault://localhost 只是文字，没有 `](` 形态。",
    ].join("\n");
    expect(vaultUrlsToRelative(md, "工作")).toBe(md);
  });

  it("<...> 包裹的 destination：只改尖括号内的内容，包裹语法保留", () => {
    expect(
      vaultUrlsToRelative('![a](<vault://localhost/assets/my pic.png> "标题")', ""),
    ).toBe('![a](<assets/my%20pic.png> "标题")');
  });

  it("`\\)` 不结束 destination（转义还原后再编码）", () => {
    expect(vaultUrlsToRelative("[x](vault://localhost/a\\)b.md)", "")).toBe("[x](a%29b.md)");
  });

  it("参考式定义 `[x]: url` 不处理", () => {
    const md = "[x]: vault://localhost/a.md\n\n正文。";
    expect(vaultUrlsToRelative(md, "工作")).toBe(md);
  });
});

describe("decodeRefPath（显示侧逐段解码）", () => {
  it("空格编码还原", () => {
    expect(decodeRefPath("assets/my%20pic.png")).toBe("assets/my pic.png");
  });
  it("中文 / 多级路径逐段解码，.. 与空段保留", () => {
    expect(decodeRefPath("../assets/%E4%B8%AD%E6%96%87.png")).toBe("../assets/中文.png");
    expect(decodeRefPath("a//b/../c%20d.png")).toBe("a//b/../c d.png");
    expect(decodeRefPath("")).toBe("");
    expect(decodeRefPath("..")).toBe("..");
  });
  it("非法转义原样返回（不能让一张坏图抛异常）", () => {
    expect(decodeRefPath("assets/100%.png")).toBe("assets/100%.png");
    expect(decodeRefPath("assets/%E0%A4%A.png")).toBe("assets/%E0%A4%A.png");
    expect(decodeRefPath("assets/%ZZ.png")).toBe("assets/%ZZ.png");
  });
});

/**
 * Android 的协议前缀与桌面**不同**（2026-10-20 真机走查定）：
 * Tauri 在 Android 把自定义协议暴露成 http://vault.localhost/，
 * `vault://` 的 <img> 在 WebView 里直接 onerror（自然尺寸 0）。
 */
describe("Android 协议前缀（跨平台 URL 生成 / 保存还原）", () => {
  const desktopUa = navigator.userAgent;
  const setUa = (v: string) =>
    Object.defineProperty(navigator, "userAgent", { value: v, configurable: true });
  const ANDROID_UA =
    "Mozilla/5.0 (Linux; Android 16; 2510DRK44C Build/BP2A.250705.008) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36";

  afterEach(() => setUa(desktopUa));

  it("桌面默认仍是 vault://localhost/", () => {
    expect(navigator.userAgent).not.toContain("Android");
    expect(vaultUrlPrefix()).toBe("vault://localhost/");
    expect(toVaultUrl("assets/x.png")).toBe("vault://localhost/assets/x.png");
  });

  it("Android UA 下生成 http://vault.localhost/（含中文段编码）", () => {
    setUa(ANDROID_UA);
    expect(vaultUrlPrefix()).toBe("http://vault.localhost/");
    expect(toVaultUrl("assets/x.png")).toBe("http://vault.localhost/assets/x.png");
    expect(toVaultUrl("读书/图.png")).toBe(
      "http://vault.localhost/" + encodeURIComponent("读书") + "/" + encodeURIComponent("图.png"),
    );
  });

  it("两种前缀都能被 fromVaultUrl 还原（跨端编辑同一篇笔记）", () => {
    expect(fromVaultUrl("vault://localhost/a/b.png")).toBe("a/b.png");
    expect(fromVaultUrl("http://vault.localhost/a/b.png")).toBe("a/b.png");
    expect(fromVaultUrl("http://vault.localhost/工作/图.png")).toBe("工作/图.png");
  });

  it("保存时 Android URL 也还原为相对引用（否则把 http://vault.localhost 写进 md）", () => {
    const md = `![](${toVaultUrl("assets/x.png")})`;
    setUa(ANDROID_UA);
    const androidUrl = toVaultUrl("assets/x.png");
    expect(androidUrl.startsWith("http://vault.localhost/")).toBe(true);
    expect(vaultUrlsToRelative(`![](${androidUrl})`, "工作")).toBe("![](../assets/x.png)");
    expect(vaultUrlsToRelative(`![](${androidUrl})`, "工作")).not.toContain("vault.localhost");
    // 桌面 UA 下同样要能剥（跨端读到 Android 写过的内容）
    expect(vaultUrlsToRelative(md, "工作")).toBe("![](../assets/x.png)");
  });

  it("Android 前缀 + title / 普通链接也走同一扫描器", () => {
    expect(vaultUrlsToRelative('![a](http://vault.localhost/assets/x.png "标题")', "工作")).toBe(
      '![a](../assets/x.png "标题")',
    );
    expect(vaultUrlsToRelative("[x](http://vault.localhost/a.md)", "工作")).toBe("[x](../a.md)");
  });

  it("isExternal 认两种前缀", () => {
    expect(isExternal("vault://localhost/a.png")).toBe(true);
    expect(isExternal("http://vault.localhost/a.png")).toBe(true);
  });

  it("stripVaultPrefix 两种前缀都剥（调试用）", () => {
    expect(stripVaultPrefix("a vault://localhost/x http://vault.localhost/y")).toBe("a x y");
  });
});
