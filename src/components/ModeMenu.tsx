import { BookOpen, Check, PenLine } from "lucide-react";

import type { EditorMode } from "../lib/settings";
import { useDismissable } from "./useDismissable";

/**
 * 窄屏的「编辑模式」菜单（M8 批次 2 顺带修）。
 *
 * 为什么把三个内联按钮收成一个：
 *  ① 原来的三段切换每段只有 **31px**，违反硬约定 13 的「窄屏触控目标 ≥44px」——批次 2 的
 *     验收标准明确要核这条，实测就是不合规。
 *  ② 385px 下头部本来就紧：加上「插入块」按钮后面包屑被挤到 **28px**（约 1 个字，等于不可读）。
 *     收成一个 44px 按钮后腾出约 50px，面包屑回到 ~82px = **与批次 2 之前持平**（不是回退）。
 *
 * 形态与块菜单、插入抽屉一致：底部抽屉 + 遮罩，行长 ≥44px。
 */
const MODES: { mode: EditorMode; label: string; icon: typeof BookOpen }[] = [
  { mode: "read", label: "阅读模式", icon: BookOpen },
  { mode: "wysiwyg", label: "所见即所得", icon: PenLine },
  { mode: "source", label: "源码模式", icon: Check },
];

export function ModeMenu({
  open,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  current: EditorMode;
  onPick: (mode: EditorMode) => void;
  onClose: () => void;
}) {
  const ref = useDismissable(open, onClose);
  if (!open) return null;

  return (
    <>
      {/* 遮罩**不挂 onClick**：点外部关闭由 useDismissable 的 pointerdown 负责。
            挂 onClick 会被「打开菜单那个手势的尾巴 click」立刻关掉——长按唤出时尤其明显
            （手指抬起时 click 落在刚出现的遮罩上，菜单只闪现几十毫秒，2026-10-16 真机实测） */}
        <div className="fixed inset-0 z-40 bg-black/30" />
      <div
        ref={ref}
        role="menu"
        aria-label="编辑模式"
        className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-line bg-card py-1 pb-[env(safe-area-inset-bottom)] shadow-pop"
      >
        {MODES.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            type="button"
            role="menuitem"
            onClick={() => onPick(mode)}
            className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-sm text-ink active:bg-canvas"
          >
            <Icon size={16} className="shrink-0 text-ink-2" />
            {label}
            {current === mode && <Check size={14} className="ml-auto text-acc" />}
          </button>
        ))}
      </div>
    </>
  );
}
