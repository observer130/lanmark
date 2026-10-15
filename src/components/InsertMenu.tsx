import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Sigma,
  Table,
} from "lucide-react";

import { BLOCK_ITEMS, type BlockItem, type BlockKind } from "../milkdown/block-insert";
import { useDismissable } from "./useDismissable";

/**
 * 「插入块」底部抽屉（M8 批次 2）——移动端补上桌面 hover「+」的等价能力。
 *
 * 为什么必须有它：窄屏没有 hover，Crepe 的 hover「+」与块手柄都靠 `pointermove` 悬浮显示，
 * 触屏一滚动就发 `pointercancel` 掐断（硬约定 13）——所以「插入标题/代码块」这条能力在手机上
 * 完全够不着。输入 `/` 能唤出 Crepe 的斜杠菜单，但依赖键盘、且没人知道。
 *
 * 形态：**底部抽屉**（与块菜单同一套语言），触控目标 ≥44px。桌面端不需要它（hover「+」够用），
 * 所以本组件只在窄屏渲染，不做浮层分支——真要在桌面也用，再加 popover 分支。
 */
const ICONS: Record<BlockKind, typeof Pilcrow> = {
  text: Pilcrow,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  h4: Heading3,
  h5: Heading3,
  h6: Heading3,
  bullet: List,
  ordered: ListOrdered,
  task: ListChecks,
  quote: Quote,
  divider: Minus,
  code: Code,
  table: Table,
  math: Sigma,
};

const GROUPS: BlockItem["group"][] = ["文本", "列表", "高级"];

export function InsertMenu({
  open,
  onPick,
  onClose,
}: {
  open: boolean;
  onPick: (kind: BlockKind) => void;
  onClose: () => void;
}) {
  const ref = useDismissable(open, onClose);
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label="插入块"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-line bg-card pb-[env(safe-area-inset-bottom)] shadow-pop"
      >
        {GROUPS.map((group) => (
          <div key={group} className="border-b border-line last:border-b-0">
            <div className="px-3 pt-2 pb-1 text-[11px] text-ink-3">{group}</div>
            <div className="grid grid-cols-2 gap-x-1 px-1 pb-1">
              {BLOCK_ITEMS.filter((i) => i.group === group).map((item) => {
                const Icon = ICONS[item.kind];
                return (
                  <button
                    key={item.kind}
                    type="button"
                    role="menuitem"
                    onClick={() => onPick(item.kind)}
                    className="flex min-h-[44px] items-center gap-2 rounded-lg px-2 text-left text-sm text-ink active:bg-canvas"
                  >
                    <Icon size={16} className="shrink-0 text-ink-2" />
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
