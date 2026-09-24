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
  tree: vi.fn(),
  search: vi.fn(),
  rename: vi.fn(),
  move: vi.fn(),
  setPath: vi.fn(),
  setPathWithCreate: vi.fn(),
  appDir: vi.fn(),
}));

vi.mock("../lib/vault", () => ({
  vault: {
    status: vi.fn(),
    readNote: m.readNote,
    writeNote: m.writeNote,
    tree: m.tree,
    recents: m.recents,
    favorites: m.favorites,
    reindex: vi.fn(),
    pickAndSet: vi.fn(),
    setPath: m.setPath,
    setPathWithCreate: m.setPathWithCreate,
    folderColors: vi.fn(async () => ({})),
    setFolderColor: vi.fn(async () => undefined),
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
// switchVault 会停自动同步循环（先停再切，防止回合打到半切换状态）→ 桩掉 sync store
vi.mock("./sync", () => ({
  useSyncStore: { getState: () => ({ stopAutoLoop: stopAutoLoopMock }) },
}));
const stopAutoLoopMock = vi.fn();

import { useVaultStore } from "./vault";

const { readNote, writeNote, recents, favorites, tree, search, rename, move } = m;

function baseState() {
  useVaultStore.setState({
    status: "ready",
    vaultPath: "/v",
    tree: [],
    activePath: null,
    content: "",
    dirty: false,
    savedAt: null,
    editorMode: "wysiwyg",
    renamingPath: null,
    searchQuery: "",
    searchResults: [],
    recents: [],
    favorites: [],
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  baseState();
  readNote.mockImplementation((p: string) => Promise.resolve({ content: `内容${p}`, title: p }));
  writeNote.mockResolvedValue(undefined);
  recents.mockResolvedValue([]);
  favorites.mockResolvedValue([]);
  tree.mockResolvedValue([]);
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
      // t=800 = 最后一次输入(100) + 700
      await vi.advanceTimersByTimeAsync(100);
      expect(writeNote).toHaveBeenCalledTimes(1);
      expect(writeNote).toHaveBeenCalledWith("a.md", "ab");
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
    expect(recents).toHaveBeenCalled();
    expect(favorites).toHaveBeenCalled();
  });

  it("move 后刷新 recents/favorites", async () => {
    move.mockResolvedValueOnce("d/a.md");
    await useVaultStore.getState().moveNode("a.md", "d");
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

    expect(writeNote).toHaveBeenCalledWith("a.md", "未保存");
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
