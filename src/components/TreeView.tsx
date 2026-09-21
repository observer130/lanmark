import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Palette,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { useVaultStore } from "../stores/vault";
import { FOLDER_COLOR_VARS } from "./CreateDialog";
import type { VaultNode } from "../lib/vault";

interface Props {
  onNavigate?: () => void;
  tree: VaultNode[];
}

/**
 * 内联重命名输入框。
 * 必须是有自己 state 的独立组件：value 绑定本组件 draft（实时显示输入）。
 * 曾踩坑：value 绑 node.name 而 onChange 写父级 draft → 每次击键被重置回原名，
 * 输入「不显示」直到 Enter 提交后才变化。
 */
function RenameInput({
  path,
  initial,
  onCommit,
  onCancel,
}: {
  path: string;
  initial: string;
  onCommit: (path: string, name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    const d = draft.trim();
    if (d) onCommit(path, d);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className="w-full min-w-0 rounded-md border border-accent bg-card px-1.5 py-0.5 text-sm text-ink outline-none focus:ring-2 focus:ring-accent/20"
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

/** 右键菜单项（C 风格：图标 + 文字，白卡浮层） */
function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Star;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas ${
        danger ? "text-red-600" : "text-ink"
      }`}
      onClick={onClick}
    >
      <Icon size={14} className={danger ? "text-red-500" : "text-ink-3"} />
      {label}
    </button>
  );
}

/** 目录树：扁平渲染（深度 = 路径段数），hover 显示操作，支持内联重命名与右键菜单 */
export function TreeView({ tree, onNavigate }: Props) {
  const activePath = useVaultStore((s) => s.activePath);
  const favorites = useVaultStore((s) => s.favorites);
  const renamingPath = useVaultStore((s) => s.renamingPath);
  const openNote = useVaultStore((s) => s.openNote);
  const commitRename = useVaultStore((s) => s.commitRename);
  const deleteNode = useVaultStore((s) => s.deleteNode);
  const toggleFavorite = useVaultStore((s) => s.toggleFavorite);
  const setRenaming = useVaultStore((s) => s.setRenaming);

  const favSet = new Set(favorites.map((f) => f.path));

  /* ── 展开/收起（状态在 vault store：新建/打开笔记时要能展开祖先目录） ── */
  const folderColors = useVaultStore((s) => s.folderColors);
  const openCreate = useVaultStore((s) => s.openCreate);
  const collapsedDirs = useVaultStore((s) => s.collapsedDirs);
  const toggleDirCollapsed = useVaultStore((s) => s.toggleDirCollapsed);
  const expandAncestors = useVaultStore((s) => s.expandAncestors);

  // 打开的笔记藏在收起目录里时，自动展开其全部祖先（否则用户找不到刚打开的笔记）
  useEffect(() => {
    if (activePath) expandAncestors(activePath);
  }, [activePath, expandAncestors]);

  // 展开态过滤：tree 是 DFS 前序扁平列表（子项紧跟父目录），收起 depth=d 的
  // 目录后，后续 depth>d 的节点整块属于其子树，直接跳过
  let hiddenUnderDepth: number | null = null;
  const visibleTree = tree.filter((node) => {
    const depth = node.path.split("/").length - 1;
    if (hiddenUnderDepth !== null) {
      if (depth > hiddenUnderDepth) return false;
      hiddenUnderDepth = null;
    }
    if (node.kind === "folder" && collapsedDirs.has(node.path)) {
      hiddenUnderDepth = depth;
    }
    return true;
  });

  // 右键上下文菜单（VSCode 式：新建入口在分区标题，行级操作在菜单里）
  const [menu, setMenu] = useState<{ x: number; y: number; node: VaultNode } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    // 捕获阶段监听：点菜单外任意处（含其它行）先关菜单
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent, node: VaultNode) => {
    e.preventDefault();
    // 视口内收口，避免菜单贴边溢出
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - 260));
    setMenu({ x, y, node });
  };

  const closeAnd = (fn: () => void) => {
    setMenu(null);
    fn();
  };

  return (
    <>
    <ul className="space-y-0.5">
      {tree.length === 0 && (
        <li className="px-3 py-2 text-xs text-ink-3">
          库是空的，点上方「+ 笔记」开始，或右键文件夹新建
        </li>
      )}
      {visibleTree.map((node) => {
        const depth = node.path.split("/").length - 1;
        const isNote = node.kind === "note";
        const isActive = node.path === activePath;
        const isRenaming = node.path === renamingPath;
        const isFav = favSet.has(node.path);
        const isCollapsed = collapsedDirs.has(node.path);
        const colorToken = isNote ? undefined : folderColors[node.path];

        return (
          <li key={node.path} className="group">
            <div
              className={`flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-1 hover:bg-canvas ${
                isActive
                  ? "bg-accent-soft font-medium text-accent-text"
                  : "text-ink"
              }`}
              style={{ paddingLeft: depth * 14 + 8 }}
              onClick={() => {
                if (isRenaming) return;
                if (isNote) {
                  void openNote(node.path);
                  onNavigate?.();
                } else {
                  toggleDirCollapsed(node.path);
                }
              }}
              aria-expanded={isNote ? undefined : !isCollapsed}
              onContextMenu={(e) => openMenu(e, node)}
            >
              {/* 展开/收起箭头：目录行显示，笔记行占位对齐（VS Code 式） */}
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {!isNote && (
                  <ChevronRight
                    size={13}
                    className={`text-ink-3 transition-transform ${
                      isCollapsed ? "" : "rotate-90"
                    }`}
                  />
                )}
              </span>

              {isNote ? (
                <FileText size={14} className="shrink-0 text-ink-3" />
              ) : (
                <Folder
                  size={15}
                  className="shrink-0"
                  style={colorToken ? { color: FOLDER_COLOR_VARS[colorToken] } : undefined}
                />
              )}

              {isRenaming ? (
                <RenameInput
                  key={`rename-${node.path}`}
                  path={node.path}
                  initial={isNote ? node.name.replace(/\.md$/, "") : node.name}
                  onCommit={(p, name) => void commitRename(p, name)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
              )}

              {/* 行内操作：h-5 w-5 与文本行高一致——曾用 p-1（21px）会撑高整行，
                  hover 时图标/文字因 items-center 下移约 0.5px（用户报障） */}
              {!isRenaming && (
                <span className="hidden h-5 shrink-0 items-center gap-0.5 group-hover:flex">
                  {isNote && (
                    <>
                      <button
                        title={isFav ? "取消收藏" : "收藏"}
                        className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-line/60"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleFavorite(node.path);
                        }}
                      >
                        <Star
                          size={13}
                          className={isFav ? "fill-amber-400 text-amber-400" : "text-ink-3"}
                        />
                      </button>
                      <button
                        title="重命名"
                        className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-line/60"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenaming(node.path);
                        }}
                      >
                        <Pencil size={13} className="text-ink-3" />
                      </button>
                    </>
                  )}
                  <button
                    title="删除（移入回收站）"
                    className="flex h-5 w-5 items-center justify-center rounded-md hover:bg-line/60"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteNode(node.path);
                    }}
                  >
                    <Trash2 size={13} className="text-ink-3 hover:text-red-500" />
                  </button>
                </span>
              )}
            </div>
          </li>
        );
      })}
      </ul>

      {/* 右键上下文菜单（VSCode 式：文件夹可新建子项，行级操作集中在此） */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[11rem] rounded-xl border border-line bg-card py-1 shadow-pop"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.node.kind === "folder" && (
            <>
              <MenuItem
                icon={FileText}
                label="新建笔记"
                onClick={() => closeAnd(() => openCreate("note", menu.node.path))}
              />
              <MenuItem
                icon={FolderPlus}
                label="新建文件夹"
                onClick={() => closeAnd(() => openCreate("folder", menu.node.path))}
              />
              <MenuItem
                icon={Palette}
                label="设置颜色…"
                onClick={() => closeAnd(() => openCreate("recolor", menu.node.path))}
              />
              <div className="my-1 h-px bg-line" />
            </>
          )}
          <MenuItem
            icon={Pencil}
            label="重命名"
            onClick={() => closeAnd(() => setRenaming(menu.node.path))}
          />
          {menu.node.kind === "note" && (
            <MenuItem
              icon={Star}
              label={favSet.has(menu.node.path) ? "取消收藏" : "收藏"}
              onClick={() => closeAnd(() => void toggleFavorite(menu.node.path))}
            />
          )}
          <div className="my-1 h-px bg-line" />
          <MenuItem
            icon={Trash2}
            label="删除（移入回收站）"
            danger
            onClick={() => closeAnd(() => void deleteNode(menu.node.path))}
          />
        </div>
      )}
    </>
  );
}
