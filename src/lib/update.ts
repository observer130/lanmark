import { invoke } from "@tauri-apps/api/core";

/**
 * M5-4 更新检测：GitHub release 版本比较的 IPC 封装。
 *
 * 节流（≥24h 一次）在 Rust 侧（AppConfig.last_update_check_ms）；本层无状态。
 * 检测到新版本后的安装（Windows updater / Linux 自更新 / Android 跳发布页）
 * 属 M5-5/5-6；本模块只回答「有没有新版本、发布页在哪」。
 */

export interface UpdateInfo {
  currentVersion: string;
  /** None = 本次没查到新信息（被节流跳过） */
  latestVersion: string | null;
  hasUpdate: boolean;
  /** release notes 摘要（Rust 侧截断到 600 字） */
  notes: string | null;
  htmlUrl: string | null;
  /** 本次（或节流窗口内上次）检查的 unix ms，0 = 从未 */
  checkedAtMs: number;
  /** true = 距上次检查不足 24h，未实际发起请求 */
  skipped: boolean;
}

export const update = {
  /** force=false：启动自动检查（节流）；force=true：手动「检查更新」 */
  check: (force: boolean) => invoke<UpdateInfo>("update_check", { force }),
  /** M5-6 Linux 自更新：下载验签替换二进制后自动重启（仅 Linux 注册此命令）。
   *  tag 来自 UpdateInfo.htmlUrl 的 releases/tag/<tag> 段。 */
  installLinux: (tag: string) => invoke<void>("update_install_linux", { tag }),
};
