/**
 * S3 组件级回归：外部修订号变化 → 已挂载的 Crepe 文档被替换，且**不触发 onChange**
 * （= 不写 store、不落盘）；普通保存路径只改 content 不碰 externalRev → 编辑器不动。
 *
 * 直接挂载 `MilkdownHost`（EditorPane 内部组件，导出仅供测试）：走完整
 * createProductCrepe → 基线 → 外部替换的链路，比纯逻辑测试更接近真机行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MilkdownHost, type EditorApi } from "./EditorPane";
import { flushEditorContent } from "../lib/editor-flush";
import { useVaultStore } from "../stores/vault";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function hostProps(content: string, externalRev: number, onChange: (md: string) => void) {
  return { content, notePath: "笔记/n.md", externalRev, onChange };
}

async function waitFor(cond: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // 真实产品里 MilkdownHost 的 notePath 恒等于 activePath；flush 注册会做身份校验
  useVaultStore.setState({
    status: "ready",
    vaultPath: "/v",
    activePath: "笔记/n.md",
    content: "# 旧标题\n\n旧版正文\n",
    savedContent: "# 旧标题\n\n旧版正文\n",
    dirty: false,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("MilkdownHost 外部内容替换（S3）", () => {
  it("externalRev 变化 → 文档替换为新内容，onChange 不被调用", async () => {
    const onChange = vi.fn();
    let api: EditorApi | null = null;
    await act(async () => {
      root.render(
        React.createElement(MilkdownHost, {
          ...hostProps("# 旧标题\n\n旧版正文\n", 0, onChange),
          onReady: (a: EditorApi | null) => {
            api = a;
          },
        }),
      );
    });
    const pm = () => container.querySelector(".ProseMirror") as HTMLElement | null;
    await waitFor(() => !!pm() && !!api);
    await waitFor(() => pm()!.textContent!.includes("旧版正文"));
    // 等基线建立 / flush 注册完成（create 之后还有一次 action 取 view）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    const internalRev = 1;
    await act(async () => {
      root.render(
        React.createElement(
          MilkdownHost,
          hostProps("# 外部新版\n\n同步下来的正文\n", internalRev, onChange),
        ),
      );
    });

    await waitFor(() => pm()!.textContent!.includes("同步下来的正文"));
    expect(pm()!.textContent).not.toContain("旧版正文");

    // 外部替换带 addToHistory=false ⇒ listener 不排队、不回调 onChange；
    // 但仍等过一个防抖周期，确认没有延迟回调。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(onChange).not.toHaveBeenCalled();
    // 替换不进撤销栈：打开笔记时历史为空，换一次服务器文档后仍为空
    expect(api!.canUndo()).toBe(false);

    // 基线已对齐：teardown 前 flush 不应返回伪变更
    expect(flushEditorContent()).toBeNull();
  }, 20000);

  it("普通保存（content 变但 externalRev 不变）→ 不替换已挂载文档", async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(MilkdownHost, hostProps("# 标题\n\n正文\n", 2, onChange)),
      );
    });
    const pm = () => container.querySelector(".ProseMirror") as HTMLElement | null;
    await waitFor(() => !!pm());
    await waitFor(() => pm()!.textContent!.includes("正文"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    // 模拟 saveNow 后的 set({ content })：内容变了、修订号没变
    await act(async () => {
      root.render(
        React.createElement(
          MilkdownHost,
          hostProps("# 标题\n\n正文\n\n规范化补的尾空行\n", 2, onChange),
        ),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    // 编辑器文档未被外部内容改写（仍在原文档；尾空行不属于编辑器内容）
    expect(pm()!.textContent).toContain("正文");
    expect(pm()!.textContent).not.toContain("规范化补的尾空行");
    expect(onChange).not.toHaveBeenCalled();
  }, 20000);

  it("flush 做 activePath 身份校验：切走后不把旧笔记内容交出去", async () => {
    const onChange = vi.fn();
    let api: EditorApi | null = null;
    await act(async () => {
      root.render(
        React.createElement(MilkdownHost, {
          ...hostProps("# 标题\n\n正文\n", 0, onChange),
          onReady: (a: EditorApi | null) => {
            api = a;
          },
        }),
      );
    });
    const pm = () => container.querySelector(".ProseMirror") as HTMLElement | null;
    await waitFor(() => !!pm() && !!api);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    // 模拟一次真实编辑（插入分割线），200ms 防抖尚未触发
    await act(async () => {
      api!.insertBlock("divider");
    });
    // 防抖窗口内 activePath 已切到新笔记（React 提交尚未卸载旧实例）
    useVaultStore.setState({ activePath: "别的笔记.md" });

    // 旧实例仍挂着，但身份不匹配 ⇒ 绝不能把旧文档内容交给调用方
    expect(flushEditorContent()).toBeNull();
  }, 20000);
});
