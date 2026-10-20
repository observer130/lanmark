import { ListTree } from "lucide-react";
import { useVaultStore } from "../stores/vault";
import { useOutlineStore } from "../stores/outline";
import { useOutlineItems } from "./useOutline";
import { OutlineList } from "./OutlineList";

/** 桌面侧栏的大纲面板（“文件 / 大纲”切到后者时渲染）。 */
export function OutlinePanel() {
  const activePath = useVaultStore((s) => s.activePath);
  const items = useOutlineItems();
  const jump = useOutlineStore((s) => s.jump);

  if (!activePath) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-xs text-ink-3">
        <ListTree size={22} className="text-ink-3/70" />
        打开一篇笔记后显示目录
      </div>
    );
  }

  const name = activePath.split("/").pop()?.replace(/\.md$/i, "") ?? activePath;

  return (
    <>
      <div className="mb-1 mt-2 flex items-center justify-between gap-2 px-2">
        <span className="min-w-0 truncate text-[11px] text-ink-3" title={activePath}>
          {name}
        </span>
        <span className="shrink-0 text-[11px] text-ink-3">{items.length} 个标题</span>
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-ink-3">
          这篇笔记还没有 1–3 级标题
        </div>
      ) : (
        <OutlineList items={items} onPick={(item) => jump(activePath, item)} />
      )}
    </>
  );
}
