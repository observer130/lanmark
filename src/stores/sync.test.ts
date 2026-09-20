/**
 * sync store 同步回合与 vault store 的衔接（review 修复回归）：
 * - 同步前先落盘未保存编辑（否则旧内容+改动会覆盖刚拉下的版本）
 * - 落盘失败中止同步
 * - 同步后刷新树/元数据 + 重载当前笔记（磁盘被拉取更新时）
 * - 同步期间用户开始输入（dirty）时不吞掉正在进行的编辑
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  syncNow: vi.fn(),
  readNote: vi.fn(),
  vaultSetState: vi.fn(),
  isAndroidFlag: false,
  hasAllFilesAccess: vi.fn(),
  requestAllFilesAccess: vi.fn(),
  vaultState: {
    dirty: false,
    activePath: null as string | null,
    content: "",
    saveNow: vi.fn(),
    refreshTree: vi.fn(),
    refreshMeta: vi.fn(),
  },
}));

vi.mock("./vault", () => ({
  useVaultStore: {
    getState: () => m.vaultState,
    setState: m.vaultSetState,
  },
}));
vi.mock("../lib/vault", () => ({ vault: { readNote: m.readNote } }));
vi.mock("../lib/sync", () => ({
  sync: {
    syncNow: m.syncNow,
    pairingInfo: vi.fn(),
    servers: vi.fn(),
    discover: vi.fn(),
    pair: vi.fn(),
    serverRemove: vi.fn(),
  },
  vaultPicker: {
    hasAllFilesAccess: m.hasAllFilesAccess,
    requestAllFilesAccess: m.requestAllFilesAccess,
    pickFolder: vi.fn(),
  },
  isAndroid: () => m.isAndroidFlag,
}));

import { useSyncStore } from "./sync";

const REPORT = { pulled: ["b.md"], pushed: [], merges: [], deleted: [], skipped: 2, errors: [] };

function setVaultState(patch: Partial<typeof m.vaultState>) {
  Object.assign(m.vaultState, {
    dirty: false,
    activePath: null,
    content: "",
    saveNow: vi.fn(async () => true),
    refreshTree: vi.fn(async () => {}),
    refreshMeta: vi.fn(async () => {}),
  });
  Object.assign(m.vaultState, patch);
}

beforeEach(() => {
  vi.clearAllMocks();
  setVaultState({});
  m.syncNow.mockResolvedValue(REPORT);
  m.readNote.mockImplementation((p: string) => Promise.resolve({ content: `内容${p}`, title: p }));
  useSyncStore.setState({ syncing: false, lastReport: null, error: null });
});

describe("syncNow 与 vault store 衔接", () => {
  it("同步后刷新树/元数据，并拉取更新当前笔记", async () => {
    setVaultState({ activePath: "a.md", content: "旧" });
    m.readNote.mockResolvedValue({ content: "拉取的新版", title: "a.md" });

    await useSyncStore.getState().syncNow("s1");

    expect(m.syncNow).toHaveBeenCalledWith("s1");
    expect(m.vaultState.refreshTree).toHaveBeenCalled();
    expect(m.vaultState.refreshMeta).toHaveBeenCalled();
    expect(m.vaultSetState).toHaveBeenCalledWith(
      expect.objectContaining({ content: "拉取的新版" }),
    );
    expect(useSyncStore.getState().lastReport).toEqual(REPORT);
  });

  it("当前笔记磁盘未变 → 不重载", async () => {
    setVaultState({ activePath: "a.md", content: "内容a.md" });

    await useSyncStore.getState().syncNow("s1");

    expect(m.vaultSetState).not.toHaveBeenCalled();
  });

  it("同步前有未保存编辑 → 先落盘再同步", async () => {
    setVaultState({ activePath: "a.md", content: "未保存", dirty: true });

    await useSyncStore.getState().syncNow("s1");

    expect(m.vaultState.saveNow).toHaveBeenCalled();
    expect(m.syncNow).toHaveBeenCalled();
    // saveNow 调用顺序必须先于 sync 回合
    const saveOrder = m.vaultState.saveNow.mock.invocationCallOrder[0];
    const syncOrder = m.syncNow.mock.invocationCallOrder[0];
    expect(saveOrder).toBeLessThan(syncOrder);
  });

  it("落盘失败 → 中止同步并提示", async () => {
    setVaultState({ activePath: "a.md", content: "未保存", dirty: true });
    m.vaultState.saveNow = vi.fn(async () => false);

    await useSyncStore.getState().syncNow("s1");

    expect(m.syncNow).not.toHaveBeenCalled();
    expect(useSyncStore.getState().error).toBeTruthy();
    expect(useSyncStore.getState().syncing).toBe(false);
  });

  it("同步期间用户开始输入（dirty）→ 不吞掉正在进行的编辑", async () => {
    setVaultState({ activePath: "a.md", content: "旧" });
    m.syncNow.mockImplementation(async () => {
      // 模拟回合期间用户开始打字
      m.vaultState.dirty = true;
      m.vaultState.content = "旧 + 用户新输入";
      return REPORT;
    });
    m.readNote.mockResolvedValue({ content: "拉取的新版", title: "a.md" });

    await useSyncStore.getState().syncNow("s1");

    expect(m.vaultSetState).not.toHaveBeenCalled();
    expect(m.vaultState.content).toBe("旧 + 用户新输入");
  });

  it("当前笔记被对端删除 → 保留当前状态不报错", async () => {
    setVaultState({ activePath: "a.md", content: "旧" });
    m.readNote.mockRejectedValue(new Error("笔记不存在"));

    await useSyncStore.getState().syncNow("s1");

    expect(m.vaultSetState).not.toHaveBeenCalled();
    expect(useSyncStore.getState().error).toBeNull();
  });
});

describe("Android 授权状态（VaultPicker 订阅源）", () => {
  beforeEach(() => {
    m.isAndroidFlag = true;
    useSyncStore.setState({ hasAllFilesAccess: false });
  });

  it("checkAllFilesAccess 把授权结果写入可订阅字段", async () => {
    m.hasAllFilesAccess.mockResolvedValueOnce(true);
    const ok = await useSyncStore.getState().checkAllFilesAccess();
    expect(ok).toBe(true);
    expect(useSyncStore.getState().hasAllFilesAccess).toBe(true);
  });

  it("未授权时保持 false（组件据此渲染「去授权」）", async () => {
    m.hasAllFilesAccess.mockResolvedValueOnce(false);
    await useSyncStore.getState().checkAllFilesAccess();
    expect(useSyncStore.getState().hasAllFilesAccess).toBe(false);
  });

  it("非 Android 平台直接放行（不发插件调用）", async () => {
    m.isAndroidFlag = false;
    const ok = await useSyncStore.getState().checkAllFilesAccess();
    expect(ok).toBe(true);
    expect(m.hasAllFilesAccess).not.toHaveBeenCalled();
  });
});
