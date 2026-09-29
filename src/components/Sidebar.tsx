import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FileText,
  Folder,
  FolderPlus,
  History,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Star,
} from "lucide-react";
import { useVaultStore } from "../stores/vault";
import { TreeView } from "./TreeView";
import { SyncSection } from "./SyncSection";
import { useSettingsStore } from "../stores/settings";
import { CreateDialog } from "./CreateDialog";
import { AppMark } from "./AppMark";
import { dragWindow, isLinuxDesktop } from "./WindowControls";
import type { PathTitle, TrashEntry } from "../lib/vault";

/** 收藏/回收站收起时的预览条数（v0.5.1：默认 3 条 + 窄展开栏） */
const SECTION_PREVIEW = 3;

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 mt-4 px-3 text-[11px] font-medium text-ink-3">{children}</div>
  );
}

/**
 * 窄展开栏：收起时显示「展开全部 N 项」，展开后变「收起」。
 * 箭头随状态旋转给足反馈；触控目标 44px 仅窄屏（硬约定 13）。
 */
function ExpandRow({
  expanded,
  count,
  onToggle,
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      className="mt-0.5 flex min-h-[44px] w-full items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-ink-3 hover:bg-canvas hover:text-ink-2 md:min-h-0 md:py-0.5"
    >
      <ChevronDown
        size={12}
        className={`shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
      />
      {expanded ? "收起" : `展开全部 ${count} 项`}
    </button>
  );
}

function MetaList({
  items,
  onOpen,
  starred,
}: {
  items: PathTitle[];
  onOpen: (path: string) => void;
  starred?: boolean;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((it) => (
        <li key={it.path}>
          <button
            onClick={() => onOpen(it.path)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-2 hover:bg-canvas hover:text-ink"
          >
            {starred ? (
              <Star size={13} className="shrink-0 fill-amber-400 text-amber-400" />
            ) : (
              <History size={13} className="shrink-0 text-ink-3" />
            )}
            <span className="min-w-0 flex-1 truncate">{it.title}</span>
          </button>
        </li>
      ))}
      {items.length === 0 && <li className="px-3 py-1 text-xs text-ink-3">暂无</li>}
    </ul>
  );
}

/** 收藏分区（v0.5.1 起可折叠：默认 3 条 + 展开栏，状态在 vault store 按 vault 持久化） */
function FavoritesSection({
  items,
  expanded,
  onToggle,
  onOpen,
}: {
  items: PathTitle[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      <SectionLabel>收藏</SectionLabel>
      <MetaList items={expanded ? items : items.slice(0, SECTION_PREVIEW)} onOpen={onOpen} starred />
      {items.length > SECTION_PREVIEW && (
        <ExpandRow expanded={expanded} count={items.length} onToggle={onToggle} />
      )}
    </>
  );
}

/** 删除时刻的相对时间（回收站副标题） */
function relTime(ms: number | null): string {
  if (ms === null) return "未知时间";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 回收站条目行：与收藏/最近同构的单行（统一高度）；来源/删除时刻收进 hover 提示 */
function TrashRow({ item, onRestore }: { item: TrashEntry; onRestore: (p: string) => void }) {
  const tip =
    (item.origin ? `来自 ${item.origin}` : "无来源记录（恢复到根目录）") +
    (item.deletedAt !== null ? ` · 删除于 ${relTime(item.deletedAt)}` : "");
  return (
    <li
      title={tip}
      className="flex min-h-[44px] items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-canvas hover:text-ink md:min-h-0"
    >
      <span className="shrink-0 text-ink-3">
        {item.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {/* 常驻（手机无 hover 不能靠显隐）；md:h-5 与树行内联按钮同尺寸，不撑高行 */}
      <button
        title="恢复"
        aria-label={`恢复 ${item.name}`}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-line/60 hover:text-ink md:h-5 md:w-5"
        onClick={() => onRestore(item.trashPath)}
      >
        <RotateCcw size={13} />
      </button>
    </li>
  );
}

/** 回收站分区：预览 3 条 + 展开栏；空态一句话。恢复动作即时生效（无破坏性） */
function TrashSection({
  items,
  expanded,
  onToggle,
  onRestore,
}: {
  items: TrashEntry[];
  expanded: boolean;
  onToggle: () => void;
  onRestore: (p: string) => void;
}) {
  return (
    <>
      <div className="mb-1 mt-4 flex items-center justify-between pl-3 pr-2">
        <span className="text-[11px] font-medium text-ink-3">回收站</span>
        {items.length > 0 && (
          <span className="text-[11px] text-ink-3" title="回收站条目数">
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-1 text-xs text-ink-3">回收站为空</div>
      ) : (
        <>
          <ul className="space-y-0.5">
            {(expanded ? items : items.slice(0, SECTION_PREVIEW)).map((it) => (
              <TrashRow key={it.trashPath} item={it} onRestore={onRestore} />
            ))}
          </ul>
          {items.length > SECTION_PREVIEW && (
            <ExpandRow expanded={expanded} count={items.length} onToggle={onToggle} />
          )}
        </>
      )}
    </>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const {
    tree,
    vaultPath,
    searchQuery,
    searchResults,
    recents,
    favorites,
    trash,
    expandedSections,
    openNote,
    openCreate,
    doSearch,
    toggleMetaSection,
    restoreFromTrash,
  } = useVaultStore();
  const [q, setQ] = useState(searchQuery);

  /** 恢复回收站条目（store 里会刷新树/meta 并展开祖先目录） */
  const restore = (trashPath: string) => {
    void restoreFromTrash(trashPath);
  };

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => void doSearch(q), 250);
    return () => clearTimeout(t);
  }, [q, doSearch]);

  // 外部操作清空 store 查询（从树/最近/收藏开笔记）时同步清空输入框，
  // 否则侧栏停留在旧搜索结果视图（本地 q 与 store searchQuery 脱钩）
  const prevQuery = useRef(searchQuery);
  useEffect(() => {
    const prev = prevQuery.current;
    prevQuery.current = searchQuery;
    if (prev !== "" && searchQuery === "" && q !== "") {
      setQ("");
    }
  }, [searchQuery, q]);

  /** 窄屏抽屉模式：打开笔记后收起侧栏 */
  const openNoteAndClose = (path: string) => {
    void openNote(path);
    onNavigate?.();
  };

  // 窄屏时抽屉容器已是 w-full；aside 用 w-full 填满，桌面保留固定 288px 栏宽。
  // 硬约定 6：窄屏断点双源——这里用 Tailwind 的 md:（768px），
  // 与 App.tsx 的 useIsNarrow（<768）和 index.css 的 767.98px 同一阈值。
  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-line bg-side md:w-72">
      {/* 头部（Linux 无边框窗口：空白处可拖拽窗口，双击最大化） */}
      <div
        onMouseDown={isLinuxDesktop ? dragWindow : undefined}
        className="flex items-center gap-2 px-3 py-3"
      >
        <AppMark size={28} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Lanmark</div>
          <div className="truncate text-[11px] text-ink-3" title={vaultPath ?? ""}>
            {vaultPath ?? ""}
          </div>
        </div>
        {/* M4f 收尾（用户反馈）：「重新扫描」从顶栏移到「设置 → 存储」——
            它与设置页那个按钮完全重复，而设置入口原先独占底部一整行横幅太占位置。
            重索引在开库与每回合同步时都会自动跑，这个按钮只在「外部程序改了
            vault 且不想等同步」时才需要，属低频操作，收进设置页更合理。 */}
        {/* 触控 44px 仅窄屏；md: 恢复桌面紧凑尺寸（原 p-1.5，约 26px，硬约定 13） */}
        <button
          title="设置"
          aria-label="设置"
          className="flex h-11 w-11 items-center justify-center rounded-md text-ink-3 hover:bg-canvas hover:text-ink md:h-auto md:w-auto md:p-1.5"
          onClick={() => {
            useSettingsStore.getState().openDialog();
            onNavigate?.();
          }}
        >
          <Settings size={14} />
        </button>
      </div>

      {/* 搜索框：白卡 + focus 靛蓝柔 ring */}
      <div className="px-3 pt-1">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3">
            <Search size={14} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索笔记…"
            className="w-full min-h-[44px] rounded-[10px] border border-line bg-card py-1.5 pl-8 pr-3 text-sm text-ink shadow-card outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 md:min-h-0"
          />
        </div>
      </div>

      <div className="mt-1 flex-1 overflow-y-auto px-2 pb-3">
        {q.trim() ? (
          /* 搜索结果 */
          <ul className="space-y-0.5">
            {searchResults.map((r) => (
              <li key={r.path}>
                <button
                  onClick={() => {
                    openNoteAndClose(r.path);
                    setQ("");
                  }}
                  className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-canvas"
                >
                  <div className="truncate text-sm text-ink">{r.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-ink-3">
                    {r.snippet || r.path}
                  </div>
                </button>
              </li>
            ))}
            {searchResults.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-ink-3">
                没有匹配「{q}」的笔记
              </li>
            )}
          </ul>
        ) : (
          <>
            {/* 收藏（v0.5.1 起可折叠：默认 3 条 + 展开栏） */}
            <FavoritesSection
              items={favorites}
              expanded={expandedSections.has("favorites")}
              onToggle={() => toggleMetaSection("favorites")}
              onOpen={openNoteAndClose}
            />

            {/* 最近：固定 3 条（store 已截断），不折叠（v0.5.1 定版） */}
            <SectionLabel>最近</SectionLabel>
            <MetaList items={recents} onOpen={openNoteAndClose} />

            {/* 笔记本树：新建入口统一在标题右侧。
                点击弹对话框（命名 + 选位置），不再「先建默认名再内联重命名」。
                M4i：手机上这里是**唯一**的新建入口 —— 曾加过编辑器右下角的
                悬浮按钮（FAB），但它悬在正文上挡字，且「新建」是导航/管理动作，
                属于侧栏而非编辑器，已移除。按钮触控尺寸 44px（硬约定 13）。 */}
            <div className="mb-1 mt-4 flex items-center justify-between pl-3 pr-1">
              <span className="text-[11px] font-medium text-ink-3">笔记本</span>
              <span className="flex gap-0.5">
                <button
                  title="新建笔记"
                  aria-label="新建笔记"
                  className="flex h-11 items-center gap-1 rounded-md px-2 text-[11px] text-ink-3 hover:bg-canvas hover:text-ink md:h-7 md:px-1.5 md:py-0.5"
                  onClick={() => openCreate("note", "")}
                >
                  <Plus size={12} />
                  笔记
                </button>
                <button
                  title="新建文件夹"
                  aria-label="新建文件夹"
                  className="flex h-11 items-center gap-1 rounded-md px-2 text-[11px] text-ink-3 hover:bg-canvas hover:text-ink md:h-7 md:px-1.5 md:py-0.5"
                  onClick={() => openCreate("folder", "")}
                >
                  <FolderPlus size={12} />
                  文件夹
                </button>
              </span>
            </div>
            <TreeView tree={tree} onNavigate={onNavigate} />

            {/* 回收站（v0.5.1）：`.lanmark/trash` 的条目，可恢复到删除前位置。
                放在笔记本树之后（顺序：收藏—最近—笔记本—回收站）。
                条目不可打开（trash 里的笔记不属于工作区），只提供恢复。 */}
            <TrashSection
              items={trash}
              expanded={expandedSections.has("trash")}
              onToggle={() => toggleMetaSection("trash")}
              onRestore={restore}
            />
          </>
        )}
      </div>

      {/* M2 同步（方案 B 收纳，design/direction-approved.md）：
          常驻只剩一行（状态+开关+同步），管理/配对在点击行后的上拉面板里 */}
      <SyncSection />

      {/* 新建笔记 / 新建文件夹 对话框 */}
      <CreateDialog />
    </aside>
  );
}
