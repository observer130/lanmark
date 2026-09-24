import { useEffect, useRef } from "react";
import { BookOpen, Check, Code, Folder, NotebookText, PenLine, Star } from "lucide-react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
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

/** WYSIWYG 编辑器宿主（Crepe）：切换笔记/模式时整体重建，避免状态残留。
 *  readOnly=true 时为「阅读模式」：关掉斜杠菜单/块手柄/链接浮层等交互特性，
 *  并将 ProseMirror 设为不可编辑（粘贴/拖入监听也一并跳过）。 */
function MilkdownHost({
  content,
  notePath,
  onChange,
  readOnly = false,
}: {
  content: string;
  notePath: string;
  onChange: (md: string) => void;
  readOnly?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      crepe = new Crepe({
        root: inner,
        defaultValue: editorBody,
        features: {
          // 精简：关掉 AI 光标 / 顶栏；阅读模式再关掉全部交互特性
          [CrepeFeature.AI]: false,
          [CrepeFeature.Cursor]: false,
          [CrepeFeature.TopBar]: false,
          // ImageBlock 关闭：其序列化会把缩放比例写进 alt（![1.00](…)），
          // 破坏原始 markdown。图片走 commonmark 原生节点：粘贴（insertImageCommand）或手写 ![](...)
          [CrepeFeature.ImageBlock]: false,
          [CrepeFeature.Latex]: true,
          [CrepeFeature.Table]: true,
          [CrepeFeature.CodeMirror]: true,
          [CrepeFeature.Toolbar]: !readOnly, // 斜杠菜单
          [CrepeFeature.BlockEdit]: !readOnly, // 左侧 +/拖拽手柄
          [CrepeFeature.ListItem]: true,
          [CrepeFeature.LinkTooltip]: !readOnly,
          [CrepeFeature.Placeholder]: true,
        },
      });
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
        (host as HTMLDivElement & { __lanmarkCleanup?: () => void }).__lanmarkCleanup = () => {
          host.removeEventListener("paste", onPaste);
          host.removeEventListener("dragover", onDragOver);
          host.removeEventListener("drop", onDrop);
        };
      }
    })();

    return () => {
      cancelled = true;
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

  if (!activePath) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* Linux 无边框窗口：未开笔记也要有拖拽区与窗控（验收修正：窗控必须永远可达）。
            padding 与有笔记时的头部保持一致，避免开笔记前后窗控横移 */}
        {isLinuxDesktop && (
          <div
            onMouseDown={dragWindow}
            className={`flex items-center gap-2 py-2.5 ${
              narrow ? "pl-14 pr-2" : "px-4"
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
          narrow ? "pl-14 pr-2" : "px-4"
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
    </main>
  );
}
