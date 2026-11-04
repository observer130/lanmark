/**
 * 图片显示链路回归：磁盘里的相对引用（可能带 percent-encoding）→ vault 协议 URL。
 * 此前 `assets/my%20pic.png` 直接进 resolveFrom/toVaultUrl，`%` 被再编码成 `%25`，
 * 真机上就是 404（双击编码）。这里直接挂载 MilkdownHost 验 DOM 的 src。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MilkdownHost } from "./EditorPane";
import { useVaultStore } from "../stores/vault";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  useVaultStore.setState({
    status: "ready",
    vaultPath: "/v",
    activePath: "笔记/n.md",
    content: "",
    savedContent: "",
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

describe("MilkdownHost 图片显示（相对引用 → vault 协议）", () => {
  it("%20 引用先解码再编码，不出现 %25 双击编码", async () => {
    await act(async () => {
      root.render(
        React.createElement(MilkdownHost, {
          content: "![a](assets/my%20pic.png)",
          notePath: "笔记/n.md",
          externalRev: 0,
          onChange: () => {},
        }),
      );
    });
    const img = () => container.querySelector("img");
    await waitFor(() => !!img()?.getAttribute("src")?.startsWith("vault://localhost/"));
    const src = img()!.getAttribute("src")!;
    expect(src).toBe("vault://localhost/%E7%AC%94%E8%AE%B0/assets/my%20pic.png");
    expect(src).not.toContain("%25");
  }, 20000);

  it("已有中文相对引用正常进协议（不回归）", async () => {
    await act(async () => {
      root.render(
        React.createElement(MilkdownHost, {
          content: "![中文图](assets/图.png)",
          notePath: "笔记/n.md",
          externalRev: 0,
          onChange: () => {},
        }),
      );
    });
    const img = () => container.querySelector("img");
    await waitFor(() => !!img()?.getAttribute("src")?.startsWith("vault://localhost/"));
    expect(img()!.getAttribute("src")).toBe(
      "vault://localhost/%E7%AC%94%E8%AE%B0/assets/%E5%9B%BE.png",
    );
  }, 20000);
});
