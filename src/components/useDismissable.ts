import { useEffect, useRef } from "react";

/**
 * 底部抽屉 / 浮层的**统一关闭行为**：Escape、点外部、滚动（锚点会失效）、窗口缩放。
 *
 * 抽出来是因为块菜单与插入菜单是同一类浮层——两处各写一份必然漂移（一处修了另一处忘），
 * 表现成「某个菜单按 Esc 关不掉」。调用方把返回的 ref 挂到浮层根元素上。
 */
export function useDismissable(active: boolean, onClose: () => void) {
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
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [active, onClose]);

  return ref;
}
