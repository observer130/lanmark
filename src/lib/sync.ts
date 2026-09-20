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

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  token: string;
  /** 最近一次回合成功时间（unix ms；M3e 状态 UI） */
  lastSuccessAt: number | null;
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

  /** 桌面端 */
  discover: () => invoke<Discovered[]>("sync_discover"),
  pair: (url: string, code: string) =>
    invoke<ServerProfile>("sync_pair", { url, code }),
  servers: () => invoke<ServerProfile[]>("sync_servers"),
  serverRemove: (id: string) => invoke<void>("sync_server_remove", { id }),
  /** M3 P2：探测失败后 mDNS browse 到同名服务器 → 更新 url 重连 */
  serverSetUrl: (id: string, url: string) =>
    invoke<ServerProfile>("sync_server_set_url", { id, url }),
  /** M3 自动同步循环：轻量在线探测 */
  probe: (id: string) => invoke<ProbeResult>("sync_probe", { id }),
  syncNow: (id: string) => invoke<SyncReport>("sync_now", { id }),
};

/** Android 专项：vault 目录选择 + 全部文件访问授权（mobile.rs 插件） */
export const vaultPicker = {
  hasAllFilesAccess: () => invoke<boolean>("vault_picker_has_all_files_access"),
  requestAllFilesAccess: () =>
    invoke<void>("vault_picker_request_all_files_access"),
  pickFolder: () => invoke<string | null>("vault_picker_pick_folder"),
};

/** 平台判断：Android WebView UA 必含 Android；桌面端（Win/Linux/macOS）不含 */
export function isAndroid(): boolean {
  return navigator.userAgent.includes("Android");
}
