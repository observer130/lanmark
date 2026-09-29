import { useEffect, useRef, useState } from "react";
import { FilePlus2, FolderPlus, Plus, X } from "lucide-react";
import { useVaultStore } from "../stores/vault";

/**
 * M4i 移动端新建入口：右下角悬浮按钮（FAB）。
 *
 * 为什么加它：新建入口原先是「笔记本」分区标题右侧的两个小号文字按钮
 * （`+ 笔记` / `+ 文件夹`），在手机上只有 ~20px 高，既小又挤在标题行里，
 * 单手够不到。Gmail / Obsidian Mobile / Notion 都是右下角 FAB 弹双选项，
 * 拇指自然可达，且不占标题行空间。
 *
 * 只在窄屏渲染（由调用方控制）；宽屏保留侧栏里的入口，行为不变。
 */
export function NewEntryFab() {
  const openCreate = useVaultStore((s) => s.openCreate);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 收起（与 TreeView 菜单同套交互）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const pick = (kind: "note" | "folder") => {
    setOpen(false);
    openCreate(kind, "");
  };

  return (
    <div ref={wrapRef} className="fixed bottom-5 right-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-card shadow-pop">
          <button
            onClick={() => pick("note")}
            className="flex min-h-[44px] items-center gap-2.5 px-4 text-sm text-ink hover:bg-canvas"
          >
            <FilePlus2 size={16} className="text-ink-3" />
            新建笔记
          </button>
          <div className="h-px bg-line" />
          <button
            onClick={() => pick("folder")}
            className="flex min-h-[44px] items-center gap-2.5 px-4 text-sm text-ink hover:bg-canvas"
          >
            <FolderPlus size={16} className="text-ink-3" />
            新建文件夹
          </button>
        </div>
      )}
      <button
        aria-label={open ? "收起新建菜单" : "新建"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-white shadow-pop"
      >
        {open ? <X size={22} /> : <Plus size={24} />}
      </button>
    </div>
  );
}
