import { useEffect, useRef, useState } from "react";
import { FolderPlus, History, Plus, RefreshCw, Search, Star } from "lucide-react";
import { useVaultStore } from "../stores/vault";
import { TreeView } from "./TreeView";
import { SyncSection } from "./SyncSection";
import { CreateDialog } from "./CreateDialog";
import { dragWindow, isLinuxDesktop } from "./WindowControls";
import type { PathTitle } from "../lib/vault";

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 mt-4 px-3 text-[11px] font-medium text-ink-3">{children}</div>
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

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const {
    tree,
    vaultPath,
    searchQuery,
    searchResults,
    recents,
    favorites,
    openNote,
    openCreate,
    doSearch,
    reindex,
  } = useVaultStore();
  const [q, setQ] = useState(searchQuery);

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

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-side">
      {/* 头部（Linux 无边框窗口：空白处可拖拽窗口，双击最大化） */}
      <div
        onMouseDown={isLinuxDesktop ? dragWindow : undefined}
        className="flex items-center gap-2 px-3 py-3"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white shadow-slider">
          L
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Lanmark</div>
          <div className="truncate text-[11px] text-ink-3" title={vaultPath ?? ""}>
            {vaultPath ?? ""}
          </div>
        </div>
        <button
          title="重新扫描 vault（外部改动后点这个）"
          className="rounded-md p-1.5 text-ink-3 hover:bg-canvas hover:text-ink"
          onClick={() => void reindex()}
        >
          <RefreshCw size={14} />
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
            className="w-full rounded-[10px] border border-line bg-card py-1.5 pl-8 pr-3 text-sm text-ink shadow-card outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
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
            {/* 收藏 */}
            <SectionLabel>收藏</SectionLabel>
            <MetaList items={favorites} starred onOpen={openNoteAndClose} />

            {/* 最近 */}
            <SectionLabel>最近</SectionLabel>
            <MetaList items={recents} onOpen={openNoteAndClose} />

            {/* 笔记本树：新建入口统一在标题右侧（交互修正，见 design/direction-approved.md）；
                点击弹对话框（命名 + 配色 / 选位置），不再「先建默认名再内联重命名」 */}
            <div className="mb-1 mt-4 flex items-center justify-between pl-3 pr-1">
              <span className="text-[11px] font-medium text-ink-3">笔记本</span>
              <span className="flex gap-0.5">
                <button
                  title="新建笔记"
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-canvas hover:text-ink"
                  onClick={() => openCreate("note", "")}
                >
                  <Plus size={12} />
                  笔记
                </button>
                <button
                  title="新建文件夹"
                  className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-canvas hover:text-ink"
                  onClick={() => openCreate("folder", "")}
                >
                  <FolderPlus size={12} />
                  文件夹
                </button>
              </span>
            </div>
            <TreeView tree={tree} onNavigate={onNavigate} />
          </>
        )}
      </div>

      {/* M2 同步（方案 B 收纳，design/direction-approved.md）：
          常驻只剩一行（状态+开关+同步），管理/配对在点击行后的上拉面板里 */}
      <SyncSection />

      {/* 新建笔记 / 新建文件夹 / 文件夹配色 对话框 */}
      <CreateDialog />
    </aside>
  );
}
