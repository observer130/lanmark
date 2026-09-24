# AGENTS.md — Lanmark

局域网优先的 Markdown 笔记：**手机 = 同步中心节点**（App 内嵌 axum 服务器），**桌面 = 客户端**（Win/Linux）。
Tauri 2 + React 19 + TS + Tailwind v4 + Zustand，一套 Rust core 跑三端。

> 本文只记**不随实现漂移的稳定约定与操作手册**。具体行为一律**以代码为准**：`docs/` 是各里程碑的设计与验收记录，会滞后于代码；两者冲突时信代码，并顺手更正文档。

## 布局

| 位置 | 内容 |
|---|---|
| `src/components` | 界面：`App.tsx` 装配 · `Sidebar`（搜索/收藏/最近/树 + 底部同步条）· `TreeView` · `EditorPane` · `SyncSection` · `VaultPicker`（首启选库）· `CreateDialog` · `WindowControls`（Linux 无边框窗控） |
| `src/stores` | Zustand：`vault.ts`（目录树/编辑/防抖保存/搜索）、`sync.ts`（配对/探测/自动循环）、`bridge.ts`（Rust 事件日志）；每个 store 旁有同名 `*.test.ts` |
| `src/lib` | 纯逻辑 + 前端测试：`vault.ts`（IPC 封装）、`vault-url.ts`（`vault://` ↔ 相对引用换算）、`frontmatter.ts`、`wikilink.ts`、`image.ts`、`sync.ts` |
| `src/milkdown/roundtrip.test.ts` | 编辑器往返保真护栏（M1 决策门） |
| `src/index.css` | 设计 token（`:root` + `@theme`，「晨窗」浅色）与**全部 Crepe / CodeMirror 主题覆盖**；改编辑器外观先来这里 |
| `src-tauri/src` | Rust core：`commands.rs`（IPC 入口，`xxx` 是 3 行封装、`xxx_op` 是可测纯逻辑）· `fs_ops`（文件/回收站/目录颜色）· `db`（SQLite 索引 + FTS5）· `vault`（`AppConfig` 持久化）· `protocol`（`vault://`）· `sync_server`/`sync_client`/`sync` · `mobile`（SAF 选库 + 授权）· `sanitize`（文件名规则） |
| `src-tauri/gen/android` | **手工维护的 Android 工程**（`SyncService.kt` 前台服务、`MainActivity.kt`、`app/build.gradle.kts` 钉 `buildToolsVersion 34.0.0`），已入库，见硬约定 2 |
| `patches/` | vendor 的依赖补丁（tauri-runtime-wry，tauri#15671），见硬约定 9 |
| `.cache/` | 全部工具链与缓存（已 gitignore）：cargo/rustup、pnpm、JDK 21、Android SDK/NDK、gradle、QA 截图 |
| `design/` | 本地设计稿（gitignore，不入库） |

## 命令

```bash
pnpm dev / build / test          # vite 开发 / 前端构建 / 前端测试（vitest）
cd src-tauri && cargo check && cargo test   # Rust 检查与测试
scripts/android-check.sh         # Android 交叉编译门禁（不跑 gradle）
```

Android 相关的非显然几条：

- **任何 Android 构建前先 `source scripts/env.sh`**：JDK 21（本机 26 与 Gradle 8.14 不兼容）、ANDROID_HOME/NDK_HOME、`ANDROID_USER_HOME`（AGP 写 `~/.android` 会崩）、Java 强制 IPv4（直连 dl.google.com 会被重置）都在里面，缺了必挂
- 打可装机 APK（debug 签名，与已装应用一致，可 `adb install -r` 覆盖）：
  `source scripts/env.sh && pnpm tauri android build --apk --debug --target aarch64`
  产物 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- 端到端自测：`scripts/make-demo-vault.sh` 生成 `~/lanmark-demo-vault`（中文/图片/frontmatter + 验收清单），首启页「打开现有笔记库」指向它
- 桌面 release 用 `scripts/lanmark-desktop.sh`（原生二进制；本机 AppImage 有 Intel Arc 兼容性问题）

## 发版（v0.1 起）

- **只发三件产物**：Linux `lanmark-linux-x64.tar.gz`（原生二进制）/ Windows `*-setup.exe`（NSIS）/ Android `*-aarch64.apk`；deb/AppImage/msi 不进 release。`.github/workflows/release.yml` 里 Linux 用 `--no-bundle`、Windows 用 `--bundles nsis` 对应这个约定
- 流程：改三处版本号（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`）→ 提交推送 → **先** `gh release create vX.Y.Z --title … --notes-file …` 建 release 说明 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` 自动三端构建并附产物
- 坑：仓库默认 GITHUB_TOKEN 只读，`release.yml` 的 `permissions: contents: write` 不能删（缺了上传 403）
- **Android release 资产当前是 debug 签名构建**：`release.yml` 的 android job 用 `--debug` 构建后仅重命名为 release 资产名，行为与本地 debug APK 一致（CDP 可用、debuggable）——M3 验收走查确认设计使然（2026-09-23），非 CI 误配：`scripts/cdp-eval.mjs` 走查发现「release 包」行为像 debug 时勿误判。M4 将切固定 release keystore（docs/08 §12.1），切换后同步更新本条（届时 release 资产不再带 CDP）

## 硬约定

1. **工具链与缓存一律进仓库 `.cache/`**（cargo/rustup/pnpm/JDK/SDK/gradle），不污染 `$HOME`；新增缓存照此办（`scripts/env.sh` 已处理，别绕过；`.gitignore` 已忽略 `.cache/`）。
2. **`gen/android` 是手工改的，删目录重 init 会丢工作**：`tauri android build/dev` 对已存在文件只读不写（手改安全），但删掉重 init 会冲掉 SyncService/SAF 代码。
3. **往返保真是硬门槛**：打开笔记不得重写文件（Crepe 建实例会发一次伪 `markdownUpdated`，`EditorPane.tsx` 里 `MilkdownHost` 的 `lastKnownDoc` 基线专门压它）；frontmatter 与 wikilink 不进编辑器、保存时回填还原；图片显示走 `vault://`、落盘还原相对引用。动 `src/components/EditorPane.tsx`、`src/lib/vault-url.ts`、`src/lib/frontmatter.ts`、`src/lib/wikilink.ts` 前先看这些文件内的注释；护栏是 `pnpm test` 里的 roundtrip 与往返用例。
4. **vault 文件是唯一事实源**；`src-tauri/src/db.rs` 的 SQLite 只是可重建索引（含正文搜索缓存）。任何「数据」改动先问文件侧怎么表达。
5. **同步方向固定**：手机 = axum 服务器（`0.0.0.0:4180`，被占则 +1，见 `sync_server.rs` 的 `DEFAULT_PORT` / `spawn`），桌面 = 客户端；JSON over HTTP，文件级 sha256 版本对比；冲突按 **mtime LWW 裁决**（较新者留原路径、较旧者存为可见冲突副本），删除走 tombstone 传播——规则实现在 `sync.rs` / `sync_client.rs` / `sync_server.rs`。
6. **窄屏断点是双源**：JS `useIsNarrow`（`innerWidth < 768`，`src/App.tsx`）与 CSS `@media (max-width: 767.98px)`（`src/index.css`），必须同步改。
7. **Crepe 主题覆盖靠 specificity**：引入的是 `frame-dark.css`（仅变量块）+ common 规则，浅色「晨窗」全靠 `index.css` 更高优先级规则盖（如 `.editor-host .milkdown`）。新增覆盖要核对优先级；注释里标了已知漏覆盖点。
8. **提交信息一律 `类型(可选范围): 中文简述`**（如 `fix(sync): 删除传播补 tombstone 时序`、`feat: M3b tombstone 删除传播`）；类型只用 feat/fix/perf/refactor/style/test/docs/build/ci/chore/revert，半角冒号 + 一个空格，简述不加句号。
   **自测账**：收尾必跑 `pnpm test` 与 `cd src-tauri && cargo test`，提交里带**本次实际跑出的**成绩（当前基线：前端 87/87 + Rust 92/92；勿照抄历史数字）；里程碑收尾与移动端改动另附真机走查结论（机型 + Android 版本）。
9. **构建路径上的东西必须入库，`.cache/` 只放可再生的缓存**：`patches/tauri-runtime-wry`（tauri#15671，仅 lib.rs 7 行差异，`[patch.crates-io]` 指向它）曾放 `.cache/` 导致 CI 三端全挂。升级该依赖时重拷 registry 原件 + 重放补丁，步骤见 `patches/README.md`。

## 真机调试（手机 = 主验证场）

debug APK 的 WebView 开 CDP（release 不行），比盲摸坐标准：

```bash
source scripts/env.sh   # adb 进 PATH（.cache/android-sdk/platform-tools）
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.lanmark.app | tr -d '\r')
curl -s localhost:9222/json   # 拿 webSocketDebuggerUrl
node scripts/cdp-eval.mjs "document.querySelector('.ProseMirror')?.clientWidth"   # 页面内执行 JS
```

`scripts/cdp-eval.mjs` 支持 `Runtime.evaluate` 读计算样式、查布局指标、触发 React 点击（`…click()`）——改完 UI 先用它核数值，再 `adb exec-out screencap -p` 截屏存档（放 `.cache/screenshots/`）。

- 手机屏幕会休眠：黑截图 → `adb shell input keyevent KEYCODE_WAKEUP && adb shell wm dismiss-keyguard`；长构建期间屏幕必睡，装完重唤醒再截。
- 应用重启后 pid 变，`adb forward` 要重做（或先 `adb forward --remove-all`）。
