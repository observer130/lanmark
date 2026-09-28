import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileText, Folder, X } from "lucide-react";
import { useVaultStore } from "../stores/vault";
import type { VaultNode } from "../lib/vault";

/**
 * 新建笔记 / 新建文件夹 二合一对话框（晨窗样式）。
 * - 新建笔记：笔记名（可省略 .md，重名自动 -2）+ 路径（所在目录）
 * - 新建文件夹：文件夹名 + 路径（父目录，可建二级目录）
 * 两者卡片字段完全一致，只有措辞（笔记名/文件夹名）与默认名不同。
 *
 * 历史：曾有「目录显示颜色」功能（调色板 + .lanmark/folder-colors.json +
 * folder_colors/folder_color_set IPC），实际使用价值低且让两卡片字段不一致，
 * 已整体移除（前后端与样式 token 一并删）。
 */

/**
 * 位置选择（自绘下拉，替代原生 <select>）：
 * 原生下拉的展开列表跟随系统主题（KDE 深色列表），与应用风格割裂，
 * 且只能用空格做层级缩进、分级关系不明。这里用树序列表：
 * 实缩进 + 目录图标 + 完整路径回显，当前项打勾。
 *
 * 键盘：按钮上 ↑/↓ 直接展开并高亮（不移动焦点，焦点留在按钮上，
 * 这样 Esc「先收列表再关对话框」的既有顺序不受影响）；列表内 ↑/↓ 移动、
 * Enter 选中、Esc 收起。手写导航（原生 select 的替代品，无 roving tabindex）。
 */
function DirPicker({
  tree,
  value,
  onChange,
  onOpenChange,
}: {
  tree: VaultNode[];
  value: string;
  onChange: (dir: string) => void;
  /** 向对话框上报展开态：下拉展开时 Esc 只收起列表、不关对话框 */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 候选值：根目录 + 全部目录，顺序与树一致（DFS 前序），并带上显示用全路径
  const options = useMemo(() => {
    const folders = tree.filter((n) => n.kind === "folder");
    const paths = ["", ...folders.map((f) => f.path)];
    // 树里可能还没有该目录（例如设置里记下的「上次位置」已被删除）
    if (value && !paths.includes(value)) paths.splice(1, 0, value);
    return paths.map((p) => ({ path: p, label: p === "" ? "根目录" : p }));
  }, [tree, value]);

  const setOpenAndNotify = (o: boolean) => {
    setOpen(o);
    if (o) setActive(Math.max(0, options.findIndex((o2) => o2.path === value)));
    onOpenChange?.(o);
  };

  // 点组件外关闭（捕获阶段，点对话框其它区域也先收起列表）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenAndNotify(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenAndNotify(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 列表展开时把当前项滚进可视区（只在展开那一刻，之后不干预滚动：
  // 依赖里带 active 会让鼠标划过每一行都强制回落，用户没法滚列表）
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (dir: string) => {
    onChange(dir);
    setOpenAndNotify(false);
  };

  const move = (delta: number) => {
    if (!open) {
      setOpenAndNotify(true);
      return;
    }
    setActive((i) => Math.min(options.length - 1, Math.max(0, i + delta)));
  };

  const currentLabel = value === "" ? "根目录" : value;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpenAndNotify(false) : setOpenAndNotify(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" && open) {
            // 展开时 Enter 提交高亮项而不是提交对话框（此时表单尚未失焦，
            // input 的 Enter 处理器不会触发）
            e.preventDefault();
            pick((options[active] ?? options[0]).path);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mt-1 flex w-full items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink outline-none hover:border-accent/40 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
      >
        <Folder size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-left" title={value}>
          {currentLabel}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-card py-1 shadow-pop"
        >
          {options.map((o, i) => {
            const selected = o.path === value;
            const depth = o.path === "" ? 0 : o.path.split("/").length - 1;
            return (
              <button
                key={o.path || "__root__"}
                type="button"
                role="option"
                aria-selected={selected}
                data-index={i}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(o.path)}
                className={`flex w-full items-center gap-2 py-1.5 pr-2.5 text-left text-sm ${
                  i === active ? "bg-accent-soft" : "hover:bg-canvas"
                } ${selected ? "font-medium text-accent-text" : "text-ink"}`}
                style={{ paddingLeft: depth * 14 + 12 }}
              >
                <Folder size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1 truncate" title={o.label}>
                  {o.label}
                </span>
                {selected && <Check size={13} className="shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CreateDialog() {
  const pendingCreate = useVaultStore((s) => s.pendingCreate);
  const tree = useVaultStore((s) => s.tree);
  const closeCreate = useVaultStore((s) => s.closeCreate);
  const createNoteIn = useVaultStore((s) => s.createNoteIn);
  const createFolderIn = useVaultStore((s) => s.createFolderIn);

  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);

  const isNote = pendingCreate?.kind === "note";

  // 每次打开重置表单
  useEffect(() => {
    if (!pendingCreate) return;
    setName(pendingCreate.kind === "note" ? "未命名" : "新建文件夹");
    setDir(pendingCreate.parentDir);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreate]);

  // Esc 关闭（位置下拉展开时，Esc 只收起下拉——由 DirPicker 自行处理）
  const pickerOpenRef = useRef(false);
  useEffect(() => {
    if (!pendingCreate) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pickerOpenRef.current) closeCreate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingCreate, closeCreate]);

  if (!pendingCreate) return null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = isNote
        ? await createNoteIn(name.trim(), dir)
        : await createFolderIn(name.trim(), dir);
      if (ok) closeCreate();
    } finally {
      setBusy(false);
    }
  };

  // 名称输入框 Enter 提交（下拉展开时由 DirPicker 抢先处理并 preventDefault，
  // 这里只兜未展开的情形）
  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !pickerOpenRef.current) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeCreate();
      }}
    >
      <div className="w-[380px] max-w-full rounded-2xl border border-line bg-card p-5 shadow-pop">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
            {isNote ? <FileText size={15} className="text-ink-3" /> : <Folder size={15} className="text-ink-3" />}
            {isNote ? "新建笔记" : "新建文件夹"}
          </h2>
          <button
            onClick={closeCreate}
            title="关闭"
            className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4" onKeyDown={onFormKeyDown}>
          <label className="text-xs font-medium text-ink-2">
            {isNote ? "笔记名" : "文件夹名"}
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isNote ? "可省略 .md" : "可用 / 直接建多级目录，如 工作/面试"}
            className="mt-1 w-full rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
        </div>

        <div className="mt-3">
          <label className="text-xs font-medium text-ink-2">路径</label>
          <DirPicker
            tree={tree}
            value={dir}
            onChange={setDir}
            onOpenChange={(o) => (pickerOpenRef.current = o)}
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={closeCreate}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-canvas"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-40"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
