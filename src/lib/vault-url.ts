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
 * 显示侧：相对引用里的 percent-encoding → 原始路径（逐段解码）。
 *
 * 与 `fromVaultUrl` 分开：这里只处理「非 external 的相对 src」，不碰协议前缀。
 * 非法转义（文件名里的裸 `%`）原样返回，不能让一张坏图把整篇文档搞崩。
 * 空段 / `.` / `..` 保留原样，路径层级语义不变。
 */
export function decodeRefPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg === "" || seg === "." || seg === "..") return seg;
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join("/");
}

/**
 * 生成出来的相对引用要重新做 percent-encode：
 * 空格 / `(` / `)` / `<` / `>` / `"` / `'` / `\` / `%`。
 * 这些字符会让 CommonMark 的 link destination 提前结束或语义改变；
 * `%` 也在集合里，但单遍 replace 不会二次扫描替换结果，故不会双重编码。
 * `/` 保留；`..` 里的 `.` 不在集合内，层级原样。
 */
const REF_ENCODE_RE = /[% ()<>"'\\]/g;

function encodeRelativeRef(ref: string): string {
  return ref.replace(
    REF_ENCODE_RE,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

/** CommonMark 的空白（link destination 的终止符 / title 前的分隔符） */
function isLinkSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

/** CommonMark 里反斜杠只能转义 ASCII 标点（`\]` `\)` `\\`…） */
function isAsciiPunctuation(c: string): boolean {
  const code = c.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/** destination 里的 CommonMark 反斜杠转义还原（`a\)b` → `a)b`） */
function unescapeDest(dest: string): string {
  let out = "";
  for (let i = 0; i < dest.length; i++) {
    const c = dest[i];
    if (c === "\\" && i + 1 < dest.length && isAsciiPunctuation(dest[i + 1])) {
      i++;
      out += dest[i];
    } else {
      out += c;
    }
  }
  return out;
}

function skipLinkSpace(md: string, from: number): number {
  let i = from;
  while (i < md.length && isLinkSpace(md[i])) i++;
  return i;
}

/**
 * `](` 之后的 destination 是否以 vault 前缀开头（不完整解析）。
 * 不含前缀的链接直接跳过：既保证「已有目标一律不动」，也避免为普通链接做无谓解析。
 */
function startsWithVaultPrefixAt(md: string, openParen: number): boolean {
  let i = skipLinkSpace(md, openParen + 1);
  if (md[i] === "<") i++;
  return md.startsWith(DESKTOP_PREFIX, i) || md.startsWith(ANDROID_PREFIX, i);
}

interface InlineLinkTarget {
  /** destination 的内容区间；`<...>` 包裹时不含尖括号 */
  destStart: number;
  destEnd: number;
  /** 整个 `](...)` 之后的下标 */
  end: number;
}

/**
 * 解析 `](dest "title")` 里的 destination/title（调用方保证 `](` 已匹配）。
 * 支持 `<dest>` 与裸 dest；裸 dest 读到空白或未转义的 `)`，`\)` 属于 dest。
 * title 支持 `"..."` / `'...'` / `(...)`，只用于定位 link 的结束——title 原样保留。
 */
function parseInlineLink(md: string, openParen: number): InlineLinkTarget | null {
  const n = md.length;
  let i = skipLinkSpace(md, openParen + 1);
  let destStart: number;
  let destEnd: number;
  if (md[i] === "<") {
    destStart = i + 1;
    i = destStart;
    while (i < n) {
      const c = md[i];
      if (c === "\\" && i + 1 < n && isAsciiPunctuation(md[i + 1])) {
        i += 2;
        continue;
      }
      if (c === ">") break;
      if (c === "\n" || c === "\r" || c === "<") return null;
      i++;
    }
    if (md[i] !== ">") return null;
    destEnd = i;
    i++;
  } else {
    destStart = i;
    while (i < n) {
      const c = md[i];
      if (c === "\\" && i + 1 < n && isAsciiPunctuation(md[i + 1])) {
        i += 2;
        continue;
      }
      if (c === ")" || isLinkSpace(c)) break;
      i++;
    }
    destEnd = i;
  }
  i = skipLinkSpace(md, i);
  if (md[i] === ")") return { destStart, destEnd, end: i + 1 };
  const opener = md[i];
  if (opener !== '"' && opener !== "'" && opener !== "(") return null;
  const closer = opener === "(" ? ")" : opener;
  i++;
  let titleClosed = false;
  while (i < n) {
    const c = md[i];
    if (c === "\\" && i + 1 < n && isAsciiPunctuation(md[i + 1])) {
      i += 2;
      continue;
    }
    if (c === closer) {
      i++;
      titleClosed = true;
      break;
    }
    i++;
  }
  if (!titleClosed) return null;
  i = skipLinkSpace(md, i);
  if (md[i] !== ")") return null;
  return { destStart, destEnd, end: i + 1 };
}

interface LinkScan {
  /** 字符是否位于 fenced code block / 行内 code span 内（这些区域一律不动） */
  code: Uint8Array;
  /** `]` 下标 → 配对的 `[` 下标；-1 表示不是标签闭合 */
  openOf: Int32Array;
}

interface FenceOpen {
  ch: "`" | "~";
  len: number;
  /** 开栏下一行的行首下标 */
  nextLine: number;
}

function fenceOpenAt(md: string, lineStart: number): FenceOpen | null {
  let p = lineStart;
  let indent = 0;
  while (indent < 4 && md[p] === " ") {
    p++;
    indent++;
  }
  if (indent > 3) return null;
  const ch = md[p];
  if (ch !== "`" && ch !== "~") return null;
  let q = p;
  while (md[q] === ch) q++;
  const len = q - p;
  if (len < 3) return null;
  let lineEnd = q;
  while (lineEnd < md.length && md[lineEnd] !== "\n") lineEnd++;
  // CommonMark：反引号围栏的 info string 里不能再出现反引号
  if (ch === "`" && md.slice(q, lineEnd).includes("`")) return null;
  return { ch, len, nextLine: lineEnd < md.length ? lineEnd + 1 : lineEnd };
}

/** 若 lineStart 是闭合围栏，返回行尾下标（换行符之前或 EOF），否则 null */
function fenceCloseAt(md: string, lineStart: number, ch: string, len: number): number | null {
  let p = lineStart;
  let indent = 0;
  while (indent < 4 && md[p] === " ") {
    p++;
    indent++;
  }
  if (indent > 3) return null;
  let q = p;
  while (md[q] === ch) q++;
  if (q - p < len) return null;
  let lineEnd = q;
  while (md[lineEnd] === " " || md[lineEnd] === "\t") lineEnd++;
  if (md[lineEnd] === "\r") lineEnd++; // 兼容 CRLF 换行
  if (lineEnd < md.length && md[lineEnd] !== "\n") return null;
  return lineEnd;
}

/**
 * 一遍扫描出「代码区域」与「`[` / `]` 配对」。
 * 代码区域内不配对、不改写；围栏开栏时清空标签栈，链接标签不得跨代码块。
 */
function scanMarkdown(md: string): LinkScan {
  const n = md.length;
  const code = new Uint8Array(n);
  const openOf = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  let i = 0;
  while (i < n) {
    if (i === 0 || md[i - 1] === "\n") {
      const fence = fenceOpenAt(md, i);
      if (fence) {
        stack.length = 0;
        let line = fence.nextLine;
        let closeEnd: number | null = null;
        while (line < n) {
          const end = fenceCloseAt(md, line, fence.ch, fence.len);
          if (end !== null) {
            closeEnd = end;
            break;
          }
          const nl = md.indexOf("\n", line);
          if (nl < 0) break;
          line = nl + 1;
        }
        if (closeEnd === null) {
          code.fill(1, i, n);
          i = n;
        } else {
          const end = Math.min(n, closeEnd + (closeEnd < n ? 1 : 0));
          code.fill(1, i, end);
          i = end;
        }
        continue;
      }
    }
    const c = md[i];
    if (c === "\\" && i + 1 < n && isAsciiPunctuation(md[i + 1])) {
      i += 2; // 转义：被转义的 `]` 不参与配对
      continue;
    }
    if (c === "`") {
      let runEnd = i;
      while (md[runEnd] === "`") runEnd++;
      const runLen = runEnd - i;
      let close = -1;
      let j = runEnd;
      while (j < n) {
        if (md[j] === "`") {
          let k = j;
          while (md[k] === "`") k++;
          if (k - j === runLen) {
            close = k;
            break;
          }
          j = k;
        } else {
          j++;
        }
      }
      if (close >= 0) {
        code.fill(1, i, close);
        i = close;
      } else {
        i = runEnd; // 未闭合的反引号是字面量，不是代码
      }
      continue;
    }
    if (c === "[") stack.push(i);
    else if (c === "]" && stack.length > 0) openOf[i] = stack.pop()!;
    i++;
  }
  return { code, openOf };
}

/**
 * 保存前：markdown 图片/链接 src 中的 vault 协议 URL → 相对笔记目录的引用
 * （Obsidian 约定）。例：笔记在 工作/ 下，图在根 assets/ → URL 还原为 ../assets/x.png
 *
 * 为什么不用正则：`[^()\s]+` 遇到 title（`![](url "标题")`）会整体失配、把 vault
 * URL 原样写进文件；alt 里的 `\]` 也会让 `[^\]]*` 提前截断。这里用一个小扫描器：
 *  - 跳过 fenced code block 与行内 code span（正文里的 vault:// 文本不得改写）；
 *  - 标签按 `[`/`]` 配对，认 `\]` 转义与嵌套；
 *  - destination 认 `<...>` / 裸形式（`\)` 不结束），title 只用来定位，原样保留；
 *  - 只改 destination，且只改带 vault 前缀的；其余字符逐字节不动。
 *
 * 不支持/不处理：参考式定义 `[x]: url`（编辑器不产出这种形态，且改写会动到
 * 用户排版）。纯函数、零依赖，代码区域与配对都是一遍扫描。
 */
export function vaultUrlsToRelative(markdown: string, noteDir: string): string {
  // 快路径：不含任一平台前缀就逐字节返回，避免「整篇无谓改写」
  if (!markdown.includes(DESKTOP_PREFIX) && !markdown.includes(ANDROID_PREFIX)) return markdown;
  const { code, openOf } = scanMarkdown(markdown);
  const n = markdown.length;
  const parts: string[] = [];
  let copied = 0;
  let changed = false;
  let i = 0;
  while (i < n) {
    if (code[i] || markdown[i] !== "]") {
      i++;
      continue;
    }
    if (openOf[i] < 0 || markdown[i + 1] !== "(" || !startsWithVaultPrefixAt(markdown, i + 1)) {
      i++;
      continue;
    }
    const link = parseInlineLink(markdown, i + 1);
    if (!link) {
      i++;
      continue;
    }
    // 先还原 CommonMark 的反斜杠转义（`vault://…/a\)b.png` 的路径是 `a)b.png`）
    const dest = unescapeDest(markdown.slice(link.destStart, link.destEnd));
    if (!hasVaultPrefix(dest)) {
      // 防御：解析结果万一不再带前缀，绝不按相对路径重算（已有目标一律不动）
      i++;
      continue;
    }
    const vaultRel = fromVaultUrl(dest);
    if (!vaultRel) {
      i++;
      continue;
    }
    const rel = relativeFrom(noteDir, vaultRel);
    if (!rel) {
      i++;
      continue;
    }
    parts.push(markdown.slice(copied, link.destStart), encodeRelativeRef(rel));
    copied = link.destEnd;
    changed = true;
    i = link.end;
  }
  if (!changed) return markdown;
  parts.push(markdown.slice(copied));
  return parts.join("");
}

/** 简单前缀剥离（测试/调试用；产品保存路径请用 vaultUrlsToRelative） */
export function stripVaultPrefix(markdown: string): string {
  return markdown.split(DESKTOP_PREFIX).join("").split(ANDROID_PREFIX).join("");
}
