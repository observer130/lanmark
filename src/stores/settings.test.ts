import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M4b 外观设置的前端测试（M5 减法后：字号/行距 + 编辑器 + 存储链路；M6 增主题）。
 *
 * 覆盖三件事：
 * 1. 枚举 → CSS 值映射（字号四档 / 行距）
 * 2. 应用与回滚链路（乐观更新、以 Rust 返回值为准、失败复原变量与主题）
 * 3. `editorKey` 回归护栏：外观**不得**进入 key（否则改字号/主题会重建 Crepe 实例，
 *    触发伪 markdownUpdated → 打开笔记被重写，硬约定 3）
 */

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  applyCssVars,
  applyTheme,
  lineHeightValue,
  textSizePx,
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

  it("非法档位回退 md", () => {
    expect(textSizePx("huge" as never)).toBe(16);
    expect(lineHeightValue("loose" as never)).toBe(1.75);
  });

  it("行距三档 = 1.55 / 1.75 / 2.0", () => {
    expect(lineHeightValue("compact")).toBe(1.55);
    expect(lineHeightValue("normal")).toBe(1.75);
    expect(lineHeightValue("relaxed")).toBe(2.0);
  });
});

describe("applyCssVars：变量写入", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("写入全部外观变量（M5 减法后只剩字号/行距两项）", () => {
    applyCssVars(app({ textSize: "xl", lineHeight: "relaxed" }));
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--lanmark-text-size")).toBe("20px");
    expect(st.getPropertyValue("--lanmark-line-height")).toBe("2");
    // M5 减法：字体/行宽/界面缩放变量不再由设置写入（常驻 index.css）
    expect(st.getPropertyValue("--lanmark-font-text")).toBe("");
    expect(st.getPropertyValue("--lanmark-content-max")).toBe("");
  });
});

describe("applyTheme：主题属性写入（M6）", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("把主题 key 写成 <html data-theme>（换肤靠 CSS 变量传导，不碰编辑器）", () => {
    applyTheme("night");
    expect(document.documentElement.dataset.theme).toBe("night");
    applyTheme("paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("morning 也写属性——`:root` 即晨窗，无主题块匹配时天然等价", () => {
    applyTheme("morning");
    expect(document.documentElement.dataset.theme).toBe("morning");
  });

  it("非法 key 不写属性（回落 :root 晨窗，避免未知主题打空全部变量）", () => {
    applyTheme("night");
    applyTheme("neon" as never);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("settings store：加载 / 乐观更新 / 回滚", () => {
  beforeEach(() => {
    invoke.mockReset();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
    useSettingsStore.setState({
      settings: {
        appearance: DEFAULT_APPEARANCE,
        editor: { defaultMode: "wysiwyg", autosaveMs: 3000, sourceLineNumbers: true, newNoteLocation: "root" },
        storage: { trashRetentionDays: 30 },
        update: { autoCheck: true },
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

  it("load → 主题属性同步落地（M6）", async () => {
    invoke.mockResolvedValueOnce({
      appearance: { ...DEFAULT_APPEARANCE, theme: "night" },
      editor: useSettingsStore.getState().settings.editor,
      storage: useSettingsStore.getState().settings.storage,
      update: useSettingsStore.getState().settings.update,
    });
    await useSettingsStore.getState().load();
    expect(document.documentElement.dataset.theme).toBe("night");
  });

  it("patch 失败 → 主题属性与 state 一并回滚", async () => {
    const a = DEFAULT_APPEARANCE;
    invoke.mockRejectedValueOnce(new Error("写盘失败"));
    await useSettingsStore.getState().patch({ appearance: { ...a, theme: "night" } });
    expect(useSettingsStore.getState().settings.appearance.theme).toBe("morning");
    expect(document.documentElement.dataset.theme).toBe("morning");
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

  it("patch 以 Rust 返回值为准（非法档位被归一化）", async () => {
    const a = DEFAULT_APPEARANCE;
    // 乐观提交非法档位，Rust 归一化后回 md
    invoke.mockResolvedValueOnce({
      appearance: { ...a, textSize: "md" },
      editor: useSettingsStore.getState().settings.editor,
      storage: useSettingsStore.getState().settings.storage,
    });
    await useSettingsStore.getState().patch({
      appearance: { ...a, textSize: "huge" as never },
    });
    expect(useSettingsStore.getState().settings.appearance.textSize).toBe("md");
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
    // 模拟改字号/行距/主题后重新渲染：key 必须逐字节相同，否则 React 会重建
    // MilkdownHost → Crepe 建实例发伪 markdownUpdated → 笔记被重写
    applyCssVars(app({ textSize: "xl", lineHeight: "relaxed" }));
    applyTheme("night");
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

  /** 真机走查发现：窄屏下只置 syncPanelRequest 不够——侧栏抽屉是收起的，
   *  同步面板会在 `-translate-x-full` 的容器里展开、被挤出屏幕左侧。 */
  it("同时请求展开侧栏抽屉（窄屏必需，否则面板被裁到屏幕外）", () => {
    useSettingsStore.setState({ dialogOpen: true, syncPanelRequest: 0, navDrawerRequest: 0 });
    useSettingsStore.getState().requestSyncPanel();
    expect(useSettingsStore.getState().navDrawerRequest).toBe(1);
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
      editor: { defaultMode: "wysiwyg", autosaveMs: 3000, sourceLineNumbers: true, newNoteLocation: "root" },
      storage: { trashRetentionDays: 30 },
      update: { autoCheck: true },
    });
    useSettingsStore.setState({
      settings: {
        appearance: { ...DEFAULT_APPEARANCE, textSize: "xl", lineHeight: "relaxed" },
        editor: { defaultMode: "source", autosaveMs: 3000, sourceLineNumbers: false, newNoteLocation: "last" },
        storage: { trashRetentionDays: 7 },
        update: { autoCheck: true },
      },
    });
    await useSettingsStore.getState().reset();
    expect(invoke.mock.calls[0][0]).toBe("settings_reset");
    const s = useSettingsStore.getState().settings;
    expect(s.appearance.textSize).toBe("md");
    expect(s.editor.autosaveMs).toBe(3000);
    expect(s.storage.trashRetentionDays).toBe(30);
    // CSS 变量随之复位
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("16px");
  });

  it("reset 失败 → 回滚到上一版设置与变量", async () => {
    const prev = {
      appearance: { ...DEFAULT_APPEARANCE, textSize: "lg" as const },
      editor: { defaultMode: "wysiwyg" as const, autosaveMs: 3000, sourceLineNumbers: true, newNoteLocation: "root" as const },
      storage: { trashRetentionDays: 30 },
      update: { autoCheck: true },
    };
    useSettingsStore.setState({ settings: prev });
    invoke.mockRejectedValueOnce(new Error("写盘失败"));
    await useSettingsStore.getState().reset();
    expect(useSettingsStore.getState().settings.appearance.textSize).toBe("lg");
    expect(useSettingsStore.getState().error).toContain("写盘失败");
    expect(document.documentElement.style.getPropertyValue("--lanmark-text-size")).toBe("18px");
  });
});
