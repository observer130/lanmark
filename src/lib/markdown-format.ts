/**
 * Markdown 保存整理（**只动空白**）。
 *
 * 为什么自己写而不引 markdownlint / prettier / remark-lint：
 *  - markdownlint 是 linter，只有一小部分规则可 fix，且是 Node CLI；
 *  - remark-lint / prettier 会整篇 AST 重新 stringify，列表符号、强调符号、表格对齐、
 *    转义都可能被改写——直接威胁硬约定 3 的往返保真。
 *
 * 本模块只处理「语义无关的空白」：文末空行、行尾空格、连续空行、ATX 标题内空格。
 * 代码块 / frontmatter / 缩进行逐字保留；硬换行（行尾两个空格或 `\`）保留。
 *
 * 两个入口：
 *  - `trimDocTail`：只裁文末空行（保存守卫与编辑器伪变更也用它，**永远执行**）；
 *  - `formatMarkdown`：完整整理（受 `editor.formatOnSave` 控制）。
 * 二者都必须幂等，且对「已经规范」的文档返回原字符串。
 */

const BOM = "\uFEFF";

interface SplitText {
  /** 去掉 BOM、统一成 LF 的文本 */
  text: string;
  /** 原文件的主行尾符（减少无意义 diff） */
  eol: "\n" | "\r\n";
  /** 原文件是否带 BOM */
  bom: string;
}

function splitText(md: string): SplitText {
  const bom = md.startsWith(BOM) ? BOM : "";
  const body = bom ? md.slice(BOM.length) : md;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const totalLf = (body.match(/\n/g) ?? []).length;
  const eol: "\n" | "\r\n" = crlf > totalLf - crlf ? "\r\n" : "\n";
  return { text: body.replace(/\r\n?/g, "\n"), eol, bom };
}

/** 只裁文末空白行：保留一个换行（空文件仍为空）。 */
export function trimDocTail(md: string): string {
  if (!md) return "";
  const { text, eol, bom } = splitText(md);
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return bom;
  return `${bom}${lines.join(eol)}${eol}`;
}

/**
 * 比较用的规范键：行尾符统一成 LF + 裁文末空行。
 * 只用于「这份内容与磁盘内容是否等价」，不要拿它落盘（会丢 CRLF/BOM）。
 */
export function compareKey(md: string): string {
  return trimDocTail(md).replace(/\r\n/g, "\n");
}

/** 标题行：`##  x ##` → `## x`；只处理行首 0–3 空格的 ATX 标题。 */
function formatHeading(line: string): string {
  const m = /^([ ]{0,3})(#{1,6})([ \t]+)(.*)$/.exec(line);
  if (!m) return line;
  const rest = m[4].replace(/[ \t]+#+[ \t]*$/, "").replace(/[ \t]+$/, "");
  return `${m[1]}${m[2]} ${rest}`.replace(/[ \t]+$/, "");
}

/** 普通行：整理标题与行尾空白；硬换行保留两个空格。 */
function formatLine(line: string): string {
  // 4 空格 / tab 开头：缩进代码块或列表续行。保守起见整行不动，
  // 避免把代码块里的行尾空格吃掉（缩进代码块没有围栏，识别成本高）。
  if (/^(?: {4}|\t)/.test(line)) return line;

  let out = formatHeading(line);

  if (/ {2,}$/.test(out)) {
    // Markdown 硬换行：行尾两个及以上空格。统一成恰好两个，语义不变。
    out = `${out.replace(/[ \t]+$/, "")}  `;
  } else if (/\\$/.test(out)) {
    // 反斜杠硬换行：反斜杠必须是最后一个字符，不动。
  } else {
    out = out.replace(/[ \t]+$/, "");
  }
  return out;
}

/**
 * 保存时整理：文末空行、行尾空格、连续空行、ATX 标题内空格。
 * 代码块 / frontmatter / 缩进行逐字保留。
 */
export function formatMarkdown(md: string): string {
  if (!md) return "";
  const { text, eol, bom } = splitText(md);
  const lines = text.split("\n");

  // frontmatter 必须原样保留（YAML 里的空白可能有意为之）。
  let fmEnd = -1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        fmEnd = i;
        break;
      }
    }
  }

  const out: string[] = [];
  let inFence: { ch: string; len: number } | null = null;
  // 缩进代码块没有围栏可依赖：进入后连空行也原样保留，避免把代码里的空行压掉。
  let inIndented = false;
  let lastBlank = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (i <= fmEnd) {
      out.push(line);
      lastBlank = line.trim() === "";
      continue;
    }

    if (inFence) {
      out.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        close &&
        close[1][0] === inFence.ch &&
        close[1].length >= inFence.len
      ) {
        inFence = null;
      }
      lastBlank = false;
      continue;
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      out.push(line);
      inFence = { ch: open[1][0], len: open[1].length };
      lastBlank = false;
      continue;
    }

    if (line.trim() === "") {
      // 缩进代码块内部的空行属于代码内容，不能压。
      if (inIndented) {
        out.push("");
        lastBlank = true;
        continue;
      }
      // 连续空行最多保留一个（即输出里最多一个空行）。
      if (!lastBlank) out.push("");
      lastBlank = true;
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      inIndented = true;
      out.push(line);
      lastBlank = false;
      continue;
    }
    inIndented = false;

    out.push(formatLine(line));
    lastBlank = false;
  }

  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  if (out.length === 0) return bom;
  return `${bom}${out.join(eol)}${eol}`;
}
