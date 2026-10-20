import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { extractOutline, type OutlineItem } from "../lib/outline";
import { useVaultStore } from "../stores/vault";

/** 当前笔记的大纲；`enabled=false` 时不做提取（桌面端不需要移动按钮的数据）。 */
export function useOutlineItems(enabled = true): OutlineItem[] {
  const content = useVaultStore((s) => s.content);
  const activePath = useVaultStore((s) => s.activePath);
  // 打字时延迟重算，避免每次击键都重排侧栏/抽屉。
  const deferred = useDeferredValue(content);
  return useMemo(
    () => (enabled && activePath ? extractOutline(deferred) : []),
    [enabled, activePath, deferred],
  );
}

/**
 * 当前滚动位置所在的标题（Typora 式高亮）。
 *
 * 直接观察 `.editor-host` 的滚动，取「顶边已越过容器顶 + 24px」的最后一个标题。
 * 源码模式暂不高亮（CodeMirror 的滚动容器与行映射另算，v1 不做）。
 * items 用签名做依赖：内容微调但标题没变时不重挂监听。
 */
export function useActiveHeading(
  items: OutlineItem[],
  enabled = true,
): number {
  const activePath = useVaultStore((s) => s.activePath);
  const editorMode = useVaultStore((s) => s.editorMode);
  const [active, setActive] = useState(-1);
  const signature = items
    .map((i) => `${i.index}:${i.level}:${i.line}:${i.text}`)
    .join("\u0000");

  useEffect(() => {
    setActive(-1);
    if (!enabled || !activePath || editorMode === "source" || items.length === 0) return;
    const host = document.querySelector<HTMLElement>(".editor-host");
    if (!host) return;
    const headings = Array.from(
      host.querySelectorAll<HTMLElement>(
        ".ProseMirror > h1, .ProseMirror > h2, .ProseMirror > h3",
      ),
    );
    if (headings.length === 0) return;

    let raf = 0;
    const update = () => {
      // 滚到底时，最后一个标题可能永远到不了「容器顶 + 24px」（短文档尤其明显）。
      // 此时把最后一条判为当前节；否则用户点了最后一节、重开抽屉却没有任何高亮。
      const scrollable = host.scrollHeight > host.clientHeight + 2;
      if (scrollable && host.scrollTop + host.clientHeight >= host.scrollHeight - 2) {
        setActive(items[items.length - 1]?.index ?? -1);
        return;
      }
      const top = host.getBoundingClientRect().top + 24;
      let idx = -1;
      for (let i = 0; i < headings.length; i += 1) {
        if (headings[i].getBoundingClientRect().top <= top) idx = i;
        else break;
      }
      // 还没滚过第一个标题时高亮第一条（Typora 也不会在开头显示「无当前节」）。
      if (idx < 0) idx = 0;
      setActive(idx < items.length ? items[idx].index : -1);
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    host.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      host.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // signature 已覆盖 items 的可见变化；items 本身不进依赖避免数组身份抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activePath, editorMode, signature]);

  return active;
}
