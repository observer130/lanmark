# AGENTS.md — Lanmark

局域网优先的 Markdown 笔记：**手机 = 同步中心节点**（App 内嵌 axum 服务器），**桌面 = 客户端**（Win/Linux）。
Tauri 2 + React 19 + TS + Tailwind v4 + Zustand，一套 Rust core 跑三端。

## 布局

| 位置 | 内容 |
|---|---|
| `src/components` · `src/stores` · `src/lib` | 界面（Sidebar/TreeView/EditorPane/SyncSection）· Zustand 状态（vault/sync，各有 store 测试）· 纯逻辑 + 前端测试（vault-url 图片引用换算/frontmatter/wikilink） |
| `src/index.css` | 设计 token（`:root` + `@theme`，「晨窗」浅色）与**全部 Crepe 主题覆盖**，改编辑器外观先来这里 |
| `src-tauri/src` | Rust core：`commands.rs`（IPC 入口，`xxx` 是 3 行封装、`xxx_op` 是可测纯逻辑）· `fs_ops`/`db`/`vault` · `protocol`（`vault://` 图片协议）· `sync_server`/`sync_client`/`sync`/`protocol` · `mobile`（SAF 选库 + 文件授权）· `sanitize`（文件名规则） |
| `src-tauri/gen/android` | **手工维护的 Android 工程**（SyncService.kt 前台服务、MainActivity.kt SAF、build.gradle.kts 钉 build-tools 34），已入库，见硬约定 2 |
| `patches/` | vendor 的依赖补丁（tauri-runtime-wry，tauri#15671），见硬约定 9 |
| `docs/` | 设计与验收记录，指针见文末 |
| `design/` | 本地设计稿（gitignore，不入库）；`direction-approved.md` 是用户选定视觉基线 |

## 命令

桌面开发/构建/测试见 README「快速开始」。非显然的几条：

- **Android 任何构建前先 `source scripts/env.sh`** —— JDK 21（本机 26 与 Gradle 8.14 不兼容）、ANDROID_HOME/NDK_HOME、`ANDROID_USER_HOME`（AGP 写 `~/.android` 会崩）、Java 强制 IPv4（直连 dl.google.com 会被重置）都在里面，缺了必挂
- Rust 侧 Android 门禁（不跑 gradle，只验交叉编译）：`scripts/android-check.sh`
- 打可装机 APK（debug 签名，与已装应用一致，可 `adb install -r` 覆盖）：
  `source scripts/env.sh && pnpm tauri android build --apk --debug --target aarch64`
  产物 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- 端到端自测：`scripts/make-demo-vault.sh` 生成 `~/lanmark-demo-vault`（中文/图片/frontmatter + 验收清单），首启页「打开现有笔记库」指向它
- 桌面 release 用 `scripts/lanmark-desktop.sh`（原生二进制；AppImage 有 Intel Arc 兼容性问题）

## 发版（v0.1 起）

- **只发三件产物**：Linux `lanmark-linux-x64.tar.gz`（原生二进制）/ Windows `*-setup.exe`（NSIS）/ Android `*-aarch64.apk`。deb/AppImage/msi 不进 release（2026-09-18 用户定，避免多余产物），`release.yml` 里 Linux 用 `--no-bundle`、Windows 用 `--bundles nsis` 对应这个约定
- 流程：改三处版本号（`package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json`）→ 提交推送 → **先** `gh release create vX.Y.Z --title … --notes-file …` 建 release 说明 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` 自动三端构建并附产物
- 坑：仓库默认 GITHUB_TOKEN 只读，`release.yml` 的 `permissions: contents: write` 不能删（缺了上传 403）

## 硬约定

1. **工具链与缓存一律进仓库 `.cache/`**（pnpm store/cargo/JDK/SDK/gradle），不污染 `$HOME`；新增缓存照此办（env.sh 已处理，别绕过）。
2. **`gen/android` 是手工改的，删目录重 init 会丢工作**：`tauri android build/dev` 对已存在文件只读不写（手改安全），但删掉重 init 会冲掉 SyncService/SAF 代码。
3. **往返保真是硬门槛**：打开笔记不得重写文件（Crepe 建实例会发一次伪 `markdownUpdated`，`MilkdownHost` 的 `lastKnownDoc` 基线专门压它）；frontmatter 与 wikilink 不进编辑器、保存时回填还原；图片显示走 `vault://`、落盘还原相对引用。动 `EditorPane.tsx`/`src/milkdown`/`lib/vault-url`（图片引用换算）前先读 `docs/04` §8–§9c，`pnpm test` 的 roundtrip/往返用例就是护栏。
4. **vault 文件是唯一事实源**；`db.rs` 的 SQLite 只是可重建索引（含正文搜索缓存）。任何「数据」改动先问文件侧怎么表达。
5. **同步方向固定**：手机 = axum 服务器（`0.0.0.0:4180`，被占则 +1），桌面 = 客户端；JSON over HTTP，文件级 sha256 版本对比，冲突保留双份（`docs/05` §3）。
6. **窄屏断点是双源**：JS `useIsNarrow`（`innerWidth < 768`，`App.tsx`）与 CSS `@media (max-width: 767.98px)`（`index.css`），必须同步改。
7. **Crepe 主题覆盖靠 specificity**：引入的是 `frame-dark.css`（仅变量块）+ common 规则，浅色「晨窗」全靠 `index.css` 更高优先级规则盖（如 `.editor-host .milkdown`）。新增覆盖要核对优先级；注释里标了已知漏覆盖点。
8. **提交信息用中文**，里程碑前缀（`M2 …`）或类型前缀（`fix:`/`chore:`）；里程碑收尾提交带测试账（如「Rust 55/55 + 前端 37/37」）与真机结论。改动收尾自测账：`pnpm test` + `cd src-tauri && cargo test`，移动端改动加真机走查。
9. **构建路径上的东西必须入库，`.cache/` 只放可再生的缓存**：`patches/tauri-runtime-wry`（tauri#15671，仅 lib.rs 7 行差异，`[patch.crates-io]` 指向它）曾放 `.cache/` 导致 CI 三端全挂（2026-09-18）。升级该依赖时重拷 registry 原件 + 重放补丁，验证见 `patches/README.md`。

## 真机调试（手机 = 主验证场）

debug APK 的 WebView 开 CDP（release 不行），比盲摸坐标准：

```bash
source scripts/env.sh   # adb 进 PATH（.cache/android-sdk/platform-tools）
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.lanmark.app | tr -d '\r')
curl -s localhost:9222/json   # 拿 webSocketDebuggerUrl
node scripts/cdp-eval.mjs "document.querySelector('.ProseMirror')?.clientWidth"   # 页面内执行 JS
```

`cdp-eval.mjs` 支持 `Runtime.evaluate` 读计算样式、查布局指标、触发 React 点击（`…click()`）——改完 UI 先用它核数值，再 `adb exec-out screencap -p` 截屏存档（放 `.cache/screenshots/`）。

- 手机屏幕会休眠：黑截图 → `adb shell input keyevent KEYCODE_WAKEUP && adb shell wm dismiss-keyguard`；长构建期间屏幕必睡，装完重唤醒再截。
- 应用重启后 pid 变，`adb forward` 要重做（或先 `adb forward --remove-all`）。

## 文档指针

| 要做什么 | 读哪个 |
|---|---|
| 动 vault 结构 / 编辑器 / 文件名 / 搜索 | `docs/04`（§2 文件名规则、§4 布局、§8–§9c 往返保真与事故记录） |
| 动同步 / 协议 / Android 配置 | `docs/05`（§3 协议、§5 Android 专项、§8g/8h 验收清单与真机结论；vault 目录调研在 `docs/research/`） |
| 同步服务器被杀 / 熄屏掉线 | `docs/06`（前台服务/wakelock/Doze 保活调研，结论附来源） |
| 动自动同步 / 删除传播 / 冲突裁决 | `docs/07`（§3 协议 v1.1、§4 LWW 裁决规则、§5 回合 v2 + 服务器仲裁、§7 自动循环、§10 验收） |
| 构建失败 / 新机器搭环境 | `docs/03`（环境总览、SDK 手工组装记录） |
| 质疑选型 / 动协议大方向 | `docs/02`（选型论证 + 已确认决策，改动前先对账） |
| 质疑需求边界 | `docs/01`（已确认需求与风险清单） |
| 视觉 / 交互改版 | `design/direction-approved.md`（用户选定基线「晨窗」，本地文件） |
