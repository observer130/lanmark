import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Linux 桌面无边框窗口（decorations:false，见 tauri.linux.conf.json）的自绘标题件：
 * - WindowControls：最小化 / 最大化切换 / 关闭（KDE 习惯：关闭悬停变红）
 * - dragWindow：头部空白处 mousedown → startDragging，双击 → 最大化/还原
 * - ResizeEdges：无边框后 GTK/WM 不再提供边缘缩放，用隐形边缘 + startResizeDragging 补齐
 *
 * 仅桌面 Linux 启用（isLinuxDesktop 守卫）；Android / Windows 不受影响，
 * Windows 如需同款可后续把 decorations:false 挪进 windows 平台配置。
 */

export const isLinuxDesktop =
  !navigator.userAgent.includes("Android") && navigator.userAgent.includes("Linux");

const appWindow = getCurrentWindow();

/** 窗控按钮组（放在编辑器头部最右端） */
export function WindowControls() {
  return (
    <div className="ml-1 flex shrink-0 items-center gap-0.5">
      <button
        title="最小化"
        aria-label="最小化"
        className="rounded-md p-1.5 text-ink-3 hover:bg-ink/10 hover:text-ink"
        onClick={() => void appWindow.minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        title="最大化 / 还原"
        aria-label="最大化或还原"
        className="rounded-md p-1.5 text-ink-3 hover:bg-ink/10 hover:text-ink"
        onClick={() => void appWindow.toggleMaximize()}
      >
        <Square size={12} />
      </button>
      <button
        title="关闭"
        aria-label="关闭"
        className="rounded-md p-1.5 text-ink-3 hover:bg-[#e5484d] hover:text-white"
        onClick={() => void appWindow.close()}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * 头部拖拽区 onMouseDown：命中按钮/输入框等交互元素则放行；
 * 双击（detail===2）切换最大化，否则开始拖动窗口。
 * 用法：<div onMouseDown={isLinuxDesktop ? dragWindow : undefined} …>
 */
export function dragWindow(e: ReactMouseEvent): void {
  if (!isLinuxDesktop || e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button,input,a,textarea,[data-no-drag]")) return;
  if (e.detail === 2) void appWindow.toggleMaximize();
  else void appWindow.startDragging();
}

/** 无边框窗口 8 向隐形缩放边缘（4px，压在窗口最外沿） */
const EDGES: { dir: "North" | "South" | "West" | "East" | "NorthWest" | "NorthEast" | "SouthWest" | "SouthEast"; cls: string }[] = [
  { dir: "North", cls: "left-2 right-2 top-0 h-[4px] cursor-n-resize" },
  { dir: "South", cls: "left-2 right-2 bottom-0 h-[4px] cursor-s-resize" },
  { dir: "West", cls: "top-2 bottom-2 left-0 w-[4px] cursor-w-resize" },
  { dir: "East", cls: "top-2 bottom-2 right-0 w-[4px] cursor-e-resize" },
  { dir: "NorthWest", cls: "left-0 top-0 h-2 w-2 cursor-nw-resize" },
  { dir: "NorthEast", cls: "right-0 top-0 h-2 w-2 cursor-ne-resize" },
  { dir: "SouthWest", cls: "bottom-0 left-0 h-2 w-2 cursor-sw-resize" },
  { dir: "SouthEast", cls: "bottom-0 right-0 h-2 w-2 cursor-se-resize" },
];

export function ResizeEdges() {
  if (!isLinuxDesktop) return null;
  return (
    <>
      {EDGES.map(({ dir, cls }) => (
        <div
          key={dir}
          aria-hidden
          className={`absolute z-30 ${cls}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            void appWindow.startResizeDragging(dir);
          }}
        />
      ))}
    </>
  );
}
