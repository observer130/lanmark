/**
 * 笔记大纲（目录）提取——**唯一来源**。
 *
 * 为什么从 markdown 源提取，而不是从 ProseMirror doc 提取：
 * - 源码模式也能用；阅读/编辑模式共用同一份数据；
 * - 纯函数、可单测，不依赖编辑器实例是否 ready。
 *
 * 与编辑器的对应关系：只认**行首 0 空格**的 ATX 标题（h1–h3），
 * 所以「第 N 个条目」必然对应 ProseMirror 顶层第 N 个 heading 节点。
 * 代价是列表内缩进标题、`> ##` 引用内标题、1–3 空格缩进的顶层标题会被漏掉——
 * 这是有意的：宁可少列，也不能让索引错位后跳到别的标题。
 */
export interface OutlineItem {
  /** 1–3（v1 只列到三级） */
  level: 1 | 2 | 3;
  /** 去掉行内标记后的显示文本；可能为空串（空标题） */
  text: string;
  /** 1-based 行号，源码模式跳转用 */
  line: number;
  /** 第 N 个标题（0-based），WYSIWYG 按顶层 heading 序号跳转 */
  index: number;
}

/** 去掉标题里的行内 markdown，只保留可读文本（显示用，不参与写回）。 */
export function plainHeadingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 → 文本
    .replace(/`+([^`]*)`+/g, "$1") // 行内代码
    .replace(/<[^>]+>/g, "") // HTML 标签
    .replace(/==([^=]+)==/g, "$1") // 荧光笔
    .replace(/~~([^~]+)~~/g, "$1") // 删除线
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+.!|~=-])/g, "$1")
    .trim();
}

/**
 * 从完整 markdown 提取 h1–h3 大纲。
 * 跳过 frontmatter 与 ``` / ~~~ 围栏代码块；空标题保留（显示层给占位文案）。
 */
export function extractOutline(md: string): OutlineItem[] {
  // BOM 会粘在第一行行首，先剥掉（不影响行号）。
  const body = md.startsWith("\uFEFF") ? md.slice(1) : md;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const items: OutlineItem[] = [];

  // frontmatter：与 splitFrontmatter 同判据；未闭合则当普通正文。
  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (t === "---" || t === "...") {
        start = i + 1;
        break;
      }
    }
  }

  let fence: { ch: string; len: number } | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }

    // 行首 0 空格；`#` 后必须是空格或行尾（`##标题` 不是标题）。
    const h = /^(#{1,3})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!h) continue;

    const raw = (h[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    items.push({
      level: h[1].length as 1 | 2 | 3,
      text: plainHeadingText(raw),
      line: i + 1,
      index: items.length,
    });
  }

  return items;
}
