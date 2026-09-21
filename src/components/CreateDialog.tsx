import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Folder, X } from "lucide-react";
import { useVaultStore } from "../stores/vault";
import type { VaultNode } from "../lib/vault";

/**
 * 新建笔记 / 新建文件夹 / 文件夹配色 三合一对话框（晨窗样式）。
 * - 新建文件夹：名称 + 颜色（默认无色；绿/琥珀/蓝为设计系统功能色）
 * - 新建笔记：名称（可省略 .md，重名自动 -2）+ 所在目录（层级下拉）
 * - 文件夹配色：只选颜色，预选当前色，选「默认」清除
 * 目录颜色取代旧的「顶层目录名哈希取色」（用户反馈随机分配意义不明）。
 */

/** 颜色 token → CSS 变量（TreeView 与调色板共用） */
export const FOLDER_COLOR_VARS: Record<string, string> = {
  fd1: "var(--c-fd-1)",
  fd2: "var(--c-fd-2)",
  fd3: "var(--c-fd-3)",
};

const FOLDER_COLOR_LABELS: [string, string][] = [
  ["fd1", "绿"],
  ["fd2", "琥珀"],
  ["fd3", "蓝"],
];

function Swatch({
  selected,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-shadow ${
        selected
          ? "border-accent bg-accent-soft ring-2 ring-accent/30"
          : "border-line bg-canvas hover:bg-line/40"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 位置选择（自绘下拉，替代原生 <select>）：
 * 原生下拉的展开列表跟随系统主题（KDE 深色列表），与应用风格割裂，
 * 且只能用空格做层级缩进、分级关系不明。这里用树序列表：
 * 实缩进 + 连接引导线 + 目录图标（含用户设置的颜色），当前项打勾。
 */
function DirPicker({
  tree,
  folderColors,
  value,
  onChange,
  onOpenChange,
}: {
  tree: VaultNode[];
  folderColors: Record<string, string>;
  value: string;
  onChange: (dir: string) => void;
  /** 向对话框上报展开态：下拉展开时 Esc 只收起列表、不关对话框 */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const setOpenAndNotify = (o: boolean) => {
    setOpen(o);
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

  // 列表展开时把当前选中项滚进可视区
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>("[data-selected='true']");
    el?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const folders = tree.filter((n) => n.kind === "folder");
  const currentLabel = value === "" ? "根目录" : (value.split("/").pop() ?? value);

  const pick = (dir: string) => {
    onChange(dir);
    setOpenAndNotify(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpenAndNotify(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="mt-1 flex w-full items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink outline-none hover:border-accent/40 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
      >
        <Folder
          size={14}
          className="shrink-0 text-ink-3"
          style={
            value && folderColors[value]
              ? { color: FOLDER_COLOR_VARS[folderColors[value]] }
              : undefined
          }
        />
        <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
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
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            data-selected={value === ""}
            onClick={() => pick("")}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-canvas ${
              value === "" ? "bg-accent-soft font-medium text-accent-text" : "text-ink"
            }`}
            style={{ paddingLeft: 12 }}
          >
            <Folder size={14} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate">根目录</span>
            {value === "" && <Check size={13} className="shrink-0 text-accent" />}
          </button>
          {folders.map((f) => {
            const depth = f.path.split("/").length - 1;
            const selected = value === f.path;
            const token = folderColors[f.path];
            return (
              <button
                key={f.path}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                onClick={() => pick(f.path)}
                className={`flex w-full items-center gap-2 py-1.5 pr-2.5 text-left text-sm hover:bg-canvas ${
                  selected ? "bg-accent-soft font-medium text-accent-text" : "text-ink"
                }`}
                style={{ paddingLeft: depth * 14 + 12 }}
              >
                <Folder
                  size={14}
                  className="shrink-0"
                  style={{ color: token ? FOLDER_COLOR_VARS[token] : "var(--c-ink-3)" }}
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
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
  const folderColors = useVaultStore((s) => s.folderColors);
  const closeCreate = useVaultStore((s) => s.closeCreate);
  const createNoteIn = useVaultStore((s) => s.createNoteIn);
  const createFolderIn = useVaultStore((s) => s.createFolderIn);
  const setFolderColor = useVaultStore((s) => s.setFolderColor);

  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kind = pendingCreate?.kind;

  // 每次打开重置表单（recolor 预选当前颜色）
  useEffect(() => {
    if (!pendingCreate) return;
    setName(pendingCreate.kind === "note" ? "未命名" : "新建文件夹");
    setDir(pendingCreate.parentDir);
    setColor(
      pendingCreate.kind === "recolor"
        ? (folderColors[pendingCreate.parentDir] ?? null)
        : null,
    );
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
  const isNote = kind === "note";
  const isRecolor = kind === "recolor";
  const title = isNote ? "新建笔记" : isRecolor ? "文件夹颜色" : "新建文件夹";

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let ok: boolean;
      if (isNote) ok = await createNoteIn(name.trim(), dir);
      else if (kind === "folder") ok = await createFolderIn(name.trim(), dir, color);
      else ok = await setFolderColor(pendingCreate.parentDir, color);
      if (ok) closeCreate();
    } finally {
      setBusy(false);
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
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <button
            onClick={closeCreate}
            title="关闭"
            className="rounded-md p-1 text-ink-3 hover:bg-canvas hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        {!isRecolor && (
          <div className="mt-4">
            <label className="text-xs font-medium text-ink-2">
              {isNote ? "笔记名" : "文件夹名"}
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder={isNote ? "可省略 .md" : ""}
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
            />
          </div>
        )}

        {isNote && (
          <div className="mt-3">
            <label className="text-xs font-medium text-ink-2">位置</label>
            <DirPicker
              tree={tree}
              folderColors={folderColors}
              value={dir}
              onChange={setDir}
              onOpenChange={(o) => (pickerOpenRef.current = o)}
            />
          </div>
        )}

        {kind !== "note" && (
          <div className="mt-3">
            <label className="text-xs font-medium text-ink-2">颜色</label>
            <div className="mt-1.5 flex items-center gap-2">
              <Swatch
                selected={color === null}
                onClick={() => setColor(null)}
                title="默认（无颜色）"
              >
                <Folder size={15} className="text-ink-3" />
              </Swatch>
              {FOLDER_COLOR_LABELS.map(([token, label]) => (
                <Swatch
                  key={token}
                  selected={color === token}
                  onClick={() => setColor(token)}
                  title={label}
                >
                  <Folder size={15} style={{ color: FOLDER_COLOR_VARS[token] }} />
                </Swatch>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={closeCreate}
            className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-canvas"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || (!isRecolor && !name.trim())}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white shadow-slider hover:bg-accent-text disabled:opacity-40"
          >
            {isRecolor ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
