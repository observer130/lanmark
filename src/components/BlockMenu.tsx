import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { useDismissable } from "./useDismissable";

/**
 * 块菜单：对准 doc 顶层块的「上移 / 下移 / 删除」。
 *
 * 存在的理由（M8 G3）：Crepe 的块移动只走 HTML5 拖拽，触屏没有 `dragstart`、
 * 宿主也可能吞掉 HTML5 拖放——所以需要一个**不依赖拖拽**的入口。触发方式有三条，
 * 都汇聚到这个组件：
 *  ① 桌面：点左侧「六个点」手柄（见 `EditorPane` 的 DOM 代理监听）
 *  ② 桌面：在块上右键（`contextmenu`）
 *  ③ 窄屏：长按块（真机 WebView 长按即派发 `contextmenu`，硬约定 13）
 *
 * 布局：桌面是贴着点击位置的浮层；窄屏是底部抽屉（触控目标 ≥44px）。
 * 删除走 ProseMirror 的 history，`Ctrl+Z` 可撤销——所以不再加二次确认。
 */

export interface BlockMenuTarget {
  /** 目标块在 doc 直接子节点中的序号 */
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** doc 至少保留一个块（schema 是 block+），只剩一块时删除置灰 */
  canDelete: boolean;
  /** 客户端坐标（桌面浮层锚定用）；窄屏忽略 */
  x: number;
  y: number;
}

interface BlockMenuProps {
  target: BlockMenuTarget | null;
  narrow: boolean;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** 浮层估高/估宽：只用于把浮层夹回视口内，不影响实际布局 */
const MENU_W = 168;
const MENU_H = 132;
const GAP = 8;

function MenuItem({
  icon: Icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof ArrowUp;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-sm disabled:opacity-40 md:min-h-0 md:py-1.5 ${
        danger ? "text-warn" : "text-ink"
      } ${disabled ? "cursor-default" : "hover:bg-canvas"}`}
    >
      <Icon size={15} className="shrink-0" />
      {label}
    </button>
  );
}

export function BlockMenu({ target, narrow, onMove, onDelete, onClose }: BlockMenuProps) {
  // 抽屉（窄屏）不监听滚动/缩放，只有贴锚点的桌面浮层才需要（见 useDismissable 注释）
  const ref = useDismissable(!!target, onClose, !narrow);

  if (!target) return null;

  const body = (
    <>
      <MenuItem
        icon={ArrowUp}
        label="上移"
        disabled={!target.canMoveUp}
        onClick={() => onMove(-1)}
      />
      <MenuItem
        icon={ArrowDown}
        label="下移"
        disabled={!target.canMoveDown}
        onClick={() => onMove(1)}
      />
      <div className="my-0.5 h-px bg-line" />
      <MenuItem
        icon={Trash2}
        label="删除本块"
        danger
        disabled={!target.canDelete}
        onClick={onDelete}
      />
    </>
  );

  // 窄屏：底部抽屉 + 遮罩（与侧栏抽屉同一套语言）
  if (narrow) {
    return (
      <>
        {/* 遮罩**不挂 onClick**：点外部关闭由 useDismissable 的 pointerdown 负责。
            挂 onClick 会被「打开菜单那个手势的尾巴 click」立刻关掉——长按唤出时尤其明显
            （手指抬起时 click 落在刚出现的遮罩上，菜单只闪现几十毫秒，2026-10-16 真机实测） */}
        <div className="fixed inset-0 z-40 bg-black/30" />
        <div
          ref={ref}
          role="menu"
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-card pb-[env(safe-area-inset-bottom)] shadow-pop"
        >
          <div className="py-1">{body}</div>
        </div>
      </>
    );
  }

  // 桌面：贴着点击位置，夹回视口内
  const left = Math.max(GAP, Math.min(target.x, window.innerWidth - MENU_W - GAP));
  const top = Math.max(GAP, Math.min(target.y, window.innerHeight - MENU_H - GAP));
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: MENU_W }}
      className="fixed z-50 rounded-lg border border-line bg-card py-1 shadow-pop"
    >
      {body}
    </div>
  );
}
