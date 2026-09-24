import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M4b 外观设置的前端测试。
 *
 * 覆盖两件事：
 * 1. 枚举 → CSS 值映射（字号四档 / 行距 / 行宽 / 字体栈）
 * 2. 应用与回滚链路（乐观更新、以 Rust 返回值为准、失败复原变量）
 * 3. `editorKey` 回归护栏：外观**不得**进入 key（否则改字号会重建 Crepo 实例，
 *    触发伪 markdownUpdated → 打开笔记被重写，硬约定 3）
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  applyCssVars,
  codeSizePx,
  lineHeightValue,
  monoFontStack,
  textFontStack,
  textSizePx,
  uiFontStack,
  CONTENT_MAX_PX,
  type Appearance,
} from "../lib/settings";
import { editorKey } from "../components/EditorPane";
import { useSettingsStore, DEFAULT_APPEARANCE } from "../stores/settings";

function app(over: Partial<Appearance> = {}): Appearance {
  return { ...DEFAULT_APPEARANCE, ...over };
}

describe("外观枚举 → 数值映射", () => {
  it("正文字号四档 = 14/16/18/20", () => {
    expect(textSizePx("sm")).toBe(14);
    expect(textSizePx("md")).toBe(16);
    expect(textSizePx("lg")).toBe(18);
    expect(textSizePx("xl")).toBe(20);
  });

  it("源码字号四档 = 12/14/16/18（整体比正文小 2px）", () => {
    expect(codeSizePx("sm")).toBe(12);
    expect(codeSizePx("md")).toBe(14);
    expect(codeSizePx("lg")).toBe(16);
    expect(codeSizePx("xl")).toBe(18);
  });

  it("非法档位回退 md", () => {
    expect(textSizePx("huge" as never)).toBe(16);
    expect(codeSizePx("" as never)).toBe(14);
    expect(lineHeightValue("loose" as never)).toBe(1.75);
  });

  it("行距三档 = 1.55 / 1.75 / 2.0", () => {
    expect(lineHeightValue("compact")).toBe(1.55);
    expect(lineHeightValue("normal")).toBe(1.75);
    expect(lineHeightValue("relaxed")).toBe(2.0);
  });

  it("字体栈：system 沿用旧栈，serif / mono 各有映射，custom 用用户串", () => {
    // 默认（system/sans/system）必须与 M3 硬编码一致，升级用户界面不变
    expect(uiFontStack(app())).toContain("Noto Sans");
    expect(uiFontStack(app())).toContain("Microsoft YaHei");
    expect(textFontStack(app({ textFont: "sans" }))).toContain("PingFang SC");
    expect(uiFontStack(app({ uiFont: "serif" }))).toContain("Noto Serif CJK SC");
    expect(monoFontStack(app({ monoFont: "mono" }))).toContain("JetBrains Mono");
    expect(monoFontStack(app({ monoFont: "system" }))).toContain("ui-monospace");
    // custom 但串为空 → 回退 system（Rust 侧同样会把枚举归一回 system）
    expect(uiFontStack(app({ uiFont: "custom", customFonts: { ui: "", text: "", mono: "" } }))).toContain(
      "Noto Sans",
    );
    expect(
      uiFontStack(app({ uiFont: "custom", customFonts: { ui: "Fira Sans", text: "", mono: "" } })),
    ).toBe("Fira Sans");
  });
});

describe("applyCssVars：变量写入", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("写入全部外观变量（字号/行距/字体/行宽）", () => {
    applyCssVars(app({ textSize: "xl", codeSize: "sm", lineHeight: "relaxed", contentWidth: "limited" }));
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--lanmark-text-size")).toBe("20px");
    expect(st.getPropertyValue("--lanmark-code-size")).toBe("12px");
    expect(st.getPropertyValue("--lanmark-line-height")).toBe("2");
    expect(st.getPropertyValue("--lanmark-content-max")).toBe(`${CONTENT_MAX_PX}px`);
    expect(st.getPropertyValue("--lanmark-font-text")).toContain("PingFang SC");
    expect(st.getPropertyValue("--lanmark-font-mono")).toContain("ui-monospace");
  });

  it("正文宽度 auto → max-width: none", () => {
    applyCssVars(app({ contentWidth: "auto" }));
    expect(document.documentElement.style.getPropertyValue("--lanmark-content-max")).toBe("none");
  });
});

describe("settings store：加载 / 乐观更新 / 回滚", () => {
  beforeEach(() => {
    invoke.mockReset();
    document.documentElement.removeAttribute("style");
    useSettingsStore.setState({
      settings: {
        appearance: DEFAULT_APPEARANCE,
        editor: { defaultMode: "wysiwyg", autosaveMs: 700, sourceLineNumbers: true, newNoteLocation: "root" },
        storage: { trashRetentionDays: 30 },
      },
      loading: true,
      error: null,
    });
  });

  it("load → 写入 CSS 变量", async () => {
    invoke.mockResolvedValueOnce({
      appearance: { ...DEFAULT_APPEARANCE, textSize: "lg" },
      editor: { defaultMode: "source", autosaveMs: 1500, sourceLineNumbers: false, newNoteLocation: "last" },
      storage: { trashRetentionDays: 7 },
    });
    await useSettingsStore.getState().load();
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("18px");
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it("load 失败时仍写入默认变量（避免 var() 全部落空）", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().error).toContain("boom");
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("16px");
  });

  it("patch 乐观更新：一次点击 = 一次落库（无防抖/无 IPC 风暴）", async () => {
    const a = DEFAULT_APPEARANCE;
    invoke.mockResolvedValueOnce({
      appearance: { ...a, textSize: "xl" },
      editor: useSettingsStore.getState().settings.editor,
      storage: useSettingsStore.getState().settings.storage,
    });
    await useSettingsStore.getState().patch({ appearance: { ...a, textSize: "xl" } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("settings_patch");
    expect(useSettingsStore.getState().settings.appearance.textSize).toBe("xl");
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("20px");
  });

  it("patch 以 Rust 返回值为准（非法自定义字体被回退）", async () => {
    const a = DEFAULT_APPEARANCE;
    // 乐观提交 custom，Rust 归一化后回 system
    invoke.mockResolvedValueOnce({
      appearance: { ...a, uiFont: "system", customFonts: { ui: "", text: "", mono: "" } },
      editor: useSettingsStore.getState().settings.editor,
      storage: useSettingsStore.getState().settings.storage,
    });
    await useSettingsStore.getState().patch({
      appearance: { ...a, uiFont: "custom", customFonts: { ui: "", text: "", mono: "" } },
    });
    expect(useSettingsStore.getState().settings.appearance.uiFont).toBe("system");
  });

  it("patch 失败 → 回滚 state 与 CSS 变量", async () => {
    const a = DEFAULT_APPEARANCE;
    invoke.mockRejectedValueOnce(new Error("写盘失败"));
    await useSettingsStore.getState().patch({ appearance: { ...a, textSize: "xl" } });
    const s = useSettingsStore.getState();
    expect(s.settings.appearance.textSize).toBe("md");
    expect(s.error).toContain("写盘失败");
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("16px");
  });

  it("patch 只动传入的小节，其余保持", async () => {
    const before = useSettingsStore.getState().settings;
    const nextEditor = { ...before.editor, autosaveMs: 3000 };
    invoke.mockResolvedValueOnce({
      appearance: before.appearance,
      editor: nextEditor,
      storage: before.storage,
    });
    await useSettingsStore.getState().patch({ editor: nextEditor });
    const after = useSettingsStore.getState().settings;
    expect(after.editor.autosaveMs).toBe(3000);
    expect(after.storage).toEqual(before.storage);
    expect(after.appearance).toEqual(before.appearance);
  });
});

describe("editorKey：外观不得进入编辑器 key（硬约定 3 护栏）", () => {
  it("只由路径 + 模式决定", () => {
    expect(editorKey("a/b.md", "wysiwyg")).toBe("a/b.md|wysiwyg");
    expect(editorKey("a/b.md", "read")).toBe("a/b.md|read");
    expect(editorKey("a/b.md", "wysiwyg")).not.toBe(editorKey("a/b.md", "source"));
  });

  it("同一路径同一模式恒等——外观变化不得改变它", () => {
    const k1 = editorKey("n.md", "wysiwyg");
    // 模拟改字体/字号后重新渲染：key 必须逐字节相同，否则 React 会重建
    // MilkdownHost → Crepe 建实例发伪 markdownUpdated → 笔记被重写
    applyCssVars(app({ textFont: "serif", textSize: "xl", lineHeight: "relaxed" }));
    const k2 = editorKey("n.md", "wysiwyg");
    expect(k2).toBe(k1);
  });
});

describe("D3：设置页「管理设备与配对」跳转侧栏同步面板", () => {
  it("requestSyncPanel 关掉设置页并递增请求计数", () => {
    useSettingsStore.setState({ dialogOpen: true, syncPanelRequest: 0, error: null });
    useSettingsStore.getState().requestSyncPanel();
    const s = useSettingsStore.getState();
    expect(s.dialogOpen).toBe(false);
    expect(s.syncPanelRequest).toBe(1);
  });

  it("连点两次计数继续递增（布尔会因「已是 true」失效，故用计数器）", () => {
    useSettingsStore.setState({ dialogOpen: true, syncPanelRequest: 0 });
    useSettingsStore.getState().requestSyncPanel();
    useSettingsStore.setState({ dialogOpen: true });
    useSettingsStore.getState().requestSyncPanel();
    expect(useSettingsStore.getState().syncPanelRequest).toBe(2);
    expect(useSettingsStore.getState().dialogOpen).toBe(false);
  });
});

describe("E4：恢复默认设置只重置设置小节", () => {
  it("reset 走 IPC 并以返回值为准", async () => {
    invoke.mockResolvedValueOnce({
      appearance: DEFAULT_APPEARANCE,
      editor: { defaultMode: "wysiwyg", autosaveMs: 700, sourceLineNumbers: true, newNoteLocation: "root" },
      storage: { trashRetentionDays: 30 },
    });
    useSettingsStore.setState({
      settings: {
        appearance: { ...DEFAULT_APPEARANCE, textSize: "xl", textFont: "serif" },
        editor: { defaultMode: "source", autosaveMs: 3000, sourceLineNumbers: false, newNoteLocation: "last" },
        storage: { trashRetentionDays: 7 },
      },
    });
    await useSettingsStore.getState().reset();
    expect(invoke.mock.calls[0][0]).toBe("settings_reset");
    const s = useSettingsStore.getState().settings;
    expect(s.appearance.textSize).toBe("md");
    expect(s.editor.autosaveMs).toBe(700);
    expect(s.storage.trashRetentionDays).toBe(30);
    // CSS 变量随之复位
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("16px");
  });

  it("reset 失败 → 回滚到上一版设置与变量", async () => {
    const prev = {
      appearance: { ...DEFAULT_APPEARANCE, textSize: "lg" as const },
      editor: { defaultMode: "wysiwyg" as const, autosaveMs: 700, sourceLineNumbers: true, newNoteLocation: "root" as const },
      storage: { trashRetentionDays: 30 },
    };
    useSettingsStore.setState({ settings: prev });
    invoke.mockRejectedValueOnce(new Error("写盘失败"));
    await useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().settings.appearance.textSize).toBe("lg");
    expect(useSettingsStore.getState().error).toContain("写盘失败");
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("18px");
  });
});
