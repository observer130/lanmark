#!/usr/bin/env node
/**
 * 跨平台 `pnpm tauri:dev` 分发器。
 *
 * 为什么需要它：`tauri:dev` 是所有人（含 Linux/macOS）最顺手的入口名，但它一度
 * 直接写死 `pwsh -NoProfile -File scripts/dev.ps1` —— 非 Windows 上必然
 * `pwsh: 未找到命令`，桌面 dev 就此被堵死。这里按平台分发，两个平台都走各自
 * 既有的环境激活路径，脚本名统一。
 *
 *   Windows      → pwsh -NoProfile -File scripts/dev.ps1
 *                  （激活 .cache 工具链 + 把 WebView2 profile 指到 .cache，见该脚本注释）
 *   Linux/macOS  → bash -c 'source scripts/env.sh && exec pnpm tauri dev' "$@"
 *                  （与文档的手工两步等价：source env.sh 后 pnpm tauri dev）
 *
 * 额外参数原样透传：`pnpm tauri:dev -- --no-watch` → `tauri dev --no-watch`。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// pnpm 转发参数时可能带一个裸 `--`（`pnpm run x -- --flag`），它不是 tauri 的参数
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === "--"));

/** 前台运行并原样继承退出码（dev server 常驻，stdio 直通终端）。 */
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
  if (r.error) {
    console.error(`[tauri:dev] 无法执行 ${cmd}：${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

if (process.platform === "win32") {
  console.error("[tauri:dev] Windows → scripts/dev.ps1（.cache 工具链 + WebView2 profile）");
  run("pwsh", ["-NoProfile", "-File", path.join(here, "dev.ps1"), ...args]);
} else {
  console.error(`[tauri:dev] ${process.platform} → source scripts/env.sh + pnpm tauri dev`);
  // 用 `$0` 传仓库根、`$@` 传参数：避免把可能含空格/引号的路径拼进脚本字符串
  run("bash", ["-c", 'source scripts/env.sh && exec pnpm tauri dev "$@"', root, ...args]);
}
