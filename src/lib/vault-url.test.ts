import { afterEach, describe, it, expect } from "vitest";
import {
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
    expect(vaultUrlsToRelative(md, "a/b")).toBe("![](../b'c/x.png)");
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

  it("isExternal 认两种前缀", () => {
    expect(isExternal("vault://localhost/a.png")).toBe(true);
    expect(isExternal("http://vault.localhost/a.png")).toBe(true);
  });

  it("stripVaultPrefix 两种前缀都剥（调试用）", () => {
    expect(stripVaultPrefix("a vault://localhost/x http://vault.localhost/y")).toBe("a x y");
  });
});
