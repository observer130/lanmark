import { useEffect, useRef } from "react";

/**
 * 浮层的**统一关闭行为**：Escape、点外部，外加（**仅贴锚点的浮层**）滚动与窗口缩放。
 *
 * 抽出来是因为块菜单与插入菜单是同一类浮层——两处各写一份必然漂移（一处修了另一处忘），
 * 表现成「某个菜单按 Esc 关不掉」。调用方把返回的 ref 挂到浮层根元素上。
 *
 * ⚠️ **「点外部关闭」只认 `pointerdown`，调用方的遮罩也别再挂 `onClick`**：
 * `pointerdown` 只在**新手势开始**时触发，而 `click` 会在「打开浮层那个手势」结束时补发一次
 * （长按唤出时手指抬起 → click 落在刚出现的遮罩上 → 浮层只闪现几十毫秒就被关掉）。
 * 2026-10-16 Android 真机实测：长按块菜单「毫无反应」的真相就是这个。
 *
 * ⚠️ **底部抽屉不许监听 `scroll` / `resize`**（`anchored = false`，默认）：
 * 抽屉是贴屏幕底的，滚动/缩放不会让它错位，本来就不需要这两个逃生门；
 * 而真机上它们会**误伤**——长按留下的文本选区在后续触摸时被清掉会触发滚动/布局事件，
 * 于是「点开抽屉一瞬间就被关掉」（2026-10-16 Android 真机走查实测，桌面 Chrome 复现不出）。
 * 只有贴点击位置的浮层（桌面块菜单）才需要这两个。
 */
export function useDismissable(active: boolean, onClose: () => void, anchored = false) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    if (anchored) {
      window.addEventListener("scroll", onClose, true);
      window.addEventListener("resize", onClose);
    }
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [active, onClose, anchored]);

  return ref;
}
