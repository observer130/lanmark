/**
 * M4h 连接方式改造的前端测试：LAN 扫描发现 + 一键授权（docs/08 §13.5）。
 *
 * 重点覆盖四态（等待 / 批准 / 拒绝 / 超时）、错误回滚，以及
 * 「局域网扫描」开关关掉后退化为只查已知设备。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  scanLan: vi.fn(),
  connectDevice: vi.fn(),
  pairApprove: vi.fn(),
  pairReject: vi.fn(),
  pairingInfo: vi.fn(),
  conflictCount: vi.fn(),
  servers: vi.fn(),
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
  useVaultStore: { getState: () => m.vaultState, setState: vi.fn() },
}));
vi.mock("../lib/vault", () => ({ vault: { readNote: vi.fn() } }));
vi.mock("../lib/sync", () => ({
  sync: {
    scanLan: m.scanLan,
    connectDevice: m.connectDevice,
    pairApprove: m.pairApprove,
    pairReject: m.pairReject,
    pairingInfo: m.pairingInfo,
    conflictCount: m.conflictCount,
    servers: m.servers,
    discover: vi.fn(),
    pair: vi.fn(),
    serverRemove: vi.fn(),
    syncNow: vi.fn(),
    probe: vi.fn(),
    serverSetUrl: vi.fn(),
  },
  vaultPicker: {
    hasAllFilesAccess: vi.fn(),
    requestAllFilesAccess: vi.fn(),
    pickFolder: vi.fn(),
  },
  isAndroid: () => false,
}));

import { useSyncStore } from "./sync";

function reset() {
  useSyncStore.setState({
    scanned: [],
    scanning: false,
    scanTruncated: false,
    lanScanEnabled: true,
    connecting: null,
    connectOutcome: null,
    servers: [],
    error: null,
    lastReport: null,
    pairing: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
  m.pairingInfo.mockResolvedValue({
    running: true,
    port: 4180,
    deviceName: "Lanmark 手机",
    pairingCode: "12345678",
    lastRoundAt: null,
    lanIp: "http://192.168.1.23:4180",
    deviceId: "dev-abc",
    pendingPairs: [],
  });
  m.conflictCount.mockResolvedValue(0);
  m.servers.mockResolvedValue([]);
});

describe("M4h-1 LAN 扫描", () => {
  it("扫描成功 → 填充候选设备", async () => {
    m.scanLan.mockResolvedValueOnce({
      devices: [
        { name: "REDMI K90", url: "http://192.168.1.23:4180", deviceId: "d1", notes: 42 },
      ],
      truncated: false,
      scannedSubnet: true,
    });
    await useSyncStore.getState().scanLan();
    const s = useSyncStore.getState();
    expect(s.scanned).toHaveLength(1);
    expect(s.scanned[0].name).toBe("REDMI K90");
    expect(s.scanned[0].notes).toBe(42);
    expect(s.scanning).toBe(false);
  });

  it("扫描期间 scanning=true，结束后复位", async () => {
    let release: (v: unknown) => void = () => {};
    m.scanLan.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    const p = useSyncStore.getState().scanLan();
    expect(useSyncStore.getState().scanning).toBe(true);
    release({ devices: [], truncated: false, scannedSubnet: true });
    await p;
    expect(useSyncStore.getState().scanning).toBe(false);
  });

  it("截断结果照常展示并标记", async () => {
    m.scanLan.mockResolvedValueOnce({
      devices: [{ name: "phone", url: "http://10.0.0.5:4180", deviceId: "", notes: 1 }],
      truncated: true,
      scannedSubnet: true,
    });
    await useSyncStore.getState().scanLan();
    expect(useSyncStore.getState().scanTruncated).toBe(true);
  });

  it("扫描失败 → error 非空且不残留 scanning", async () => {
    m.scanLan.mockRejectedValueOnce(new Error("扫描任务失败"));
    await useSyncStore.getState().scanLan();
    const s = useSyncStore.getState();
    expect(s.error).toContain("扫描任务失败");
    expect(s.scanning).toBe(false);
  });

  /** 关掉「局域网扫描」→ 传 allowSubnet=false，UI 退化为只查已知设备（§13.8 走查项 5） */
  it("开关关闭时把 allowSubnet=false 传给后端", async () => {
    useSyncStore.setState({ lanScanEnabled: false });
    m.scanLan.mockResolvedValueOnce({ devices: [], truncated: false, scannedSubnet: false });
    await useSyncStore.getState().scanLan();
    expect(m.scanLan).toHaveBeenCalledWith(false);
  });

  it("开关开启时传 allowSubnet=true", async () => {
    m.scanLan.mockResolvedValueOnce({ devices: [], truncated: false, scannedSubnet: true });
    await useSyncStore.getState().scanLan();
    expect(m.scanLan).toHaveBeenCalledWith(true);
  });
});

describe("M4h-2 一键授权（桌面四态）", () => {
  it("批准 → 刷新服务器列表并清空等待态", async () => {
    m.connectDevice.mockResolvedValueOnce({
      status: "approved",
      profile: { id: "ddev", name: "手机", url: "http://192.168.1.23:4180", token: "t", lastSuccessAt: null },
      reason: null,
    });
    m.servers.mockResolvedValueOnce([
      { id: "ddev", name: "手机", url: "http://192.168.1.23:4180", token: "t", lastSuccessAt: null, deviceId: "dev" },
    ]);

    const ok = await useSyncStore.getState().connectDevice("http://192.168.1.23:4180");
    expect(ok).toBe(true);
    const s = useSyncStore.getState();
    expect(s.connecting).toBeNull();
    expect(s.connectOutcome?.status).toBe("approved");
    expect(s.servers).toHaveLength(1);
    expect(m.servers).toHaveBeenCalled(); // 已刷新
  });

  it("等待中 connecting 指向该设备（UI 显示「等待对方确认」）", async () => {
    let release: (v: unknown) => void = () => {};
    m.connectDevice.mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    const p = useSyncStore.getState().connectDevice("http://10.0.0.9:4180");
    expect(useSyncStore.getState().connecting).toBe("http://10.0.0.9:4180");
    release({ status: "timeout", profile: null, reason: "超时" });
    await p;
    expect(useSyncStore.getState().connecting).toBeNull();
  });

  it("拒绝 → 不刷新服务器列表，保留拒绝原因", async () => {
    m.connectDevice.mockResolvedValueOnce({
      status: "rejected",
      profile: null,
      reason: "对方拒绝了这次连接",
    });
    const ok = await useSyncStore.getState().connectDevice("http://10.0.0.9:4180");
    expect(ok).toBe(false);
    const s = useSyncStore.getState();
    expect(s.connectOutcome?.status).toBe("rejected");
    expect(s.connectOutcome?.reason).toContain("拒绝");
    expect(m.servers).not.toHaveBeenCalled();
  });

  it("超时 → 四态里的 timeout，不是 error", async () => {
    m.connectDevice.mockResolvedValueOnce({
      status: "timeout",
      profile: null,
      reason: "等待对方确认超时",
    });
    const ok = await useSyncStore.getState().connectDevice("http://10.0.0.9:4180");
    expect(ok).toBe(false);
    expect(useSyncStore.getState().connectOutcome?.status).toBe("timeout");
    expect(useSyncStore.getState().error).toBeNull();
  });

  it("连接抛错 → error 且 connecting 复位", async () => {
    m.connectDevice.mockRejectedValueOnce(new Error("配对任务失败"));
    const ok = await useSyncStore.getState().connectDevice("http://10.0.0.9:4180");
    expect(ok).toBe(false);
    const s = useSyncStore.getState();
    expect(s.error).toContain("配对任务失败");
    expect(s.connecting).toBeNull();
  });

  it("开始连接时清掉上一次的结局提示", async () => {
    useSyncStore.setState({ connectOutcome: { status: "rejected", reason: "上次被拒" } });
    m.connectDevice.mockResolvedValueOnce({ status: "timeout", profile: null, reason: "x" });
    await useSyncStore.getState().connectDevice("http://10.0.0.9:4180");
    expect(useSyncStore.getState().connectOutcome?.status).toBe("timeout");
  });
});

describe("M4h-2 一键授权（手机端）", () => {
  it("允许 → 调 IPC 并刷新配对信息", async () => {
    m.pairApprove.mockResolvedValueOnce(undefined);
    await useSyncStore.getState().pairApprove("nonce-1");
    expect(m.pairApprove).toHaveBeenCalledWith("nonce-1");
    expect(m.pairingInfo).toHaveBeenCalled(); // 刷新后卡片消失
  });

  it("拒绝 → 调 IPC 并刷新配对信息", async () => {
    m.pairReject.mockResolvedValueOnce(undefined);
    await useSyncStore.getState().pairReject("nonce-2");
    expect(m.pairReject).toHaveBeenCalledWith("nonce-2");
    expect(m.pairingInfo).toHaveBeenCalled();
  });

  it("允许失败（请求已过期）→ error 非空", async () => {
    m.pairApprove.mockRejectedValueOnce(new Error("请求不存在或已过期"));
    await useSyncStore.getState().pairApprove("old-nonce");
    expect(useSyncStore.getState().error).toContain("已过期");
  });

  it("配对信息带 pendingPairs 与 lanIp（手机面板据此渲染卡片与本机地址）", async () => {
    m.pairingInfo.mockResolvedValueOnce({
      running: true,
      port: 4180,
      deviceName: "Lanmark 手机",
      pairingCode: "12345678",
      lastRoundAt: null,
      lanIp: "http://192.168.1.23:4180",
      deviceId: "dev-abc",
      pendingPairs: [
        { nonce: "n1", clientName: "nwj-PC", clientIp: "192.168.1.30", ageSecs: 3 },
      ],
    });
    await useSyncStore.getState().refreshPairing();
    const p = useSyncStore.getState().pairing;
    expect(p?.lanIp).toBe("http://192.168.1.23:4180");
    expect(p?.pendingPairs).toHaveLength(1);
    expect(p?.pendingPairs?.[0].clientName).toBe("nwj-PC");
  });
});
