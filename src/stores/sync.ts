import { create } from "zustand";
import { vault } from "../lib/vault";
import {
  sync,
  vaultPicker,
  isAndroid,
  type Discovered,
  type ProbeResult,
  type ServerProfile,
  type SyncPairingInfo,
  type SyncReport,
} from "../lib/sync";
import { useVaultStore } from "./vault";

/**
 * M2 同步状态 + M3 自动同步循环（docs/07 §7，TS 驱动；手机是服务器，无循环）。
 * 触发器：A 周期探测（在线 60s）/ B 离线退避（1s→60s，恢复跳变立即回合）/
 * C 保存完成 5s 尾沿 / D 回前台立即探测 / E 手动「立即同步」（恒可用）。
 * 所有触发走同一入口 runRound：尊重 syncing 串行锁 + 同步前 flush 脏编辑。
 */

/** per-server 探测状态机（docs/07 §7） */
export interface ServerProbeState {
  /** null = 尚未探测过 */
  online: boolean | null;
  failCount: number;
  lastProbeAt: number;
  lastRoundAt: number;
  /** 本轮退避周期内是否已做过 mDNS 重发现（P2，best effort） */
  mdnsRetried: boolean;
}

function defaultProbeState(): ServerProbeState {
  return { online: null, failCount: 0, lastProbeAt: 0, lastRoundAt: 0, mdnsRetried: false };
}

const TICK_MS = 1_000;
const PROBE_ONLINE_MS = 60_000; // 触发 A：在线时 60s 至多 1 探测/回合
const ROUND_MIN_INTERVAL_MS = 60_000; // 触发 A：距上回合 ≥60s 才自动回合
const SAVE_TRAIL_MS = 5_000; // 触发 C：保存后 5s 无新保存（尾沿纪律）
const MDNS_RETRY_FAILS = 3; // P2：连续失败 3 次 browse 一次

let tickTimer: number | null = null;
let ticking = false;
let savePendingAt: number | null = null;
let savedHandler: (() => void) | null = null;
let visHandler: (() => void) | null = null;
let focusHandler: (() => void) | null = null;

/** 触发 B 离线退避：1s → 2s → 4s → … → 60s 封顶（导出供单测） */
export function backoffMs(failCount: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failCount - 1), 60_000);
}

function setProbeState(id: string, st: ServerProbeState) {
  useSyncStore.setState((prev) => ({ probeStates: { ...prev.probeStates, [id]: st } }));
}

/** 触发 D：回前台 → 全部服务器立即重新探测（下一个 tick ≤1s 内执行） */
function forceProbeAll() {
  useSyncStore.setState((prev) => {
    const next: Record<string, ServerProbeState> = {};
    for (const [id, st] of Object.entries(prev.probeStates)) {
      next[id] = { ...st, lastProbeAt: 0 };
    }
    return { probeStates: next };
  });
}

/** 自动循环 tick：探测状态机 + 保存尾沿触发。重入保护（探测含网络 IO）。 */
async function autoTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    let st = useSyncStore.getState();
    if (st.syncAuto !== true || st.servers.length === 0) return;
    if (useVaultStore.getState().status !== "ready") return; // vault 未打开 → 空转

    // --- 探测阶段（per-server 状态机）。
    // 回合进行中探测照常（/info 轻量，在线状态保持新鲜）；
    // 回合发起前有 !syncing 守卫 + runRound 自身串行锁，不会双发
    for (const s of st.servers) {
      const prev = st.probeStates[s.id] ?? defaultProbeState();
      const wasOffline = prev.online === false;
      const delay = prev.online === true ? PROBE_ONLINE_MS : backoffMs(prev.failCount);
      // lastProbeAt=0（从未探测 / 触发 D 与 P2 强制）→ 立即探测
      if (prev.lastProbeAt !== 0 && Date.now() - prev.lastProbeAt < delay) continue;
      let pr: ProbeResult | null = null;
      try {
        pr = await sync.probe(s.id);
      } catch {
        pr = null;
      }
      const online = !!pr?.online;
      const next: ServerProbeState = {
        online,
        failCount: online ? 0 : prev.failCount + 1,
        lastProbeAt: Date.now(),
        lastRoundAt: prev.lastRoundAt,
        mdnsRetried: online ? false : prev.mdnsRetried,
      };
      setProbeState(s.id, next);
      if (online) {
        // B：离线→在线跳变立即回合；A：在线且距上回合 ≥60s
        const due =
          wasOffline || Date.now() - next.lastRoundAt >= ROUND_MIN_INTERVAL_MS;
        if (due && !useSyncStore.getState().syncing) {
          const ok = await useSyncStore.getState().runRound(s.id, { silent: true });
          if (ok) setProbeState(s.id, { ...next, lastRoundAt: Date.now() });
        }
      } else if (next.failCount === MDNS_RETRY_FAILS && !next.mdnsRetried) {
        // P2：mDNS 重发现（本环境桌面多播常不可达，best effort，失败继续退避）
        setProbeState(s.id, { ...next, mdnsRetried: true });
        try {
          const found = await sync.discover();
          const match = found.find((d) => d.name === s.name && d.url !== s.url);
          if (match) {
            await sync.serverSetUrl(s.id, match.url);
            await useSyncStore.getState().refreshServers();
            setProbeState(s.id, defaultProbeState()); // 立即重新探测新 url
          }
        } catch {
          /* best effort */
        }
      }
      st = useSyncStore.getState();
    }

    // --- 保存触发（C）：5s 尾沿，对每个在线（或未知）服务器回合 ---
    if (savePendingAt !== null && Date.now() >= savePendingAt + SAVE_TRAIL_MS) {
      savePendingAt = null;
      st = useSyncStore.getState();
      if (!st.syncing) {
        for (const s of st.servers) {
          if (st.probeStates[s.id]?.online === false) continue; // 离线 → 等探测恢复
          const ok = await st.runRound(s.id, { silent: true });
          if (ok) {
            const cur = useSyncStore.getState().probeStates[s.id] ?? defaultProbeState();
            setProbeState(s.id, { ...cur, lastRoundAt: Date.now() });
          }
        }
      }
    }
  } finally {
    ticking = false;
  }
}

interface SyncStore {
  /** 手机端配对信息 */
  pairing: SyncPairingInfo | null;
  /** 桌面端已配对服务器 */
  servers: ServerProfile[];
  /** mDNS 发现中 / 结果 */
  discovering: boolean;
  discovered: Discovered[];
  /** 同步进行中 */
  syncing: boolean;
  /** 最近一次同步报告 */
  lastReport: SyncReport | null;
  error: string | null;

  /** M3：自动同步开关（null = 尚未从配置加载） */
  syncAuto: boolean | null;
  /** M3：per-server 探测状态机（UI 展示在线状态用） */
  probeStates: Record<string, ServerProbeState>;

  refreshPairing: () => Promise<void>;
  refreshServers: () => Promise<void>;
  discover: () => Promise<void>;
  pair: (url: string, code: string) => Promise<boolean>;
  removeServer: (id: string) => Promise<void>;
  syncNow: (id: string) => Promise<void>;
  clearError: () => void;

  /** M3 */
  loadSyncAuto: () => Promise<void>;
  setSyncAuto: (v: boolean) => Promise<void>;
  startAutoLoop: () => void;
  stopAutoLoop: () => void;
  /** 单回合执行（手动/自动共用入口）：flush 脏编辑 → 回合 → 刷新。返回是否成功 */
  runRound: (id: string, opts?: { silent?: boolean }) => Promise<boolean>;

  /** Android 专项 */
  hasAllFilesAccess: boolean;
  checkAllFilesAccess: () => Promise<boolean>;
  requestAllFilesAccess: () => Promise<void>;
  pickFolder: () => Promise<string | null>;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  pairing: null,
  servers: [],
  discovering: false,
  discovered: [],
  syncing: false,
  lastReport: null,
  error: null,
  syncAuto: null,
  probeStates: {},

  refreshPairing: async () => {
    try {
      set({ pairing: await sync.pairingInfo() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  refreshServers: async () => {
    try {
      set({ servers: await sync.servers() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  discover: async () => {
    set({ discovering: true });
    try {
      const found = await sync.discover();
      set({ discovered: found });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ discovering: false });
    }
  },

  pair: async (url, code) => {
    try {
      await sync.pair(url, code);
      await get().refreshServers();
      set({ lastReport: null });
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  removeServer: async (id) => {
    try {
      await sync.serverRemove(id);
      await get().refreshServers();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  /** 单回合执行（手动/自动共用入口，docs/07 §7：所有触发走同一入口）。
   * silent = 自动触发：Rust 串行锁的「进行中」拒绝与 flush 失败不弹错误 */
  runRound: async (id, opts) => {
    if (get().syncing) return false;
    set({ syncing: true, error: null });
    try {
      const vs = useVaultStore.getState();
      // 同步前先落盘未保存编辑：否则拉取覆盖磁盘后，用户下一次自动保存
      // 会用「旧内容+改动」覆盖刚拉下来的版本（跨设备 last-write-wins 丢数据）
      if (vs.dirty && vs.activePath) {
        if (!(await vs.saveNow())) {
          if (!opts?.silent) {
            set({ error: "保存未完成的修改失败，已中止同步以免覆盖它" });
          }
          return false;
        }
      }
      const report = await sync.syncNow(id);
      set({ lastReport: report });
      // 同步后刷新树/元数据（拉取的新文件无需手动「重新扫描」），
      // 并重载当前笔记（磁盘可能已被拉取更新）
      await vs.refreshTree();
      await vs.refreshMeta();
      const s = useVaultStore.getState();
      const active = s.activePath;
      if (active && !s.dirty) {
        // dirty（同步期间开始输入）时不重载，避免吞掉正在进行的编辑；
        // 该残余窗口以「同步前已 flush」为主防线
        try {
          const { content } = await vault.readNote(active);
          if (content !== s.content) {
            useVaultStore.setState({ content, dirty: false, savedAt: Date.now() });
          }
        } catch {
          // 文件被对端删除等：保留当前状态
        }
      }
      // lastSuccessAt 由 Rust 侧记录进 profile JSON → 刷新列表（M3e 展示）
      void get().refreshServers();
      return true;
    } catch (e) {
      const msg = String(e);
      const busy = msg.includes("进行中");
      if (!opts?.silent || !busy) set({ error: msg });
      return false;
    } finally {
      set({ syncing: false });
    }
  },

  syncNow: async (id) => {
    await get().runRound(id);
  },

  clearError: () => set({ error: null }),

  loadSyncAuto: async () => {
    try {
      const st = await vault.status();
      set({ syncAuto: st.syncAuto });
    } catch {
      /* 保持 null：UI 按默认开渲染 */
    }
  },

  setSyncAuto: async (v) => {
    set({ syncAuto: v }); // 乐观更新，失败回滚由错误提示兜底
    try {
      await vault.setSyncAuto(v);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startAutoLoop: () => {
    if (tickTimer !== null) return; // 幂等
    savedHandler = () => {
      savePendingAt = Date.now(); // 每次保存重置尾沿
    };
    visHandler = () => {
      if (document.visibilityState === "visible") forceProbeAll();
    };
    focusHandler = () => forceProbeAll();
    window.addEventListener("lanmark:vault-saved", savedHandler);
    document.addEventListener("visibilitychange", visHandler);
    window.addEventListener("focus", focusHandler);
    tickTimer = window.setInterval(() => {
      void autoTick();
    }, TICK_MS);
  },

  stopAutoLoop: () => {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (savedHandler) window.removeEventListener("lanmark:vault-saved", savedHandler);
    if (visHandler) document.removeEventListener("visibilitychange", visHandler);
    if (focusHandler) window.removeEventListener("focus", focusHandler);
    savedHandler = visHandler = focusHandler = null;
    savePendingAt = null;
  },

  hasAllFilesAccess: false,

  checkAllFilesAccess: async () => {
    if (!isAndroid()) return true;
    try {
      const ok = await vaultPicker.hasAllFilesAccess();
      set({ hasAllFilesAccess: ok });
      return ok;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  requestAllFilesAccess: async () => {
    try {
      await vaultPicker.requestAllFilesAccess();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  pickFolder: async () => {
    try {
      return await vaultPicker.pickFolder();
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },
}));
