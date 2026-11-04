/**
 * vault store 守卫测试（review 修复回归）：
 * - openNote/closeNote 保存失败必须中止（未保存编辑不丢铁律，与 deleteNode 一致）
 * - 快速连开时慢响应不得覆盖新状态（activePath 与 content 错位 → A 内容写进 B 的文件）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
  recents: vi.fn(),
  favorites: vi.fn(),
  trashList: vi.fn(),
  trashRestore: vi.fn(),
  tree: vi.fn(),
  search: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  setPath: vi.fn(),
  setPathWithCreate: vi.fn(),
  appDir: vi.fn(),
  flushEditorContent: vi.fn(),
}));

vi.mock("../lib/vault", () => ({
  vault: {
    status: vi.fn(),
    readNote: m.readNote,
    writeNote: m.writeNote,
    tree: m.tree,
    recents: m.recents,
    favorites: m.favorites,
    trashList: m.trashList,
    trashRestore: m.trashRestore,
    reindex: vi.fn(),
    pickAndSet: vi.fn(),
    setPath: m.setPath,
    setPathWithCreate: m.setPathWithCreate,
    rename: m.rename,
    remove: vi.fn(),
    move: m.move,
    toggleFavorite: vi.fn(),
    search: m.search,
  },
  remapPath: (active: string | null, from: string, to: string): string | null =>
    active === from
      ? to
      : active && active.startsWith(from + "/")
        ? to + active.slice(from.length)
        : active,
}));
vi.mock("../lib/sync", () => ({
  vaultPicker: { pickFolder: vi.fn(), appDir: m.appDir },
}));
// S6：切笔记/切模式前会先 flush 编辑器；这里用 mock 控制「防抖里还有没有内容」
vi.mock("../lib/editor-flush", () => ({ flushEditorContent: m.flushEditorContent }));
// switchVault 会停自动同步循环（先停再切，防止回合打到半切换状态）→ 桩掉 sync store
vi.mock("./sync", () => ({
  useSyncStore: { getState: () => ({ stopAutoLoop: stopAutoLoopMock }) },
}));
const stopAutoLoopMock = vi.fn();

import { useVaultStore } from "./vault";
import { useSettingsStore } from "./settings";

const { readNote, writeNote, recents, favorites, trashList, tree, search, rename, move } = m;

function baseState() {
  useVaultStore.setState({
    status: "ready",
    vaultPath: "/v",
    tree: [],
    activePath: null,
    content: "",
    externalRev: 0,
    savedContent: null,
    dirty: false,
    savedAt: null,
    editorMode: "wysiwyg",
    renamingPath: null,
    searchQuery: "",
    searchResults: [],
    recents: [],
    favorites: [],
    trash: [],
    error: null,
    collapsedDirs: new Set<string>(),
    expandedSections: new Set<string>(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  baseState();
  readNote.mockImplementation((p: string) => Promise.resolve({ content: `内容${p}`, title: p }));
  writeNote.mockResolvedValue(undefined);
  recents.mockResolvedValue([]);
  favorites.mockResolvedValue([]);
  trashList.mockResolvedValue([]);
  tree.mockResolvedValue([]);
  // 默认「编辑器无待 flush 内容」；用例按需 mockReturnValue 注入
  m.flushEditorContent.mockReturnValue(null);
});
describe("openNote/closeNote 守卫", () => {
  it("openNote 前保存失败 → 中止切换，未保存内容保留", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "未保存的旧内容", dirty: true });
    writeNote.mockRejectedValueOnce(new Error("磁盘满"));

    await useVaultStore.getState().openNote("b.md");

    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("未保存的旧内容");
    expect(s.dirty).toBe(true);
    expect(s.error).toBeTruthy();
    expect(readNote).not.toHaveBeenCalled();
  });

  it("closeNote 前保存失败 → 保留笔记打开，内容不丢", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "未保存", dirty: true });
    writeNote.mockRejectedValueOnce(new Error("权限不足"));

    await useVaultStore.getState().closeNote();

    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("未保存");
    expect(s.dirty).toBe(true);
  });

  it("保存成功后正常切换", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "改", dirty: true });

    await useVaultStore.getState().openNote("b.md");

    const s = useVaultStore.getState();
    expect(s.activePath).toBe("b.md");
    expect(s.dirty).toBe(false);
    expect(writeNote).toHaveBeenCalledTimes(1);
  });

  it("快速连开：慢响应的 a.md 不得覆盖后点的 b.md", async () => {
    let resolveA: (v: { content: string; title: string }) => void = () => {};
    readNote.mockImplementation((p: string) =>
      p === "a.md"
        ? new Promise((r) => {
            resolveA = r;
          })
        : Promise.resolve({ content: "B内容", title: "b.md" }),
    );

    const p1 = useVaultStore.getState().openNote("a.md");
    const p2 = useVaultStore.getState().openNote("b.md");
    await p2;
    expect(useVaultStore.getState().activePath).toBe("b.md");

    // a.md 的慢响应此刻才返回 → 必须被丢弃
    resolveA({ content: "A内容", title: "a.md" });
    await p1;

    const s = useVaultStore.getState();
    expect(s.activePath).toBe("b.md");
    expect(s.content).toBe("B内容");
  });
});

describe("保存 no-op 守卫（trailing 伪空段落 / 点一下不写盘）", () => {
  it("内容只多一个尾空行 → 不写盘，dirty 清掉", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "甲\n\n乙\n\n",
      savedContent: "甲\n\n乙\n",
      dirty: true,
    });

    const ok = await useVaultStore.getState().saveNow();

    expect(ok).toBe(true);
    expect(writeNote).not.toHaveBeenCalled();
    expect(useVaultStore.getState().dirty).toBe(false);
    expect(useVaultStore.getState().content).toBe("甲\n\n乙\n");
  });

  it("真实编辑 → 写格式化后的内容并更新基线", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "甲\n\n乙\n\n丙 \n\n",
      savedContent: "甲\n\n乙\n",
      dirty: true,
    });

    await useVaultStore.getState().saveNow();

    expect(writeNote).toHaveBeenCalledTimes(1);
    expect(writeNote).toHaveBeenCalledWith("a.md", "甲\n\n乙\n\n丙\n");
    expect(useVaultStore.getState().savedContent).toBe("甲\n\n乙\n\n丙\n");
    expect(useVaultStore.getState().dirty).toBe(false);
  });

  it("formatOnSave 关闭：仍裁尾空行，但保留中间空行", async () => {
    const prev = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...prev, editor: { ...prev.editor, formatOnSave: false } },
    });
    try {
      // 只多尾空行 → 规范化后等价，不写
      useVaultStore.setState({
        activePath: "a.md",
        content: "甲\n\n乙\n\n\n",
        savedContent: "甲\n\n乙\n",
        dirty: true,
      });
      await useVaultStore.getState().saveNow();
      expect(writeNote).not.toHaveBeenCalled();

      // 中间多空行 → 关闭整理时按 trimDocTail 只裁尾，内容仍不同 ⇒ 写
      useVaultStore.setState({
        activePath: "a.md",
        content: "甲\n\n\n\n乙\n",
        savedContent: "甲\n\n乙\n",
        dirty: true,
      });
      await useVaultStore.getState().saveNow();
      expect(writeNote).toHaveBeenCalledWith("a.md", "甲\n\n\n\n乙\n");
    } finally {
      useSettingsStore.setState({ settings: prev });
    }
  });

  it("基线未知（null）时照常写，避免测试/异常路径误判", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "甲\n",
      savedContent: null,
      dirty: true,
    });

    await useVaultStore.getState().saveNow();

    expect(writeNote).toHaveBeenCalledWith("a.md", "甲\n");
  });
});

describe("review P3 回归：防抖/搜索序号/元数据刷新", () => {
  it("防抖为尾沿：连续输入在停止输入后才落盘一次", async () => {
    vi.useFakeTimers();
    try {
      useVaultStore.setState({ activePath: "a.md", content: "", dirty: false });
      const s = useVaultStore.getState();
      s.setContent("a");
      await vi.advanceTimersByTimeAsync(100);
      s.setContent("ab");
      // t=700：旧「首击锚定」实现在此已落盘（句中半成品）
      await vi.advanceTimersByTimeAsync(600);
      expect(writeNote).not.toHaveBeenCalled();
      // t=800：旧默认 700ms 的尾沿在此也该落盘 → M5-3 默认 3s，仍未落盘
      await vi.advanceTimersByTimeAsync(100);
      expect(writeNote).not.toHaveBeenCalled();
      // t=3100 = 最后一次输入(100) + 3000（M5-3 默认档）
      await vi.advanceTimersByTimeAsync(2300);
      expect(writeNote).toHaveBeenCalledTimes(1);
      expect(writeNote).toHaveBeenCalledWith("a.md", "ab\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("搜索序号守卫：慢的旧响应不得覆盖新结果", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    search.mockImplementation((q: string) =>
      q === "old"
        ? new Promise((r) => {
            resolveOld = r;
          })
        : Promise.resolve([{ path: "new.md", title: "新", snippet: "" }]),
    );
    const p1 = useVaultStore.getState().doSearch("old");
    const p2 = useVaultStore.getState().doSearch("new");
    await p2;
    expect(useVaultStore.getState().searchResults[0].path).toBe("new.md");

    resolveOld([{ path: "old.md", title: "旧", snippet: "" }]);
    await p1;
    expect(useVaultStore.getState().searchResults[0].path).toBe("new.md");
  });

  it("rename 后刷新 recents/favorites（DB 路径已改，前端 meta 必须跟）", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
    });
    rename.mockResolvedValueOnce("b.md");
    await useVaultStore.getState().commitRename("a.md", "b");
    expect(rename).toHaveBeenCalledWith("a.md", "b");
    expect(m.flushEditorContent).toHaveBeenCalled(); // activePath 改名前先 flush
    expect(recents).toHaveBeenCalled();
    expect(favorites).toHaveBeenCalled();
  });

  it("move 后刷新 recents/favorites", async () => {
    move.mockResolvedValueOnce("d/a.md");
    await useVaultStore.getState().moveNode("a.md", "d");
    expect(m.flushEditorContent).toHaveBeenCalled(); // activePath 改路径前先 flush
    expect(recents).toHaveBeenCalled();
    expect(favorites).toHaveBeenCalled();
  });
});

describe("M3f 远端同步改动刷新（remoteChanged）", () => {
  it("vault 未打开 → 无操作", async () => {
    useVaultStore.setState({ status: "unconfigured" });
    await useVaultStore.getState().remoteChanged();
    expect(tree).not.toHaveBeenCalled();
    expect(readNote).not.toHaveBeenCalled();
  });

  it("刷新树与 meta", async () => {
    tree.mockResolvedValueOnce([{ path: "b.md", kind: "note", name: "b.md", title: null }]);
    await useVaultStore.getState().remoteChanged();
    expect(tree).toHaveBeenCalled();
    expect(recents).toHaveBeenCalled();
    expect(useVaultStore.getState().tree).toHaveLength(1);
  });

  it("打开中的笔记（未编辑）被远端更新 → 内容重载", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "旧版", dirty: false });
    readNote.mockResolvedValueOnce({ content: "新版", title: "a.md" });
    await useVaultStore.getState().remoteChanged();
    const s = useVaultStore.getState();
    expect(s.content).toBe("新版");
    expect(s.dirty).toBe(false);
  });

  it("打开中的笔记在编辑（dirty）→ 不动内容，防吞掉进行中的输入", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "输入中", dirty: true });
    await useVaultStore.getState().remoteChanged();
    const s = useVaultStore.getState();
    expect(s.content).toBe("输入中");
    expect(s.dirty).toBe(true);
    expect(readNote).not.toHaveBeenCalled();
  });

  it("打开中的笔记被远端删除（读失败）→ 保留当前状态、不报错", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "最后内容", dirty: false });
    readNote.mockRejectedValueOnce(new Error("笔记不存在"));
    await useVaultStore.getState().remoteChanged();
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("最后内容");
    expect(s.error).toBeNull();
  });
});

/* ── S3：外部内容替换的 store 侧契约 ── */

describe("externalRev / savedContent（S3）", () => {
  it("远端重载内容变化 → externalRev 自增，savedContent 同步更新", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "旧版", savedContent: "旧版" });
    readNote.mockResolvedValueOnce({ content: "新版", title: "a.md" });

    await useVaultStore.getState().remoteChanged();

    const s = useVaultStore.getState();
    expect(s.content).toBe("新版");
    expect(s.savedContent).toBe("新版");
    expect(s.externalRev).toBe(1);
  });

  it("远端内容与当前一致 → externalRev 不动（不触发编辑器替换），只补基线", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "同一版",
      savedContent: "旧基线",
      externalRev: 0,
    });
    readNote.mockResolvedValueOnce({ content: "同一版", title: "a.md" });

    await useVaultStore.getState().remoteChanged();

    const s = useVaultStore.getState();
    expect(s.externalRev).toBe(0);
    expect(s.savedContent).toBe("同一版");
  });

  it("普通保存路径 setContent 不改变 externalRev（保存不得重置编辑器）", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧",
      savedContent: "旧",
      externalRev: 3,
    });

    useVaultStore.getState().setContent("用户新输入");

    expect(useVaultStore.getState().externalRev).toBe(3);
    // 收掉 setContent 排的尾沿定时器，避免影响后续用例
    await useVaultStore.getState().saveNow();
  });

  it("applyExternalContent：path 不匹配 / dirty / 内容相同都不自增", () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "当前",
      savedContent: "当前",
      dirty: false,
      externalRev: 0,
    });
    const st = useVaultStore.getState();

    expect(st.applyExternalContent("b.md", "别处内容")).toBe(false);
    expect(st.applyExternalContent("a.md", "当前")).toBe(false);

    useVaultStore.setState({ dirty: true });
    expect(useVaultStore.getState().applyExternalContent("a.md", "远端内容")).toBe(false);

    expect(useVaultStore.getState().externalRev).toBe(0);
    expect(useVaultStore.getState().content).toBe("当前");
  });

  it("applyExternalContent 成功后 dirty 清零、基线对齐", () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧",
      savedContent: "旧",
      dirty: false,
      externalRev: 7,
    });

    expect(useVaultStore.getState().applyExternalContent("a.md", "远端新版")).toBe(true);
    const s = useVaultStore.getState();
    expect(s.content).toBe("远端新版");
    expect(s.savedContent).toBe("远端新版");
    expect(s.externalRev).toBe(8);
    expect(s.dirty).toBe(false);
  });

  it("applyExternalContent：编辑器里还有未进 store 的输入 → 先 flush 并放弃替换", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "当前",
      savedContent: "当前",
      dirty: false,
      externalRev: 0,
    });
    m.flushEditorContent.mockReturnValueOnce("当前 + 最后 200ms 输入");

    expect(useVaultStore.getState().applyExternalContent("a.md", "远端新版")).toBe(false);
    const s = useVaultStore.getState();
    expect(s.content).toBe("当前 + 最后 200ms 输入");
    expect(s.dirty).toBe(true);
    expect(s.externalRev).toBe(0); // 不替换编辑器，用户输入保住
    await useVaultStore.getState().saveNow(); // 收掉尾沿定时器
  });
});

/* ── S6：切 activePath / mode 之前必须 flush ── */

describe("切换前 flush 编辑器（S6）", () => {
  it("openNote：flush 在 dirty 保存与 readNote 之前，内容写回旧笔记", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧内容",
      savedContent: "旧内容",
      dirty: false,
    });
    m.flushEditorContent.mockReturnValueOnce("旧内容 + 最后 200ms 输入");

    await useVaultStore.getState().openNote("b.md");

    // 最后一段输入写进了 a.md，而不是新打开的 b.md
    expect(writeNote).toHaveBeenCalledWith("a.md", "旧内容 + 最后 200ms 输入\n");
    expect(useVaultStore.getState().activePath).toBe("b.md");
    expect(useVaultStore.getState().content).toBe("内容b.md");
    const flushOrder = m.flushEditorContent.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(readNote.mock.invocationCallOrder[0]);
    expect(flushOrder).toBeLessThan(writeNote.mock.invocationCallOrder[0]);
  });

  it("closeNote：flush 后落盘旧笔记，再清空", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧内容",
      savedContent: "旧内容",
      dirty: false,
    });
    m.flushEditorContent.mockReturnValueOnce("最后输入");

    await useVaultStore.getState().closeNote();

    expect(writeNote).toHaveBeenCalledWith("a.md", "最后输入\n");
    expect(useVaultStore.getState().activePath).toBeNull();
    expect(useVaultStore.getState().dirty).toBe(false);
  });

  it("switchVault：flush 在停循环与换库之前", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧内容",
      savedContent: "旧内容",
      dirty: false,
    });
    m.setPathWithCreate.mockResolvedValueOnce("/v2");
    m.flushEditorContent.mockReturnValueOnce("最后输入");

    await useVaultStore.getState().switchVault("/v2", "open");

    expect(writeNote).toHaveBeenCalledWith("a.md", "最后输入\n");
    const flushOrder = m.flushEditorContent.mock.invocationCallOrder[0];
    expect(flushOrder).toBeLessThan(stopAutoLoopMock.mock.invocationCallOrder[0]);
    expect(flushOrder).toBeLessThan(m.setPathWithCreate.mock.invocationCallOrder[0]);
  });

  it("setEditorMode：切模式前 flush，内容进 store（随后由自动保存落盘）", () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "旧内容",
      savedContent: "旧内容",
      dirty: false,
      editorMode: "wysiwyg",
    });
    m.flushEditorContent.mockReturnValueOnce("最后输入");

    useVaultStore.getState().setEditorMode("source");

    const s = useVaultStore.getState();
    expect(s.content).toBe("最后输入");
    expect(s.dirty).toBe(true);
    expect(s.editorMode).toBe("source");
    // 收掉尾沿定时器（本用例只关心同步 flush 的即时结果）
    void useVaultStore.getState().saveNow();
  });

  it("flush 返回 null（无变化）→ 不制造伪 dirty、不写盘", async () => {
    useVaultStore.setState({
      activePath: "a.md",
      content: "稳定内容",
      savedContent: "稳定内容",
      dirty: false,
    });
    m.flushEditorContent.mockReturnValueOnce(null);

    await useVaultStore.getState().closeNote();

    expect(writeNote).not.toHaveBeenCalled();
    expect(useVaultStore.getState().activePath).toBeNull();
  });
});

describe("移动端建库（v0.2.0 release 真机 P0 回归）", () => {
  const APP_FILES = "/storage/emulated/0/Android/data/com.lanmark.app/files";

  it("pickAppDir：目录取自框架 appDir（getExternalFilesDir），不自行硬编码整链路径", async () => {
    m.appDir.mockResolvedValue(APP_FILES);
    m.setPathWithCreate.mockResolvedValueOnce(`${APP_FILES}/lanmark-vault`);

    await useVaultStore.getState().pickAppDir("create");

    expect(m.setPathWithCreate).toHaveBeenCalledWith(`${APP_FILES}/lanmark-vault`, "create");
    expect(useVaultStore.getState().status).toBe("ready");
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("pickAppDir：框架返回 null → 退回旧硬编码路径（老机型兜底）", async () => {
    m.appDir.mockResolvedValue(null);
    m.setPathWithCreate.mockResolvedValueOnce("/x");

    await useVaultStore.getState().pickAppDir("create");

    expect(m.setPathWithCreate).toHaveBeenCalledWith(
      "/storage/emulated/0/Android/data/com.lanmark.app/files/lanmark-vault",
      "create",
    );
  });

  it("pickCustomAndroidDir：目录不存在 → 自动转「创建」建库（不再死锁「目录不存在」）", async () => {
    m.setPath.mockRejectedValueOnce(new Error("目录不存在: /sdcard/Notes"));
    m.setPathWithCreate.mockResolvedValueOnce("/sdcard/Notes");

    await useVaultStore.getState().pickCustomAndroidDir("/sdcard/Notes", "open");

    expect(m.setPathWithCreate).toHaveBeenCalledWith("/sdcard/Notes", "create");
    expect(useVaultStore.getState().status).toBe("ready");
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("pickCustomAndroidDir：打开失败但非「目录不存在」→ 原样报错，不误转创建", async () => {
    m.setPath.mockRejectedValueOnce(new Error("权限不足"));

    await useVaultStore.getState().pickCustomAndroidDir("/sdcard/Notes", "open");

    expect(useVaultStore.getState().error).toContain("权限不足");
    expect(m.setPathWithCreate).not.toHaveBeenCalled();
  });
});

/* ── M4d：切换笔记库的安全流程（docs/08 §6.1，最高风险） ── */

describe("switchVault：切换笔记库", () => {
  it("有未保存编辑 → 先落盘再切库", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "未保存", dirty: true });
    m.setPathWithCreate.mockResolvedValueOnce("/v2");

    const ok = await useVaultStore.getState().switchVault("/v2", "open");

    expect(writeNote).toHaveBeenCalledWith("a.md", "未保存\n");
    expect(ok).toBe(true);
    const s = useVaultStore.getState();
    expect(s.vaultPath).toBe("/v2");
    expect(s.activePath).toBeNull();
    expect(s.content).toBe("");
    expect(s.dirty).toBe(false);
  });

  it("落盘失败 → 不切库，原 vault 与未保存内容完整保留", async () => {
    useVaultStore.setState({ activePath: "a.md", content: "未保存的重要内容", dirty: true });
    writeNote.mockRejectedValueOnce(new Error("磁盘满"));

    const ok = await useVaultStore.getState().switchVault("/v2", "open");

    expect(ok).toBe(false);
    expect(m.setPathWithCreate).not.toHaveBeenCalled(); // 根本没走到换库
    const s = useVaultStore.getState();
    expect(s.vaultPath).toBe("/v");
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("未保存的重要内容");
    expect(s.dirty).toBe(true);
    expect(s.error).toBeTruthy();
  });

  it("开库失败 → 保留原 vault 与状态，不出现「已切库但树是旧的」", async () => {
    useVaultStore.setState({ tree: [{ path: "a.md", kind: "note", name: "a", title: null }] });
    m.setPathWithCreate.mockRejectedValueOnce(new Error("目录不存在: /nope"));

    const ok = await useVaultStore.getState().switchVault("/nope", "open");

    expect(ok).toBe(false);
    const s = useVaultStore.getState();
    expect(s.vaultPath).toBe("/v");
    expect(s.status).toBe("ready");
    expect(s.tree).toHaveLength(1); // 旧树没被清空
    expect(s.error).toContain("目录不存在");
  });

  it("先停自动同步循环，再开新库（避免回合打到半切换状态）", async () => {
    m.setPathWithCreate.mockResolvedValueOnce("/v2");
    stopAutoLoopMock.mockClear();

    await useVaultStore.getState().switchVault("/v2", "open");

    expect(stopAutoLoopMock).toHaveBeenCalled();
    // 停循环必须发生在开库之前
    const stopOrder = stopAutoLoopMock.mock.invocationCallOrder[0];
    const openOrder = m.setPathWithCreate.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(openOrder);
  });

  it("成功切库后重取树与 meta", async () => {
    m.setPathWithCreate.mockResolvedValueOnce("/v2");
    tree.mockResolvedValueOnce([]);
    recents.mockResolvedValueOnce([]);
    favorites.mockResolvedValueOnce([]);

    await useVaultStore.getState().switchVault("/v2", "open");

    expect(tree).toHaveBeenCalled();
    expect(recents).toHaveBeenCalled();
    expect(favorites).toHaveBeenCalled();
  });
});

/* ── v0.5.1：侧栏「回收站」与分区折叠 ── */

describe("v0.5.1 refreshMeta：最近固定 3 条、收藏不截断、回收站随刷", () => {
  it("recents 只保留 3 条", async () => {
    recents.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => [`n${i}.md`, `笔记${i}`] as [string, string]),
    );
    await useVaultStore.getState().refreshMeta();
    const s = useVaultStore.getState();
    expect(s.recents).toHaveLength(3);
    expect(s.recents[0].path).toBe("n0.md");
  });

  it("favorites 不截断（展示交给侧栏折叠）", async () => {
    favorites.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => [`f${i}.md`, `收藏${i}`] as [string, string]),
    );
    await useVaultStore.getState().refreshMeta();
    expect(useVaultStore.getState().favorites).toHaveLength(7);
  });

  it("trash 随 refreshMeta 更新（开笔记/删除/恢复/远端改动后自动同步）", async () => {
    m.trashList.mockResolvedValue([
      { trashPath: ".lanmark/trash/1-a.md", name: "a.md", kind: "note", origin: "a.md", deletedAt: 1, bytes: 3 },
    ]);
    await useVaultStore.getState().refreshMeta();
    expect(m.trashList).toHaveBeenCalled();
    expect(useVaultStore.getState().trash).toHaveLength(1);
  });

  it("trashList 失败不炸 meta（error 提示，recents/favorites 照旧设置前的旧值）", async () => {
    m.trashList.mockRejectedValue(new Error("无 vault"));
    await useVaultStore.getState().refreshMeta();
    expect(useVaultStore.getState().error).toContain("无 vault");
  });
});

describe("v0.5.1 restoreFromTrash", () => {
  it("恢复成功：刷新树与 meta + 展开祖先目录", async () => {
    m.trashRestore.mockResolvedValue("研发/回来了.md");
    useVaultStore.setState({
      tree: [{ path: "研发", kind: "folder", name: "研发", title: null }],
      collapsedDirs: new Set(["研发"]),
    });

    const restored = await useVaultStore.getState().restoreFromTrash(".lanmark/trash/1-x.md");

    expect(restored).toBe("研发/回来了.md");
    expect(m.trashRestore).toHaveBeenCalledWith(".lanmark/trash/1-x.md");
    expect(tree).toHaveBeenCalled();
    expect(useVaultStore.getState().collapsedDirs.has("研发")).toBe(false);
    expect(useVaultStore.getState().error).toBeNull();
  });

  it("恢复失败：error 提示，返回 null", async () => {
    m.trashRestore.mockRejectedValue(new Error("恢复失败"));
    const restored = await useVaultStore.getState().restoreFromTrash(".lanmark/trash/1-x.md");
    expect(restored).toBeNull();
    expect(useVaultStore.getState().error).toContain("恢复失败");
  });
});

describe("v0.5.1 分区折叠状态（按 vault 持久化）", () => {
  it("默认收起；toggle 展开/再收起", () => {
    const s = useVaultStore.getState();
    expect(s.expandedSections.size).toBe(0);

    useVaultStore.getState().toggleMetaSection("favorites");
    expect(useVaultStore.getState().expandedSections.has("favorites")).toBe(true);

    useVaultStore.getState().toggleMetaSection("favorites");
    expect(useVaultStore.getState().expandedSections.has("favorites")).toBe(false);
  });
});

/* ── T1：保存完成不得覆盖在途输入 / 污染已切走的笔记 ── */

describe("saveNow：陈旧完成不覆盖新输入", () => {
  it("写入期间继续输入 → 完成只更新基线，保留新内容与 dirty", async () => {
    let resolveWrite: () => void = () => {};
    writeNote.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    useVaultStore.setState({
      activePath: "a.md",
      content: "第一版",
      savedContent: "磁盘基线",
      dirty: true,
      savedAt: null,
    });

    const saving = useVaultStore.getState().saveNow();
    expect(writeNote).toHaveBeenCalledWith("a.md", "第一版\n");

    // 写入在途时用户继续输入（store 收到新内容，dirty 保持）
    useVaultStore.getState().setContent("第二版");
    expect(useVaultStore.getState().dirty).toBe(true);

    resolveWrite();
    expect(await saving).toBe(true);

    const s = useVaultStore.getState();
    expect(s.content).toBe("第二版"); // 旧快照不得覆盖新输入
    expect(s.dirty).toBe(true); // 新输入还没落盘
    expect(s.savedContent).toBe("第一版\n"); // 基线 = 磁盘真实内容
    expect(s.savedAt).not.toBeNull();

    // 收掉 setContent 排的尾沿定时器，避免影响后续用例
    await useVaultStore.getState().saveNow();
  });

  it("写入期间切到另一篇笔记 → 完成不得污染 B 的状态", async () => {
    let resolveWrite: () => void = () => {};
    writeNote.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );
    useVaultStore.setState({
      activePath: "a.md",
      content: "A 未保存内容",
      savedContent: "A 磁盘基线",
      dirty: true,
      savedAt: null,
    });

    const saving = useVaultStore.getState().saveNow();
    // 写入在途时切到 b.md（openNote 会先落盘旧笔记，第二次 write 走默认成功实现）
    await useVaultStore.getState().openNote("b.md");
    expect(useVaultStore.getState().activePath).toBe("b.md");

    resolveWrite();
    expect(await saving).toBe(true);

    const s = useVaultStore.getState();
    expect(s.activePath).toBe("b.md");
    expect(s.content).toBe("内容b.md");
    expect(s.savedContent).toBe("内容b.md");
    expect(s.dirty).toBe(false);
    expect(s.savedAt).toBeNull(); // 旧笔记的完成时间不得写进 B
  });

  it("无并发时照常清 dirty、回写规范内容并派发保存事件", async () => {
    const onSaved = vi.fn();
    window.addEventListener("lanmark:vault-saved", onSaved);
    try {
      useVaultStore.setState({
        activePath: "a.md",
        content: "第一版 ",
        savedContent: "磁盘基线",
        dirty: true,
        savedAt: null,
      });

      expect(await useVaultStore.getState().saveNow()).toBe(true);

      const s = useVaultStore.getState();
      expect(s.content).toBe("第一版\n");
      expect(s.savedContent).toBe("第一版\n");
      expect(s.dirty).toBe(false);
      expect(s.savedAt).not.toBeNull();
      expect(onSaved).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("lanmark:vault-saved", onSaved);
    }
  });
});


/* ── T2：改名/移动前必须先落盘，防旧路径定时器把编辑写回孤儿文件 ── */

describe("改名/移动前先落盘", () => {
  it("commitRename：dirty 时 writeNote 先于 rename", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "未保存内容",
      savedContent: "磁盘基线",
      dirty: true,
    });
    rename.mockResolvedValueOnce("b.md");

    await useVaultStore.getState().commitRename("a.md", "b");

    expect(writeNote).toHaveBeenCalledWith("a.md", "未保存内容\n");
    expect(writeNote.mock.invocationCallOrder[0]).toBeLessThan(
      rename.mock.invocationCallOrder[0],
    );
    expect(useVaultStore.getState().dirty).toBe(false);
  });

  it("commitRename：落盘失败 → 中止改名，状态与树保留", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "未保存的重要内容",
      savedContent: "磁盘基线",
      dirty: true,
    });
    writeNote.mockRejectedValueOnce(new Error("磁盘满"));

    await useVaultStore.getState().commitRename("a.md", "b");

    expect(rename).not.toHaveBeenCalled();
    expect(tree).not.toHaveBeenCalled();
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("未保存的重要内容");
    expect(s.savedContent).toBe("磁盘基线");
    expect(s.dirty).toBe(true);
    expect(s.tree).toHaveLength(1);
    expect(s.error).toBeTruthy();
  });

  it("commitRename：落盘期间又有新输入（dirty 仍在）→ 中止改名", async () => {
    let resolveWrite: () => void = () => {};
    writeNote.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "第一版",
      savedContent: "磁盘基线",
      dirty: true,
    });
    rename.mockResolvedValueOnce("b.md");

    const renaming = useVaultStore.getState().commitRename("a.md", "b");
    // 写入在途时用户继续输入：saveNow 成功返回 true，但 T1 语义保留 dirty
    useVaultStore.getState().setContent("第二版");
    resolveWrite();
    await renaming;

    // 落盘确实成功（baseline 已更新），但新输入未落盘 → 不得带着旧路径改名
    expect(rename).not.toHaveBeenCalled();
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("第二版");
    expect(s.savedContent).toBe("第一版\n");
    expect(s.dirty).toBe(true);
    expect(s.error).toBeNull();

    // 收掉 setContent 排的尾沿定时器，避免影响后续用例
    await useVaultStore.getState().saveNow();
  });

  it("commitRename：非 dirty 时行为不变（不多写盘）", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "稳定内容",
      savedContent: "稳定内容",
      dirty: false,
    });
    rename.mockResolvedValueOnce("b.md");

    await useVaultStore.getState().commitRename("a.md", "b");

    expect(writeNote).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith("a.md", "b");
  });

  it("moveNode：dirty 时 writeNote 先于 move", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "未保存内容",
      savedContent: "磁盘基线",
      dirty: true,
    });
    move.mockResolvedValueOnce("d/a.md");

    await useVaultStore.getState().moveNode("a.md", "d");

    expect(writeNote).toHaveBeenCalledWith("a.md", "未保存内容\n");
    expect(writeNote.mock.invocationCallOrder[0]).toBeLessThan(
      move.mock.invocationCallOrder[0],
    );
    expect(useVaultStore.getState().dirty).toBe(false);
  });

  it("moveNode：落盘失败 → 中止移动，状态保留", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "未保存的重要内容",
      savedContent: "磁盘基线",
      dirty: true,
    });
    writeNote.mockRejectedValueOnce(new Error("权限不足"));

    await useVaultStore.getState().moveNode("a.md", "d");

    expect(move).not.toHaveBeenCalled();
    const s = useVaultStore.getState();
    expect(s.activePath).toBe("a.md");
    expect(s.content).toBe("未保存的重要内容");
    expect(s.dirty).toBe(true);
    expect(s.error).toBeTruthy();
  });

  it("moveNode：非 dirty 时行为不变（不多写盘）", async () => {
    useVaultStore.setState({
      tree: [{ path: "a.md", kind: "note", name: "a.md", title: null }],
      activePath: "a.md",
      content: "稳定内容",
      savedContent: "稳定内容",
      dirty: false,
    });
    move.mockResolvedValueOnce("d/a.md");

    await useVaultStore.getState().moveNode("a.md", "d");

    expect(writeNote).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledWith("a.md", "d");
  });
});
