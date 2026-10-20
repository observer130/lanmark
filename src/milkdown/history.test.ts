/**
 * 窄屏头部「撤回」按钮的护栏：它直接调 prosemirror-history 的 `undo`，不经过快捷键。
 * 这里验证产品配置下历史确实在记录、且撤到底后 `undoDepth` 归零（按钮置灰的依据）。
 *
 * 不模拟按键：history 的快捷键只挂在 ProseMirror 自己的 DOM 上，手机没有 Ctrl 键——
 * 这正是按钮存在的理由（见 EditorPane 的 `EditorApi.undo`）。
 */
import { describe, it, expect } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";

import { createProductCrepe } from "./product";

async function mount(defaultValue: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const crepe = createProductCrepe({ root, defaultValue });
  await crepe.create();
  const view = await crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  return { crepe, root, view };
}

describe("撤销（窄屏「撤回」按钮调用的同一条路径）", () => {
  it("打开笔记本身不产生历史（基线为空）", async () => {
    const { crepe, root, view } = await mount("原文。");
    expect(undoDepth(view.state)).toBe(0);
    await crepe.destroy();
    root.remove();
  });

  it("addToHistory=false 的事务不进撤销栈（打开笔记时图片 src 的显示层改写走这条）", async () => {
    const { crepe, root, view } = await mount("![图](assets/a.png)");
    expect(undoDepth(view.state)).toBe(0);
    // 与 EditorPane 建实例后改写 image.src 的做法一致：只是显示层改写，不是用户编辑
    const imageAt = () => {
      let pos = -1;
      let src = "";
      view.state.doc.descendants((node, at) => {
        if (node.type.name === "image") {
          pos = at;
          src = node.attrs.src as string;
        }
      });
      return { pos, src };
    };
    const before = imageAt();
    expect(before.pos).toBeGreaterThanOrEqual(0);
    const attrs = { src: "vault://localhost/assets/a.png", alt: "图", title: null };
    view.dispatch(
      view.state.tr.setNodeMarkup(before.pos, undefined, attrs).setMeta("addToHistory", false),
    );
    expect(imageAt().src).toBe("vault://localhost/assets/a.png");
    expect(undoDepth(view.state)).toBe(0);
    await crepe.destroy();
    root.remove();
  });

  it("打字 → undo 还原文本；撤到底后 undoDepth 归零（按钮应变灰）", async () => {
    const { crepe, root, view } = await mount("原文。");
    const end = view.state.doc.content.size - 1; // 段末（doc 子节点从 1 开始）
    view.dispatch(view.state.tr.insertText("追加", end));
    expect(view.state.doc.textContent).toBe("原文。追加");
    expect(undoDepth(view.state)).toBeGreaterThan(0);

    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.textContent).toBe("原文。");
    expect(undoDepth(view.state)).toBe(0);

    // 已无历史：再撤是 no-op（按钮 disabled 时不会走到这里，但 API 必须诚实）
    expect(undo(view.state, view.dispatch)).toBe(false);
    await crepe.destroy();
    root.remove();
  });

  it("块级删除也能撤回（块菜单删除后焦点已离开编辑器，快捷键不可用）", async () => {
    const { crepe, root, view } = await mount("第一段。\n\n第二段。");
    expect(view.state.doc.childCount).toBe(2);
    view.dispatch(view.state.tr.delete(0, view.state.doc.child(0).nodeSize));
    expect(view.state.doc.childCount).toBe(1);

    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.childCount).toBe(2);
    expect(view.state.doc.textContent).toContain("第一段。");
    await crepe.destroy();
    root.remove();
  });
});
