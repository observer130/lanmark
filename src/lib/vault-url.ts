/**
 * vault:// 协议 URL 与相对路径的换算。
 *
 * 约定（与 Obsidian 一致）：markdown 里的图片引用是「相对笔记所在目录」的路径，
 * 例如 工作/笔记.md 里写 ![](assets/x.png) 实际指 工作/assets/x.png。
 * WYSIWYG 文档树内的 image src 则用 vault 绝对协议 URL，序列化回 markdown 时把前缀剥掉，
 * 恢复为相对引用（源文件零侵入）。
 *
 * ⚠️ **协议前缀随平台不同，这不是笔误**（2026-10-20 真机走查定）：
 *  - 桌面（WebView2 / WebKitGTK）：`vault://localhost/<相对路径>`
 *  - Android：`http://vault.localhost/<相对路径>`
 *
 * Android WebView **不认自定义 scheme 的子资源**（`<img src="vault://…">` 直接 onerror，
 * `naturalWidth=0`），Tauri 在 Android 上把 `register_asynchronous_uri_scheme_protocol`
 * 暴露成 `http://<scheme>.localhost`，同一文件换这个前缀就能加载（真机实测：
 * `http://vault.localhost/assets/pic.png` → 32×32，`vault://…` → onerror）。
 * 所以：**生成 URL 用 `vaultUrlPrefix()`，保存前两种前缀都要认**——否则 Android 写回的
 * 引用会变成 `http://vault.localhost/...`，把相对引用写坏。
 */

import { isAndroid } from "./platform";

const DESKTOP_PREFIX = "vault://localhost/";
const ANDROID_PREFIX = "http://vault.localhost/";

/** 当前平台下文档树里的协议前缀（Tauri 在 Android 只认 http://<scheme>.localhost） */
export function vaultUrlPrefix(): string {
  return isAndroid() ? ANDROID_PREFIX : DESKTOP_PREFIX;
}

/** 是否是任一平台的 vault 协议 URL（保存时两种都要剥，跨端复制内容也安全） */
function hasVaultPrefix(src: string): boolean {
  return src.startsWith(DESKTOP_PREFIX) || src.startsWith(ANDROID_PREFIX);
}

/** 是否外部/绝对 URL（不需要走 vault 协议） */
export function isExternal(src: string): boolean {
  return (
    /^https?:\/\//i.test(src) ||
    /^data:/i.test(src) ||
    hasVaultPrefix(src) ||
    src.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(src) // Windows 绝对路径
  );
}

/**
 * 把「相对 baseDir 的引用 ref」解析为 vault 相对路径（处理 .. 与 .）。
 * 结果不含 ".."（越出根目录的引用按根目录截断，由协议层 404 兜底）。
 */
export function resolveFrom(baseDir: string, ref: string): string {
  const parts = (baseDir ? baseDir.split("/") : []).concat(ref.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/**
 * 生成 Obsidian 风格的相对引用：从 fromDir 指向 vault 相对路径 toPath。
 * fromDir 与 toPath 同级 → "assets/x.png"；跨级 → "../assets/x.png"。
 */
export function relativeFrom(fromDir: string, toPath: string): string {
  const from = fromDir.split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const ups = from.length - i;
  return [...Array(ups).fill(".."), ...to.slice(i)].filter(Boolean).join("/");
}

/** vault 相对路径 → 当前平台的协议 URL（每段 percent-encode，支持中文） */
export function toVaultUrl(vaultRel: string): string {
  return (
    vaultUrlPrefix() +
    vaultRel
      .split("/")
      .filter(Boolean)
      .map((seg) =>
        // encodeURIComponent 不转义 ' ! ( ) ~；其中 ' ) 会让保存期还原正则
        // [^\s)"']+ 在段中间截断 URL（文件名含特殊字符时引用写坏）。
        // 补齐转义，保证生成的 URL 不含裸空白/括号/引号
        encodeURIComponent(seg).replace(/[!'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()),
      )
      .join("/")
  );
}

/**
 * 协议 URL → vault 相对路径（保存前还原用）。
 * 注意必须逐段 percent-decode，与 toVaultUrl 的 encode 对称——
 * 漏掉解码会把编码后的引用写回磁盘（曾导致中文文件名逐次启动叠加编码）。
 * 两种平台前缀都认：笔记可能在 Android 上编辑过，桌面端打开后仍要能还原。
 */
export function fromVaultUrl(src: string): string {
  const prefix = src.startsWith(ANDROID_PREFIX)
    ? ANDROID_PREFIX
    : src.startsWith(DESKTOP_PREFIX)
      ? DESKTOP_PREFIX
      : null;
  if (!prefix) return src;
  return src
    .slice(prefix.length)
    .split("/")
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

/**
 * 保存前：markdown 图片/链接 src 中的 vault 协议 URL → 相对笔记目录的引用
 * （Obsidian 约定）。例：笔记在 工作/ 下，图在根 assets/ → URL 还原为 ../assets/x.png
 *
 * 只替换 image/link 的 src 位置：正文里用户手写的 vault:// 文本不得被改写
 * （此前全局正则会把它当 URL 还原，保存后文本损坏）。
 * toVaultUrl 已保证 URL 不含裸空白/括号，故 src 用 [^()\s]+ 即可完整匹配。
 */
export function vaultUrlsToRelative(markdown: string, noteDir: string): string {
  const inSrc = (url: string): string => {
    if (!hasVaultPrefix(url)) return url;
    const rel = fromVaultUrl(url);
    return rel ? relativeFrom(noteDir, rel) : url;
  };
  return markdown
    .replace(/(!\[[^\]]*\])\(([^()\s]+)\)/g, (_m, pre: string, url: string) => `${pre}(${inSrc(url)})`)
    .replace(/(?<!!)(\[[^\]]*\])\(([^()\s]+)\)/g, (_m, pre: string, url: string) => `${pre}(${inSrc(url)})`);
}

/** 简单前缀剥离（测试/调试用；产品保存路径请用 vaultUrlsToRelative） */
export function stripVaultPrefix(markdown: string): string {
  return markdown.split(DESKTOP_PREFIX).join("").split(ANDROID_PREFIX).join("");
}
