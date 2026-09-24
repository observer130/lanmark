import { invoke } from "@tauri-apps/api/core";

/** 与 sync.rs / sync_client.rs 的 serde camelCase 类型对应 */

export interface FileMeta {
  path: string;
  kind: "note" | "asset";
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface Discovered {
  name: string;
  url: string;
}

/** M4h-1：LAN 扫描命中的设备（比 mDNS 的 Discovered 多带身份与规模） */
export interface ScannedDevice {
  name: string;
  url: string;
  /** M4h-3 设备身份；旧服务器为空串（回退名称匹配） */
  deviceId: string;
  notes: number;
}

/** M4h-1 扫描结果 */
export interface ScanResult {
  devices: ScannedDevice[];
  /** 因预算截断，可能不全 */
  truncated: boolean;
  /** 是否做了网段全扫（设置里关掉「局域网扫描」时为 false） */
  scannedSubnet: boolean;
}

/** M4h-2：桌面一次配对尝试的结局（四态） */
export interface PairAttempt {
  status: "approved" | "rejected" | "timeout" | "error";
  profile: ServerProfile | null;
  reason: string | null;
}

/** M4h-2：手机端待授权请求 */
export interface PendingPair {
  nonce: string;
  clientName: string;
  clientIp: string;
  ageSecs: number;
}

export interface ServerProfile {
  /** M4h-3：等于 `deviceId`（IP 变了也不变 → 基线不丢） */
  id: string;
  name: string;
  url: string;
  token: string;
  /** 最近一次回合成功时间（unix ms；M3e 状态 UI） */
  lastSuccessAt: number | null;
  /** M4h-3：设备身份（旧服务器为空串） */
  deviceId?: string;
  /** M4h-3：上次已知端口 */
  port?: number | null;
}

/** 轻量探测结果（M3 自动同步循环；GET /info，3s 超时） */
export interface ProbeResult {
  online: boolean;
  name: string;
  notes: number;
  assets: number;
}

export interface SyncPairingInfo {
  running: boolean;
  port: number | null;
  deviceName: string;
  pairingCode: string;
  /** 最近一次客户端回合时间（unix ms；服务器重启后为 null） */
  lastRoundAt: number | null;
  /** D10：本机局域网地址（解开「要诊断得先知道 IP，可我不知道 IP」的死循环） */
  lanIp?: string | null;
  /** M4h-3：设备身份 */
  deviceId?: string;
  /** M4h-2：待授权配对请求（非空时手机面板显示允许/拒绝卡片） */
  pendingPairs?: PendingPair[];
}

/** 一次 LWW 自动合并：较新版留原路径，较旧版降级为可见冲突副本（M3c，docs/07 §3/§6） */
export interface MergeEvent {
  path: string;
  /** "local" | "server" */
  winner: string;
  /** 输家副本落成的原路径（进目录树，可点击打开） */
  loserCopy: string;
  winnerMtimeMs: number;
  /** 0 = 未知 */
  loserMtimeMs: number;
}

export interface SyncReport {
  pulled: string[];
  pushed: string[];
  merges: MergeEvent[];
  deleted: string[];
  skipped: number;
  errors: string[];
}

/** 手机端：同步服务器配对信息（服务器随 vault 打开自动启动） */
export const sync = {
  pairingInfo: () => invoke<SyncPairingInfo>("sync_pairing_info"),
  serverStart: () => invoke<number>("sync_server_start"),
  /** vault 内冲突副本数（手机端可发现性，docs/07 §6） */
  conflictCount: () => invoke<number>("sync_conflict_count"),

  /** 桌面端 */
  discover: () => invoke<Discovered[]>("sync_discover"),
  pair: (url: string, code: string) =>
    invoke<ServerProfile>("sync_pair", { url, code }),
  servers: () => invoke<ServerProfile[]>("sync_servers"),
  serverRemove: (id: string) => invoke<void>("sync_server_remove", { id }),
  /** M3 P2：探测失败后 mDNS browse 到同名服务器 → 更新 url 重连 */
  serverSetUrl: (id: string, url: string) =>
    invoke<ServerProfile>("sync_server_set_url", { id, url }),

  /* ── M4h：发现 / 一键授权 ── */
  /** LAN 发现（mDNS → 邻居表 → 网段并发探测，命中即停）。`allowSubnet` 关掉
   *  即退化为只查已知设备（设置里的「局域网扫描」开关） */
  scanLan: (allowSubnet = true) =>
    invoke<ScanResult>("sync_scan_lan", { allowSubnet }),
  /** 一键授权：提交请求并等待手机端点「允许」（默认 90s） */
  connectDevice: (url: string, timeoutSecs = 90) =>
    invoke<PairAttempt>("sync_connect_device", { url, timeoutSecs }),
  /** 手机端：允许一次待授权请求 */
  pairApprove: (nonce: string) => invoke<void>("sync_pair_approve", { nonce }),
  /** 手机端：拒绝一次待授权请求 */
  pairReject: (nonce: string) => invoke<void>("sync_pair_reject", { nonce }),
  /** M3 自动同步循环：轻量在线探测 */
  probe: (id: string) => invoke<ProbeResult>("sync_probe", { id }),
  syncNow: (id: string) => invoke<SyncReport>("sync_now", { id }),
};

/** Android 专项：vault 目录选择 + 全部文件访问授权（mobile.rs 插件） */
export const vaultPicker = {
  hasAllFilesAccess: () => invoke<boolean>("vault_picker_has_all_files_access"),
  requestAllFilesAccess: () =>
    invoke<void>("vault_picker_request_all_files_access"),
  /** 应用私有外部目录（getExternalFilesDir，框架创建；Android/data/<pkg>
   * 系统懒创建，std::fs mkdir 包目录必被 FUSE 拒——不能前端硬编码后自建） */
  appDir: () => invoke<string | null>("vault_picker_app_dir"),
  pickFolder: () => invoke<string | null>("vault_picker_pick_folder"),
};

/** 平台判断：Android WebView UA 必含 Android；桌面端（Win/Linux/macOS）不含 */
export function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}
