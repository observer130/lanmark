import type { OutlineItem } from "../lib/outline";
import { useActiveHeading } from "./useOutline";

/** 大纲行（桌面侧栏与移动端底部抽屉共用，缩进/高亮只有这一份）。 */
export function OutlineList({
  items,
  onPick,
}: {
  items: OutlineItem[];
  onPick: (item: OutlineItem) => void;
}) {
  const active = useActiveHeading(items);

  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const isActive = active === it.index;
        return (
          <li key={`${it.line}-${it.index}`}>
            <button
              type="button"
              onClick={() => onPick(it)}
              aria-current={isActive ? "location" : undefined}
              title={it.text || "（无标题）"}
              className={`flex min-h-[44px] w-full items-center rounded-lg py-1 pr-2 text-left text-sm md:min-h-0 md:py-0.5 ${
                isActive
                  ? "bg-accent-soft font-medium text-accent-text"
                  : "text-ink-2 hover:bg-canvas hover:text-ink"
              }`}
              style={{ paddingLeft: 8 + (it.level - 1) * 14 }}
            >
              <span className="min-w-0 flex-1 truncate">
                {it.text || "（无标题）"}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
