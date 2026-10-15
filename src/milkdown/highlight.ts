import { commandsCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { markRule } from "@milkdown/kit/prose";
import { toggleMark } from "@milkdown/kit/prose/commands";
import { $command, $inputRule, $markSchema, $remark, $useKeymap } from "@milkdown/kit/utils";

/**
 * 荧光笔：`==文字==`（M8 批次 3）。
 *
 * ## 为什么不需要写 micromark 分词器
 * `~~删除~~` 那种语法要靠 micromark 扩展在**词法层**识别；但荧光笔的语义要求低得多——
 * 只要在 mdast 建好之后**事后切分 `text` 节点**就够了（本文件顶部三步：切 text → 自定义
 * mdast 节点 → 序列化回去）。代价是不支持跨行内节点的嵌套（`==**粗**==` 不会命中），
 * 对荧光笔可以接受。这样避免手写分词器——那东西的定界符规则极易写错，而错了就是**往返
 * 损坏**（硬约定 3，本仓库最不能出的问题）。
 *
 * ## 数据流
 * ```
 * markdown  ──remark 解析──▶ mdast ──切分 text──▶ lanmarkHighlight 节点
 *                                              │ parseMarkdown.match
 *                                              ▼
 *                                          ProseMirror 的 highlight mark
 *                                              │ toMarkdown.runner
 *                                              ▼
 *                                          lanmarkHighlight 节点 ──handler──▶ ==文字==
 * ```
 *
 * ## 两条容易踩的
 *  ① 正则**必须**是「分隔符用反向引用、只有两个字面捕获组」的形状：兜底切分用第 1 组、
 *     Milkdown 的 `markRule` 取**最后一个捕获组**当「要加标记的内容」（`\1` 是反向引用、
 *     不算捕获组，所以最后一个捕获组就是内容）。
 *  ② 递归切分时要**跳过 `inlineCode` / `code` / `html` 子树**，否则代码块里的 `==x==`
 *     会被吃掉。
 */

/**
 * 切分用的正则。逐条约束都是有理由的：
 *  - `(?<![=\w\\])` 前面不能是 `=`／词字符／反斜杠 → `a == b`、`a==b`（本意是等号）不误判，
 *    且被转义过的 `\==x==` 不命中
 *  - `(?!\s)` / `(?<!\s)` 内侧不能贴空白 → `== 文字 ==` 不误判（不是高亮）
 *  - `([^\n]+?)` 不跨行
 *  - ``(?![\w=])` 后面不能是词字符或 `=` → 避免把 `==x===` 这类吃掉一半
 */
const SPLIT_RE = /(?<![=\w\\])==(?!\s)([^\n]+?)(?<!\s)==(?![\w=])/g;

/** 打字即时转换用：分隔符写成反向引用 `\1`，这样最后一个捕获组 = 内容（见文件头 ①） */
const INPUT_RE = /(?<![=\w])(==)(?!\s)([^\n]+?)(?<!\s)\1(?![\w=])$/;

const MDAST_TYPE = "lanmarkHighlight";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** 这些子树里的 `==` 是字面内容，不能当语法处理 */
const SKIP_TYPES = new Set(["inlineCode", "code", "html"]);

function splitText(value: string): MdastNode[] {
  const out: MdastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(SPLIT_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: MDAST_TYPE, children: [{ type: "text", value: m[1] }] });
    last = at + m[0].length;
  }
  if (out.length === 0) return [{ type: "text", value }]; // 未命中：原样
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

/** 就地把树里的 `==文字==` 切成「text + lanmarkHighlight + text」序列 */
function splitHighlights(node: MdastNode): void {
  const kids = node.children;
  if (!kids) return;
  const out: MdastNode[] = [];
  for (const child of kids) {
    if (SKIP_TYPES.has(child.type)) {
      out.push(child);
      continue;
    }
    if (child.type === "text" && typeof child.value === "string") {
      out.push(...splitText(child.value));
      continue;
    }
    splitHighlights(child);
    out.push(child);
  }
  node.children = out;
}

/** mdast → markdown：把 lanmarkHighlight 节点写回 `==文字==`（结构照抄 mdast-util-gfm-strikethrough） */
function handleHighlight(
  node: MdastNode,
  _parent: unknown,
  state: {
    enter: (t: string) => () => void;
    createTracker: (info: unknown) => { move: (s: string) => string; current: () => Record<string, unknown> };
    containerPhrasing: (n: MdastNode, info: Record<string, unknown>) => string;
  },
  info: unknown,
): string {
  const exit = state.enter(MDAST_TYPE);
  const tracker = state.createTracker(info);
  let value = tracker.move("==");
  value += tracker.move(
    state.containerPhrasing(node, {
      ...tracker.current(),
      before: value,
      after: "=",
    }),
  );
  value += tracker.move("==");
  exit();
  return value;
}

/**
 * remark 插件。**必须是普通函数**（unified 靠 `this` 拿 processor 才能注册序列化扩展），
 * 这一条照抄 remark-gfm 的写法——注册通道是 `data.toMarkdownExtensions`，
 * 由 `remark-stringify` 读出来交给 `mdast-util-to-markdown`。
 */
function remarkHighlight(this: unknown) {
  const self = this as { data: () => Record<string, unknown> };
  const data = self.data();
  const list = (data.toMarkdownExtensions as unknown[]) || (data.toMarkdownExtensions = []);
  list.push({ handlers: { [MDAST_TYPE]: handleHighlight } });
  return (tree: MdastNode) => {
    splitHighlights(tree);
  };
}

export const remarkHighlightPlugin = $remark("remarkHighlight", () => remarkHighlight);

/** 荧光笔标记。单色（不加属性）——需要多色时再加 attrs 与工具条的取色 */
export const highlightSchema = $markSchema("highlight", () => ({
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0] as const,
  parseMarkdown: {
    match: (node) => node.type === MDAST_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "highlight",
    runner: (state, mark) => {
      state.withMark(mark, MDAST_TYPE);
    },
  },
}));

export const toggleHighlightCommand = $command("ToggleHighlight", (ctx) => () =>
  toggleMark(highlightSchema.type(ctx)),
);

/** 输入 `==文字==` 打完最后一个 `=` 即刻转成高亮 */
export const highlightInputRule = $inputRule((ctx) =>
  markRule(INPUT_RE, highlightSchema.type(ctx)),
);

export const highlightKeymap = $useKeymap("highlightKeymap", {
  ToggleHighlight: {
    shortcuts: "Mod-Shift-h",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx);
      return () => commands.call(toggleHighlightCommand.key);
    },
  },
});

/**
 * 画在选区气泡条上的荧光笔图标。
 *
 * **必须是「单个填充 path」，不能是描边（stroke）图标**：Crepe 自带那套（粗体/斜体/删除线/
 * 公式/链接）全是 24×24 的单条 `<path>` 纯填充形状（无 stroke、无 fill 属性，靠 currentColor
 * 继承）。塞一个 stroke 版进去（比如 Lucide 的 highlighter）会明显**格格不入**——线宽、圆角、
 * 视觉重心全都对不上（2026-10-13 Linux 桌面走查：「图标太丑，和其他图标格格不入」）。
 *
 * 形状：斜放的笔身 + 收窄的笔尖 + 底下一道划痕，三段子路径拼成一条 path。
 *
 * 外面套 `translate+scale(0.76)` 是为了**占位对齐**：这条 path 原本横跨 17×20 格，而
 * Crepe 自带那套只占约 13×13——同一尺寸下荧光笔会**显得大一号**（2026-10-13 走查反馈：
 * 「图标主体明显更粗、色块更大，视觉上显得大一号」）。缩放系数不是拍脑袋：把 1 / 0.84 /
 * 0.76 / 0.68 四档与邻居并排渲染对比后选的 0.76（`.cache/screenshots/m8-25-icon-scale.png`）。
 * `translate` 的值 = 24/2 × (1 − scale)，即绕画布中心缩放（保持居中）。
 */
export const highlightIcon = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
  >
    <g transform="translate(2.88 2.88) scale(0.76)">
      <path
        fill="currentColor"
        d="M15.5 3.3a.95.95 0 0 1 1.34 0l3.86 3.86a.95.95 0 0 1 0 1.34l-9.4 9.4-5.2-5.2 9.4-9.4ZM5.4 13.9l4.7 4.7-1.2 1.2a1.2 1.2 0 0 1-.54.32l-3.3.79a.8.8 0 0 1-.97-.97l.79-3.3c.06-.21.17-.4.32-.54l.2-.2ZM3.6 21.2h16.8a.9.9 0 0 1 0 1.8H3.6a.9.9 0 0 1 0-1.8Z"
      />
    </g>
  </svg>
`;

export const highlightPlugins: MilkdownPlugin[] = [
  remarkHighlightPlugin,
  highlightSchema,
  toggleHighlightCommand,
  highlightInputRule,
  highlightKeymap,
].flat();
