import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, Code, Folder, NotebookText, PenLine, Star } from "lucide-react";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import { insertImageCommand } from "@milkdown/kit/preset/commonmark";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";

import { useVaultStore } from "../stores/vault";
import { uploadFile } from "../lib/image";
import { dragWindow, isLinuxDesktop, WindowControls } from "./WindowControls";
import { splitFrontmatter, joinFrontmatter } from "../lib/frontmatter";
import { protectWikilinks, restoreWikilinks } from "../lib/wikilink";
import {
  isExternal,
  resolveFrom,
  toVaultUrl,
  vaultUrlsToRelative,
} from "../lib/vault-url";
import { parentDir } from "../lib/vault";
import { useSettingsStore } from "../stores/settings";
import { createProductCrepe } from "../milkdown/product";
import {
  currentTopBlockIndex,
  moveBlockCommand,
  topBlockAt,
  topBlockIndexAtPos,
} from "../milkdown/block-move";
import { BlockMenu, type BlockMenuTarget } from "./BlockMenu";

/** 从 Crepe 取 ProseMirror EditorView（类型走推断，避免直接依赖 prosemirror 包） */
async function getEditorView(crepe: Crepe) {
  return crepe.editor.action((ctx) => ctx.get(editorViewCtx));
}
type LMView = Awaited<ReturnType<typeof getEditorView>>;
type LMDoc = LMView["state"]["doc"];

/**
 * 编辑器实例的 key：**只由「路径 + 模式」决定**。
 *
 * 这是一个回归护栏（docs/08 §4.4 / §9 R2）：外观设置（字体 / 字号 / 行距 / 行宽）
 * 一律走 CSS 变量，**绝不能进这个 key**。一旦进了 key，改字号会销毁重建 Crepe 实例，
 * 而 Crepe 建实例会发一次伪 `markdownUpdated` —— 打开着的笔记就被重写一遍
 * （硬约定 3「打开笔记不得重写文件」）。`settings.test.ts` 里有用例钉住这个契约。
 */
export function editorKey(path: string, mode: string): string {
  return `${path}|${mode}`;
}

/**
 * 暴露给 `EditorPane` 的编辑器操作面——**只谈「顶层块」，不外泄 ProseMirror 类型**。
 * 存在的理由：块菜单要能在 Crepe 实例之外（React 组件里）执行动作，而实例是在
 * `MilkdownHost` 的 effect 里建的（effect 依赖必须保持 `[]`，不能把实例提到 state）。
 * 由 `onReady` 交给父组件，父组件存进 ref——**不要放进 state**，那会触发重渲染。
 */
export interface EditorApi {
  /** 屏幕坐标 → 顶层块序号，并顺带把选区落到该块；命中不了返回 null */
  indexFromPoint: (x: number, y: number) => number | null;
  /** 当前选区所在的顶层块序号（六个点手柄点击时 Crepe 已在 mousedown 里选中该块） */
  indexFromSelection: () => number | null;
  /** 顶层块总数（菜单置灰用） */
  blockCount: () => number;
  moveBlock: (index: number, dir: -1 | 1) => void;
  deleteBlock: (index: number) => void;
}

/**
 * 把选区落到第 index 个顶层块上，使块级命令（移动/删除/插入）都作用在同一目标。
 * 分两种：文本块用光标落到块首（`TextSelection`），原子块（分割线、图片）用
 * `NodeSelection`——两者都能让 `currentTopBlockIndex` 解出同一个序号。
 * 只改选区、不改文档 ⇒ 不会触发 `markdownUpdated`（硬约定 3）。
 */
function selectTopBlock(view: LMView, index: number): boolean {
  const block = topBlockAt(view.state.doc, index);
  if (!block) return false;
  const sel = block.node.isTextblock
    ? TextSelection.near(view.state.doc.resolve(block.from + 1))
    : NodeSelection.create(view.state.doc, block.from);
  view.dispatch(view.state.tr.setSelection(sel));
  return true;
}

/** WYSIWYG 编辑器宿主（Crepe）：切换笔记/模式时整体重建，避免状态残留。
 *  readOnly=true 时为「阅读模式」：关掉斜杠菜单/块手柄/链接浮层等交互特性，
 *  并将 ProseMirror 设为不可编辑（粘贴/拖入监听也一并跳过）。 */
function MilkdownHost({
  content,
  notePath,
  onChange,
  readOnly = false,
  narrow = false,
  onReady,
  onBlockMenu,
}: {
  content: string;
  notePath: string;
  onChange: (md: string) => void;
  readOnly?: boolean;
  narrow?: boolean;
  onReady?: (api: EditorApi | null) => void;
  onBlockMenu?: (index: number, x: number, y: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  // 「最新值 ref」：effect 依赖必须保持 `[]`（重建 Crepe = 重写笔记，硬约定 3），
  // 所以回调与 narrow 都经 ref 读取，不进依赖数组。
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onBlockMenuRef = useRef(onBlockMenu);
  onBlockMenuRef.current = onBlockMenu;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let crepe: Crepe | null = null;
    // 每次挂载用专属 inner root：即便 effect 重跑（双挂载/热更新），
    // 旧实例的残留 DOM 随 root 一起移除，不与新实例互相踩踏
    const inner = document.createElement("div");
    inner.className = "editor-inner";
    host.appendChild(inner);

    // frontmatter 不进编辑器（CommonMark 会破坏 --- ），保存时原样回填
    const { fm, body } = splitFrontmatter(content);
    // wikilink 不进编辑器（CommonMark 会破坏 [[...]] 语义），保存时还原
    const { body: editorBody, map: wikiMap } = protectWikilinks(body);
    const baseDir = parentDir(notePath);
    let view: LMView | null = null;
    // 基线文档：只有 doc 树真正相对基线变化过，才放行 markdownUpdated。
    // （Crepe create 后会异步触发一次「同 doc 重序列化」事件——列表 - 会变 *、
    //  补尾行——若放行就会「打开笔记=重写文件」；见 docs/04 §9c）
    let lastKnownDoc: LMDoc | null = null;
    (async () => {
      crepe = createProductCrepe({ root: inner, defaultValue: editorBody, readOnly });
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, md) => {
          if (!view || !lastKnownDoc) return; // 基线未建立（create/改写期间）：一律抑制
          if (view.state.doc.eq(lastKnownDoc)) return; // 同 doc 重序列化（伪事件）：抑制
          lastKnownDoc = view.state.doc; // 真实编辑：放行并刷新基线
          onChange(joinFrontmatter(fm, vaultUrlsToRelative(restoreWikilinks(md, wikiMap), baseDir)));
        });
      });
      await crepe.create();
      if (cancelled) {
        await crepe?.destroy();
        return;
      }

      // 图片显示：文档树里相对 src → vault 协议 URL（仅改显示，不改源文件）
      view = await getEditorView(crepe);
      // 阅读模式：ProseMirror 设为不可编辑（命令式插入仍可能绕过，故监听器也一并跳过）
      if (readOnly) view.setProps({ editable: () => false });
      const tr = view.state.tr;
      let changed = false;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === "image") {
          const src = (node.attrs.src as string) ?? "";
          if (src && !isExternal(src)) {
            const vaultRel = resolveFrom(baseDir, src);
            const url = toVaultUrl(vaultRel);
            if (url !== src) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: url });
              changed = true;
            }
          }
        }
      });
      if (changed) view.dispatch(tr);
      lastKnownDoc = view.state.doc; // 基线建立：此后只放行真实 doc 变化

      // 图片落盘并插入（粘贴 / 拖入共用）：插入 vault 协议 URL（显示用），
      // 保存时 stripVaultPrefix 会还原为相对引用
      const insertFiles = async (files: File[]) => {
        if (!crepe) return;
        for (const f of files) {
          try {
            const assetRel = await uploadFile(f);
            const alt = f.name.replace(/\.[^.]+$/, "");
            insertImageCommand.run({ src: toVaultUrl(assetRel), alt });
          } catch (err) {
            void useVaultStore.setState({ error: String(err) });
          }
        }
      };

      // 剪贴板图片粘贴 → 落盘 assets/ → 在光标处插入
      const onPaste = (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.items ?? [])
          .filter((i) => i.kind === "file")
          .map((i) => i.getAsFile())
          .filter((f): f is File => !!f);
        if (files.length === 0) return;
        e.preventDefault();
        void insertFiles(files);
      };

      // ── 块级操作面（M8 G3：不依赖拖拽的第二条路）─────────────────────────
      const api: EditorApi = {
        blockCount: () => view?.state.doc.childCount ?? 0,
        indexFromSelection: () => (view ? currentTopBlockIndex(view.state) : null),
        indexFromPoint: (x, y) => {
          if (!view) return null;
          // 触发点常落在正文之外：左侧槽位（手柄所在的留白）、卡片 padding，手机上还有
          // 手指偏出文本列。这些位置 `posAtCoords` **直接返回 null**，所以不能原样交给它。
          // 横向在内容列外时只按纵向位置定位、横向取内容列中线——留白处的语义本来就是
          // 「这一行对应的块」。实测（.cache/probe-blockmenu.mjs，1100px）。
          const col = contentColumn();
          const rect = view.dom.getBoundingClientRect();
          const outsideX = x < col.left || x > col.right;
          const coords = view.posAtCoords({
            left: outsideX ? (col.left + col.right) / 2 : x,
            top: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
          });
          if (!coords) return null;
          let index: number | null;
          try {
            // 落在块间空隙时 depth 会是 0，用容错版按位置归块（见 block-move.ts）
            index = topBlockIndexAtPos(view.state.doc, coords.pos);
          } catch {
            return null;
          }
          if (index === null) return null;
          return selectTopBlock(view, index) ? index : null;
        },
        moveBlock: (index, dir) => {
          if (!view) return;
          if (!selectTopBlock(view, index)) return;
          // 用命令的 run 而非 commandsCtx：run 在插件初始化时就绑好了 ctx，
          // 调用方（React 组件）不必持有 ctx。
          moveBlockCommand.run(dir);
        },
        deleteBlock: (index) => {
          if (!view) return;
          // doc 必须至少留一个块（schema 要求 block+）；只剩一块时由菜单置灰兜住
          if (view.state.doc.childCount <= 1) return;
          const block = topBlockAt(view.state.doc, index);
          if (!block) return;
          view.dispatch(view.state.tr.delete(block.from, block.to).scrollIntoView());
        },
      };
      onReadyRef.current?.(api);

      /**
       * 正文**内容列**（去掉 `.ProseMirror` 自身 padding 后的左右边界）。
       * 留白判定与坐标定位必须用同一个口径，否则会出现「判定通过但定位失败 → 点了没反应」。
       * 用 padding 而不是 rect 内缘：crepe 给 `.ProseMirror` 几十 px 的左右 padding，
       * rect 内缘仍在 padding 里，`posAtCoords` 照样返 null。
       */
      const contentColumn = () => {
        const rect = view!.dom.getBoundingClientRect();
        const cs = getComputedStyle(view!.dom);
        return {
          left: rect.left + (parseFloat(cs.paddingLeft) || 0),
          right: rect.right - (parseFloat(cs.paddingRight) || 0),
        };
      };

      /**
       * 块菜单的触发判定。
       *  - 窄屏（长按）：**任意位置**都开——移动端 WebView 没有可用的原生右键菜单，
       *    而长按正文是这里唯一的块级入口（硬约定 13）。
       *  - 桌面：只认「正文内容列左侧的留白」与「六个点手柄」两处，**不抢正文右键**——
       *    正文右键要留给 WebView 原生的复制/粘贴/查词菜单，全局抢占是实打实的回退。
       */
      const shouldOpenBlockMenu = (e: MouseEvent) => {
        if (narrowRef.current) return true;
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(".milkdown-block-handle")) return true;
        if (!view) return false;
        return e.clientX < contentColumn().left;
      };

      const onBlockContextMenu = (e: MouseEvent) => {
        if (!shouldOpenBlockMenu(e)) return;
        const index = api.indexFromPoint(e.clientX, e.clientY);
        if (index === null) return;
        e.preventDefault();
        onBlockMenuRef.current?.(index, e.clientX, e.clientY);
      };

      /**
       * 「六个点」手柄点击 → 块菜单。
       *
       * 走 DOM 代理而不是给 Crepe 打补丁：`BlockEdit` 的 feature 配置只有
       * `handleAddIcon` / `handleDragIcon`（图标字符串）与定位钩子，**没有任何点击回调**，
       * 无法在配置层接。手柄 DOM（`.milkdown-block-handle` + 两个 `.operation-item`，
       * 后一个才是拖拽点）因此是硬编码依赖——Crepe 改结构时这里会静默失效，
       * 但**不会**让功能不可用：右键留白与 `Alt-↑/↓` 仍在。改动 Crepe 版本后请复核。
       */
      const onBlockHandleClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        const handle = target?.closest?.(".milkdown-block-handle");
        if (!handle) return;
        const items = handle.querySelectorAll(".operation-item");
        // items[0] = 「+ 插入」（Crepe 自己的行为，别抢）；items[1] = 六个点
        if (items.length < 2 || !items[1].contains(target)) return;
        const index = api.indexFromSelection();
        if (index === null) return;
        const rect = items[1].getBoundingClientRect();
        e.preventDefault();
        onBlockMenuRef.current?.(index, rect.left, rect.bottom);
      };

      // 文件拖入（仅拦截图片文件，文本拖拽仍走 ProseMirror 默认行为）
      const onDragOver = (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
      };
      const onDrop = (e: DragEvent) => {
        const files = Array.from(e.dataTransfer?.files ?? []).filter(
          (f) => f.type.startsWith("image/") || f.name.match(/\.(png|jpe?g|gif|webp|svg|bmp)$/i),
        );
        if (files.length === 0) return;
        e.preventDefault();
        void insertFiles(files);
      };

      if (!readOnly) {
        host.addEventListener("paste", onPaste);
        host.addEventListener("dragover", onDragOver);
        host.addEventListener("drop", onDrop);
        host.addEventListener("contextmenu", onBlockContextMenu);
        host.addEventListener("click", onBlockHandleClick);
        (host as HTMLDivElement & { __lanmarkCleanup?: () => void }).__lanmarkCleanup = () => {
          host.removeEventListener("paste", onPaste);
          host.removeEventListener("dragover", onDragOver);
          host.removeEventListener("drop", onDrop);
          host.removeEventListener("contextmenu", onBlockContextMenu);
          host.removeEventListener("click", onBlockHandleClick);
        };
      }
    })();

    return () => {
      cancelled = true;
      onReadyRef.current?.(null);
      const h = host as HTMLDivElement & { __lanmarkCleanup?: () => void };
      h.__lanmarkCleanup?.();
      try {
        void crepe?.destroy().catch(() => {});
      } catch {
        // 创建中的实例 destroy 可能同步抛错（StrictMode 已移除，防御性保留）
      }
      inner.remove(); // 专属 root 整体移除，旧实例 DOM 不残留
    };
    // 仅在笔记切换 / 模式切换时重建（key 由父组件控制）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={hostRef} className="editor-host" />;
}

/** 模式切换按钮：纯图标 + 悬停提示（data-tip），激活态为浮起白片 */
function ModeButton({
  icon: Icon,
  tip,
  active,
  onClick,
}: {
  icon: typeof BookOpen;
  tip: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      className={`rounded-md px-2 py-1 ${
        active ? "bg-card text-ink shadow-slider" : "text-ink-2 hover:text-ink"
      }`}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
}

export function EditorPane({ narrow = false }: { narrow?: boolean }) {
  const {
    activePath,
    content,
    editorMode,
    dirty,
    savedAt,
    setContent,
    scheduleSave,
    setEditorMode,
    toggleFavorite,
    favorites,
  } = useVaultStore();
  // M4c B3：源码模式行号开关。用订阅而非 getState()：改设置要立刻反映到
  // 已打开的编辑器上（CodeMirror 的 basicSetup 变化会触发 reconfigure）
  const sourceLineNumbers = useSettingsStore((s) => s.settings.editor.sourceLineNumbers);

  // 编辑器操作面：ref 而非 state——`onReady` 在 effect 里回调，进 state 会触发重渲染
  const editorApiRef = useRef<EditorApi | null>(null);
  const [blockMenu, setBlockMenu] = useState<BlockMenuTarget | null>(null);

  const openBlockMenu = useCallback((index: number, x: number, y: number) => {
    const api = editorApiRef.current;
    if (!api) return;
    const count = api.blockCount();
    if (index < 0 || index >= count) return;
    setBlockMenu({
      index,
      canMoveUp: index > 0,
      canMoveDown: index < count - 1,
      canDelete: count > 1, // doc 至少留一个块（schema block+）
      x,
      y,
    });
  }, []);

  const closeBlockMenu = useCallback(() => setBlockMenu(null), []);

  // 移动后**保持菜单打开**并刷新置灰状态：连续微调位置是「移动块」最常见的用法
  const handleBlockMove = useCallback((dir: -1 | 1) => {
    const api = editorApiRef.current;
    setBlockMenu((cur) => {
      if (!api || !cur) return cur;
      api.moveBlock(cur.index, dir);
      const next = cur.index + dir;
      const count = api.blockCount();
      return {
        ...cur,
        index: next,
        canMoveUp: next > 0,
        canMoveDown: next < count - 1,
      };
    });
  }, []);

  const handleBlockDelete = useCallback(() => {
    const api = editorApiRef.current;
    if (!api || !blockMenu) return;
    api.deleteBlock(blockMenu.index);
    setBlockMenu(null);
  }, [blockMenu]);

  // 切笔记 / 切模式会重建编辑器实例，旧实例的 ref 随即失效——菜单必须一起关，
  // 否则会对着已经销毁的编辑器执行命令（静默无反应）。
  useEffect(() => {
    setBlockMenu(null);
  }, [activePath, editorMode]);

  if (!activePath) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* Linux 无边框窗口：未开笔记也要有拖拽区与窗控（验收修正：窗控必须永远可达）。
            padding 与有笔记时的头部保持一致，避免开笔记前后窗控横移 */}
        {isLinuxDesktop && (
          <div
            onMouseDown={dragWindow}
            className={`flex items-center gap-2 py-2.5 ${
              narrow ? "pl-[72px] pr-2" : "px-4"
            }`}
          >
            <span className="flex-1" />
            <WindowControls />
          </div>
        )}
        <div className="flex flex-1 items-center justify-center p-4 text-ink-2">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
              <NotebookText size={26} />
            </div>
            <p className="text-sm">从左侧选择笔记，或点「+ 笔记」新建</p>
            <p className="mt-1 text-xs text-ink-3">
              粘贴图片 / 拖入图片会自动存入 assets/
            </p>
          </div>
        </div>
      </main>
    );
  }

  const crumbs = activePath.split("/");
  const isFav = favorites.some((f) => f.path === activePath);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-canvas">
      {/* 头部：窄屏时左侧让出悬浮抽屉按钮的宽度（按钮占 12→46px），避免遮挡标题。
          Linux 无边框窗口（decorations:false）：头部空白即拖拽区，双击最大化；
          右端是自绘窗控（方案 A · 头部融合，design/direction-approved.md）。 */}
      <div
        onMouseDown={isLinuxDesktop ? dragWindow : undefined}
        className={`flex items-center gap-2 py-2.5 ${
          // 窄屏：左侧让出悬浮汉堡按钮（left-3 + 44px = 占 12~56px），
          // 再留 16px 间隙 —— 原先 pl-14(56px) 让面包屑正好贴在按钮右边缘
          narrow ? "pl-[72px] pr-2" : "px-4"
        }`}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-ink-3"
          title={activePath}
        >
          <Folder size={13} className="shrink-0" />
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center">
              {i > 0 && <span className="mx-1 opacity-60">/</span>}
              <span
                className={`truncate ${
                  i === crumbs.length - 1 ? "font-medium text-ink" : ""
                }`}
              >
                {c}
              </span>
            </span>
          ))}
        </div>

        {dirty ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-warn">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            未保存…
          </span>
        ) : savedAt && !narrow ? ( /* 窄屏头部拥挤，保存时刻省略，保留未保存警示 */
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2">
            <Check size={12} className="text-ok" />
            已保存 {new Date(savedAt).toLocaleTimeString()}
          </span>
        ) : null}

        <button
          title="收藏 / 取消收藏"
          className="rounded-md p-1 hover:bg-canvas"
          onClick={() => void toggleFavorite(activePath)}
        >
          <Star
            size={15}
            className={isFav ? "fill-amber-400 text-amber-400" : "text-ink-3 hover:text-ink"}
          />
        </button>

        {/* 模式切换：阅读 / 所见即所得 / 源码（图标 + 悬停提示） */}
        <div className="flex shrink-0 rounded-lg bg-ink/5 p-0.5 text-xs">
          <ModeButton
            icon={BookOpen}
            tip="阅读模式"
            active={editorMode === "read"}
            onClick={() => setEditorMode("read")}
          />
          <ModeButton
            icon={PenLine}
            tip="所见即所得"
            active={editorMode === "wysiwyg"}
            onClick={() => setEditorMode("wysiwyg")}
          />
          <ModeButton
            icon={Code}
            tip="源码模式"
            active={editorMode === "source"}
            onClick={() => setEditorMode("source")}
          />
        </div>

        {/* Linux 无边框窗口：自绘窗控（最小化/最大化/关闭） */}
        {isLinuxDesktop && <WindowControls />}
      </div>

      {/* 编辑区：内容浮在冷白画布上的白色纸卡；key 强制按笔记+模式重建编辑器 */}
      <div className="min-h-0 flex-1 px-4 pb-3">
        <div
          className={`h-full overflow-hidden rounded-xl border border-line bg-card shadow-card ${
            editorMode === "source" ? "source-editor" : ""
          } ${editorMode === "read" ? "reading" : ""}`}
        >
          {editorMode === "read" ? (
            <MilkdownHost
              key={editorKey(activePath, "read")}
              content={content}
              notePath={activePath}
              onChange={(md) => {
                setContent(md);
                scheduleSave();
              }}
              readOnly
            />
          ) : editorMode === "wysiwyg" ? (
            <MilkdownHost
              key={editorKey(activePath, "wysiwyg")}
              content={content}
              notePath={activePath}
              narrow={narrow}
              onReady={(api) => {
                editorApiRef.current = api;
              }}
              onBlockMenu={openBlockMenu}
              onChange={(md) => {
                setContent(md);
                scheduleSave();
              }}
            />
          ) : (
            <CodeMirror
              key={editorKey(activePath, "source")}
              value={content}
              height="100%"
              style={{ height: "100%" }}
              extensions={[markdown()]}
              onChange={(value) => {
                setContent(value);
                scheduleSave();
              }}
              basicSetup={{ lineNumbers: sourceLineNumbers, foldGutter: true }}
            />
          )}
        </div>
      </div>

      {/* 块菜单：上移 / 下移 / 删除（M8 G3）。三条触发路径见 BlockMenu 注释 */}
      <BlockMenu
        target={blockMenu}
        narrow={narrow}
        onMove={handleBlockMove}
        onDelete={handleBlockDelete}
        onClose={closeBlockMenu}
      />
    </main>
  );
}
