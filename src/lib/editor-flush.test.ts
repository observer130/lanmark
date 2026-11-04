/**
 * S6 回归：切换前 flush 的窄接口。
 * 只测语义契约——「有注册才取、返回 null 表示无变化、注销后不再取、旧实例注销不误删新注册」。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { flushEditorContent, registerEditorFlush } from "./editor-flush";

let unregister: (() => void) | null = null;

beforeEach(() => {
  unregister?.();
  unregister = null;
});

describe("editor-flush", () => {
  it("没有编辑器挂载时返回 null", () => {
    expect(flushEditorContent()).toBeNull();
  });

  it("注册后返回编辑器给出的完整 markdown", () => {
    unregister = registerEditorFlush(() => "# 标题\n\n正文\n");
    expect(flushEditorContent()).toBe("# 标题\n\n正文\n");
  });

  it("无变化时返回 null（不制造伪 dirty）", () => {
    let calls = 0;
    unregister = registerEditorFlush(() => {
      calls += 1;
      return null;
    });
    expect(flushEditorContent()).toBeNull();
    expect(calls).toBe(1);
  });

  it("注销后不再调用旧编辑器", () => {
    const fn = () => "# 旧\n";
    unregister = registerEditorFlush(fn);
    unregister();
    unregister = null;
    expect(flushEditorContent()).toBeNull();
  });

  it("旧实例的注销不会误删新实例的注册", () => {
    const unregisterOld = registerEditorFlush(() => "旧");
    const unregisterNew = registerEditorFlush(() => "新");
    // 旧实例的异步 cleanup 晚于新实例挂载（切笔记/切模式时可能发生）
    unregisterOld();
    expect(flushEditorContent()).toBe("新");
    unregisterNew();
    expect(flushEditorContent()).toBeNull();
  });

  it("重复注销幂等", () => {
    const fn = () => "内容";
    const off = registerEditorFlush(fn);
    off();
    off();
    expect(flushEditorContent()).toBeNull();
  });

  it("flush 抛错时吞掉并返回 null（不能反过来炸掉切笔记/落盘流程）", () => {
    unregister = registerEditorFlush(() => {
      throw new Error("序列化失败");
    });
    expect(flushEditorContent()).toBeNull();
  });
});
