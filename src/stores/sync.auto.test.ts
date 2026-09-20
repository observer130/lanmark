/**
 * M3 自动同步循环状态机（docs/07 §7）：
 * - 开关关 → 无探测无回合（仅手动可用）
 * - 触发 A：在线 60s 至多 1 回合
 * - 触发 B：离线退避 1s→2s→4s→…→60s，离线→在线跳变立即回合
 * - 串行锁：回合进行中不双发
 * - 触发 C：保存完成 5s 尾沿（再次保存重置计时）
 * - 开关持久化（vault.setSyncAuto）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  probe: vi.fn(),
  syncNow: vi.fn(),
  servers: vi.fn(),
  discover: vi.fn(),
  serverSetUrl: vi.fn(),
  readNote: vi.fn(),
  vaultStatus: vi.fn(),
  vaultSetSyncAuto: vi.fn(),
  vaultState: {
    status: "ready" as "loading" | "unconfigured" | "ready",
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
    setState: vi.fn(),
  },
}));
vi.mock("../lib/vault", () => ({
  vault: {
    readNote: m.readNote,
    status: m.vaultStatus,
    setSyncAuto: m.vaultSetSyncAuto,
  },
}));
vi.mock("../lib/sync", () => ({
  sync: {
    probe: m.probe,
    syncNow: m.syncNow,
    servers: m.servers,
    discover: m.discover,
    serverSetUrl: m.serverSetUrl,
    pairingInfo: vi.fn(),
    pair: vi.fn(),
    serverRemove: vi.fn(),
  },
  vaultPicker: {
    hasAllFilesAccess: vi.fn(),
    requestAllFilesAccess: vi.fn(),
    pickFolder: vi.fn(),
  },
  isAndroid: () => false,
}));

import { useSyncStore, backoffMs } from "./sync";

const SRV = {
  id: "s1",
  name: "phone",
  url: "http://127.0.0.1:4180",
  token: "t",
  lastSuccessAt: null,
};

const REPORT = {
  pulled: [],
  pushed: [],
  merges: [],
  deleted: [],
  skipped: 0,
  errors: [],
};

function reset() {
  vi.clearAllMocks();
  m.probe.mockResolvedValue({ online: true, name: "phone", notes: 1, assets: 0 });
  m.syncNow.mockResolvedValue(REPORT);
  m.servers.mockResolvedValue([SRV]);
  m.discover.mockResolvedValue([]);
  m.vaultStatus.mockResolvedValue({
    configured: true,
    open: true,
    path: "/tmp/v",
    syncAuto: true,
  });
  m.vaultSetSyncAuto.mockResolvedValue(true);
  Object.assign(m.vaultState, {
    status: "ready",
    dirty: false,
    activePath: null,
    content: "",
    saveNow: vi.fn(async () => true),
    refreshTree: vi.fn(async () => {}),
    refreshMeta: vi.fn(async () => {}),
  });
  useSyncStore.setState({
    servers: [SRV],
    syncAuto: true,
    probeStates: {},
    syncing: false,
    lastReport: null,
    error: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  reset();
});

afterEach(() => {
  useSyncStore.getState().stopAutoLoop();
  vi.useRealTimers();
});

describe("M3 自动同步循环状态机", () => {
  it("开关关 → 无探测无回合（仅手动可用）", async () => {
    useSyncStore.setState({ syncAuto: false });
    useSyncStore.getState().startAutoLoop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.probe).not.toHaveBeenCalled();
    expect(m.syncNow).not.toHaveBeenCalled();
  });

  it("vault 未打开 → 循环空转", async () => {
    m.vaultState.status = "unconfigured";
    useSyncStore.getState().startAutoLoop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(m.probe).not.toHaveBeenCalled();
    expect(m.syncNow).not.toHaveBeenCalled();
  });

  it("触发 A：在线 60s 至多 1 回合（探测 60s 间隔 + 回合 60s 门控）", async () => {
    useSyncStore.getState().startAutoLoop();
    // t=1s（首个 tick）：首次探测 + 首次回合（lastRoundAt=0）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.probe).toHaveBeenCalledTimes(1);
    expect(m.syncNow).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().probeStates.s1?.online).toBe(true);

    // t=31s：未到 60s 探测间隔 → 无新探测
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.probe).toHaveBeenCalledTimes(1);
    expect(m.syncNow).toHaveBeenCalledTimes(1);

    // t=61s：再次探测，且距上回合 ≥60s → 第 2 回合
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.probe).toHaveBeenCalledTimes(2);
    expect(m.syncNow).toHaveBeenCalledTimes(2);
  });

  it("触发 B：离线退避 1s→2s→4s，第 3 次失败尝试 mDNS，恢复跳变立即回合", async () => {
    let calls = 0;
    m.probe.mockImplementation(async () => {
      calls += 1;
      return calls < 4
        ? { online: false, name: "phone", notes: 0, assets: 0 }
        : { online: true, name: "phone", notes: 1, assets: 0 };
    });
    useSyncStore.getState().startAutoLoop();

    // 探测序列：t=1s（失败1，退避1s）、t=2s（失败2，退避2s）、t=4s（失败3→mDNS，退避4s）、t=8s（恢复）
    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.probe).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().probeStates.s1?.online).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(m.probe).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(m.probe).toHaveBeenCalledTimes(3);
    // 连续失败 3 次 → mDNS 重发现（本环境常不可达，best effort）
    expect(m.discover).toHaveBeenCalledTimes(1);
    // 恢复前不应有回合
    expect(m.syncNow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(m.probe).toHaveBeenCalledTimes(4);
    expect(useSyncStore.getState().probeStates.s1?.online).toBe(true);
    // 离线→在线跳变 → 立即回合（不受 60s 门控）
    expect(m.syncNow).toHaveBeenCalledTimes(1);
  });

  it("串行锁：回合进行中 → 探测照常但不双发回合", async () => {
    useSyncStore.getState().startAutoLoop();
    await vi.advanceTimersByTimeAsync(1_000); // 首回合完成（t=1s）
    expect(m.syncNow).toHaveBeenCalledTimes(1);

    // 模拟一个进行中的回合（手动触发中）
    useSyncStore.setState({ syncing: true });
    await vi.advanceTimersByTimeAsync(60_000); // t=61s：探测窗口到了
    expect(m.probe).toHaveBeenCalledTimes(2); // 探测照常
    expect(m.syncNow).toHaveBeenCalledTimes(1); // 回合被串行锁挡住

    useSyncStore.setState({ syncing: false });
    await vi.advanceTimersByTimeAsync(60_000); // t=121s：下一窗口正常回合
    expect(m.syncNow).toHaveBeenCalledTimes(2);
  });

  it("触发 C：保存 5s 尾沿回合；再次保存重置计时（尾沿纪律）", async () => {
    useSyncStore.getState().startAutoLoop();
    await vi.advanceTimersByTimeAsync(1_000); // 首回合（t=1s，探测触发）
    expect(m.syncNow).toHaveBeenCalledTimes(1);

    // 保存 → 5s 尾沿
    window.dispatchEvent(new CustomEvent("lanmark:vault-saved")); // t=1s
    await vi.advanceTimersByTimeAsync(3_000); // t=4s
    expect(m.syncNow).toHaveBeenCalledTimes(1); // 未到 5s
    window.dispatchEvent(new CustomEvent("lanmark:vault-saved")); // t=4s 再保存 → 重置
    await vi.advanceTimersByTimeAsync(2_000); // t=6s
    expect(m.syncNow).toHaveBeenCalledTimes(1); // 距末次保存仅 2s
    await vi.advanceTimersByTimeAsync(3_000); // t=9s：末次保存后满 5s
    expect(m.syncNow).toHaveBeenCalledTimes(2); // 尾沿回合
  });

  it("离线服务器不参与保存触发的回合（等探测恢复）", async () => {
    m.probe.mockResolvedValue({ online: false, name: "phone", notes: 0, assets: 0 });
    useSyncStore.getState().startAutoLoop();
    await vi.advanceTimersByTimeAsync(1_000); // 首次探测 → 离线
    expect(useSyncStore.getState().probeStates.s1?.online).toBe(false);

    window.dispatchEvent(new CustomEvent("lanmark:vault-saved")); // t=1s
    await vi.advanceTimersByTimeAsync(10_000); // t=11s
    expect(m.syncNow).not.toHaveBeenCalled(); // 离线 → 保存触发跳过
  });

  it("backoff 序列：1s→2s→4s→…→60s 封顶", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(7)).toBe(60_000); // 64s → 封顶
    expect(backoffMs(20)).toBe(60_000);
  });

  it("开关持久化：setSyncAuto 写配置 + 状态同步；loadSyncAuto 读回", async () => {
    const { loadSyncAuto, setSyncAuto } = useSyncStore.getState();
    await loadSyncAuto();
    expect(useSyncStore.getState().syncAuto).toBe(true);

    await setSyncAuto(false);
    expect(m.vaultSetSyncAuto).toHaveBeenCalledWith(false);
    expect(useSyncStore.getState().syncAuto).toBe(false);
  });
});
