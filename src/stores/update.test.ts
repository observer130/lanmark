import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M5-4 更新检测 store 测试。
 *
 * 两条路径的纪律差异是重点：
 * - autoCheck：受 settings.update.autoCheck 门控、skipped 不改状态、失败静默
 * - checkNow：force 检查、错误浮出、checking 状态机
 */

const m = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("../lib/update", () => ({ update: { check: m.check } }));

import { useUpdateStore } from "./update";
import { useSettingsStore, DEFAULT_SETTINGS } from "./settings";

function setStateAutoCheck(v: boolean) {
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, update: { autoCheck: v } },
    loading: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({ info: null, checking: false, error: null });
  setStateAutoCheck(true);
});

describe("autoCheck：启动静默检查", () => {
  it("开关关闭 → 不发起请求", async () => {
    setStateAutoCheck(false);
    await useUpdateStore.getState().autoCheck();
    expect(m.check).not.toHaveBeenCalled();
  });

  it("发现新版本 → 写入 info", async () => {
    m.check.mockResolvedValueOnce({
      currentVersion: "0.4.0",
      latestVersion: "0.5.0",
      hasUpdate: true,
      notes: "…",
      htmlUrl: "https://github.com/observer130/lanmark/releases/tag/v0.5.0",
      checkedAtMs: 1,
      skipped: false,
    });
    await useUpdateStore.getState().autoCheck();
    expect(m.check).toHaveBeenCalledWith(false);
    expect(useUpdateStore.getState().info?.hasUpdate).toBe(true);
  });

  it("skipped（24h 未到）→ 不改 UI 状态", async () => {
    m.check.mockResolvedValueOnce({
      currentVersion: "0.4.0", latestVersion: null, hasUpdate: false,
      notes: null, htmlUrl: null, checkedAtMs: 1, skipped: true,
    });
    await useUpdateStore.getState().autoCheck();
    expect(useUpdateStore.getState().info).toBeNull();
  });

  it("失败 → 完全静默（无 error 浮出）", async () => {
    m.check.mockRejectedValueOnce(new Error("请求 GitHub 失败"));
    await useUpdateStore.getState().autoCheck();
    const s = useUpdateStore.getState();
    expect(s.error).toBeNull();
    expect(s.info).toBeNull();
    expect(s.checking).toBe(false);
  });
});

describe("checkNow：手动检查（force）", () => {
  it("force=true 发起请求，成功后写 info 并复位 checking", async () => {
    m.check.mockResolvedValueOnce({
      currentVersion: "0.4.0", latestVersion: "0.4.0", hasUpdate: false,
      notes: null, htmlUrl: null, checkedAtMs: 2, skipped: false,
    });
    const p = useUpdateStore.getState().checkNow();
    expect(useUpdateStore.getState().checking).toBe(true);
    await p;
    expect(m.check).toHaveBeenCalledWith(true);
    const s = useUpdateStore.getState();
    expect(s.checking).toBe(false);
    expect(s.error).toBeNull();
    expect(s.info?.hasUpdate).toBe(false);
  });

  it("失败 → error 浮出（手动检查不打哑谜）且 checking 复位", async () => {
    m.check.mockRejectedValueOnce(new Error("GitHub 返回 403"));
    await useUpdateStore.getState().checkNow();
    const s = useUpdateStore.getState();
    expect(s.checking).toBe(false);
    expect(s.error).toContain("403");
  });

  it("开始新检查时清掉上一次的 error", async () => {
    useUpdateStore.setState({ error: "上次失败" });
    m.check.mockResolvedValueOnce({
      currentVersion: "0.4.0", latestVersion: null, hasUpdate: false,
      notes: null, htmlUrl: null, checkedAtMs: 3, skipped: false,
    });
    await useUpdateStore.getState().checkNow();
    expect(useUpdateStore.getState().error).toBeNull();
  });
});
