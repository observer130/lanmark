# AGENTS.md — Lanmark

局域网优先的 Markdown 笔记：**手机 = 同步中心节点**（App 内嵌 axum 服务器），**桌面 = 客户端**（Win/Linux）。
技术栈：Tauri 2 · React 19 · TypeScript 6（strict）· Vite 8 · Tailwind v4 · Zustand 5 · pnpm，一套 Rust core 跑三端。测试：vitest（jsdom，`src/**/*.test.ts`）+ `cargo test`。

> **本文定位**：只记**不随实现漂移的稳定约定与操作手册**，是面向 agent 的**唯一事实源**；具体行为一律**以代码为准**。
> `README.md` 面向用户（功能/下载/首次使用），开发约定不进 README。
> `docs/`、`design/` 是本地阶段稿，**已被 gitignore、不入库**：天然滞后于代码，且已与 M4 起的新决策有多处冲突（如已取消的扫码配对、已推翻的前台服务插件方案）。**读它会错**；拿不准时用代码与本文，并顺手更正本地稿。

## 命令

```bash
source scripts/env.sh            # 构建环境（Android / 交叉编译前必跑）；兼容 zsh/bash

pnpm dev                         # vite 开发
pnpm build                       # tsc + vite build（tsc 即类型门禁）
pnpm test                        # vitest run
pnpm vitest run -t "往返"         # 按用例名过滤
pnpm vitest run src/lib/vault-url.test.ts   # 只跑单个文件

cd src-tauri && cargo check      # Rust 静态检查
cd src-tauri && cargo test       # Rust 测试
cd src-tauri && cargo test --lib sync_server   # 按模块过滤

scripts/android-check.sh         # Android 交叉编译门禁（不跑 gradle）
```

**没有 lint / format 工具**：仓库无 ESLint / Biome / prettier / rustfmt / clippy 配置，`lint` 脚本不存在，别去找。静态门禁只有 `tsc`（strict + `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`）与 `cargo check`。风格沿用既有文件：TS 双引号 + 分号 + 2 空格缩进；Rust 走 rustfmt 默认。

**`/tmp` 只有 10M tmpfs（本机/沙箱），它会成为测试门禁的瓶颈**：Node 的编译缓存跑一次 `pnpm test` 就吃掉近 9M，紧接着 `cargo test` 里 `tempfile::TempDir` 建 SQLite 会成批报 `disk I/O error`（实测：先测前端再测 Rust，30 项必挂——正是硬约定 8 规定的顺序）。`scripts/env.sh` 已把 `TMPDIR` 指到 `.cache/tmp` 规避；没 source 时请按「先 `cargo test` 再 `pnpm test`」的顺序跑。之前 `env.sh` 只认 `BASH_SOURCE`，在 zsh 下会把仓库根算到上级目录、把整套缓存写到仓库外，**现已兼容 zsh**（找不到 `src-tauri` 会直接报错退出，不再静默写错位置）。

Android 相关的非显然几条：

- **任何 Android 构建前先 `source scripts/env.sh`**：JDK 21（本机 26 与 Gradle 8.14 不兼容）、ANDROID_HOME/NDK_HOME、`ANDROID_USER_HOME`（AGP 写 `~/.android` 会崩）、Java 强制 IPv4（直连 dl.google.com 会被重置）都在里面，缺了必挂
- 打可装机 APK（debug 签名，与已装应用一致，可 `adb install -r` 覆盖）：
  `source scripts/env.sh && pnpm tauri android build --apk --debug --target aarch64`
  产物 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- 端到端自测：`scripts/make-demo-vault.sh` 生成 `~/lanmark-demo-vault`（中文/图片/frontmatter + 验收清单），首启页「打开现有笔记库」指向它
- 桌面 release 用 `scripts/lanmark-desktop.sh`（原生二进制；本机 AppImage 有 Intel Arc 兼容性问题）

## 布局

| 位置 | 内容 |
|---|---|
| `src/components` | 界面：`App.tsx` 装配 · `Sidebar`（搜索/收藏/最近/树 + 底部设置行 + 同步条）· `TreeView` · `EditorPane`（往返保真关键，见硬约定 3；`editorKey` 是外观不进 key 的护栏）· `SyncSection` · `SettingsDialog`（宽屏模态 / 窄屏全屏页）· `VaultPicker`（首启选库）· `CreateDialog` · `WindowControls`（Linux 无边框窗控） |
| `src/stores` | Zustand：`vault.ts`（目录树/编辑/防抖保存/搜索/切库）、`sync.ts`（配对/LAN 扫描/探测/自动循环）、`settings.ts`（乐观更新 + CSS 变量 + 回滚）、`bridge.ts`（Rust 事件日志）；每个 store 旁有同名 `*.test.ts` |
| `src/lib` | 纯逻辑 + 前端测试：`vault.ts`（IPC 封装）、`vault-url.ts`（`vault://` ↔ 相对引用换算）、`frontmatter.ts`、`wikilink.ts`、`image.ts`、`sync.ts`、`settings.ts`（字体栈与枚举→像素映射的**唯一来源** + `applyCssVars`）、`bridge.ts` |
| `src/milkdown/roundtrip.test.ts` | 编辑器往返保真护栏（M1 决策门） |
| `src/index.css` | 设计 token（`:root` + `@theme`，「晨窗」浅色）与**全部 Crepe / CodeMirror 主题覆盖**；改编辑器外观先来这里 |
| `src-tauri/src` | Rust core：`commands.rs`（IPC 入口，`xxx` 是 3 行封装、`xxx_op` 是可测纯逻辑）· `bridge.rs`（事件通道，纯逻辑不依赖运行时）· `fs_ops`（文件/回收站/目录颜色/**vault 统计与回收站清理**）· `db`（SQLite 索引 + 全文搜索；搜索是 LIKE 而非 FTS5——中文 2 字词用 FTS5 trigram 查不到）· `vault`（`AppConfig` 持久化）· `settings`/`settings_cmd`（M4a 设备级偏好：结构 + 归一化 + 白名单，与 vault 无关）· `protocol`（`vault://`）· `sync_server`/`sync_client`/`sync` · `lan_scan`（M4h-1 LAN 并发探测发现）· `mobile`（SAF 选库 + 授权）· `sanitize`（文件名规则） |
| `src-tauri/gen/android` | **手工维护的 Android 工程**（`SyncService.kt` 前台服务、`MainActivity.kt`、`app/build.gradle.kts` 钉 `buildToolsVersion 34.0.0`），已入库，见硬约定 2 |
| `scripts/` | `env.sh`（构建环境，必 source）· `android-check.sh`（交叉编译门禁）· `cdp-eval.mjs`（真机 CDP）· `make-demo-vault.sh` · `lanmark-desktop.sh` · `gen-icon.py` · `install-desktop-entry.sh` |
| `patches/` | vendor 的依赖补丁（tauri-runtime-wry，tauri#15671），见硬约定 9 |
| `.github/workflows` | `build.yml`（改动检查）· `release.yml`（三端发版） |
| `.cache/` | 全部工具链与缓存（已 gitignore）：cargo/rustup、pnpm、JDK 21、Android SDK/NDK、gradle、QA 截图 |
| `README.md` · `design/` · `docs/` | 面向用户说明 / 本地设计稿 / 本地阶段稿——后两者 gitignore 不入库，**读它会错**（见开头「本文定位」） |

## 改动边界

**总是**

- 收尾跑 `pnpm test` 与 `cd src-tauri && cargo test`，成绩写进提交（见硬约定 8）
- 新增工具链或缓存 → 落 `.cache/` 并由 `scripts/env.sh` 导出，不污染 `$HOME`
- 改了构建流程 / 测试约定 / 目录结构 → **同一提交内**更新本文

**先问**

- 改 `src-tauri/gen/android/**` 与 `patches/**`——手工维护且是构建路径依赖，动错即 CI 三端挂
- 改往返保真链路：`src/components/EditorPane.tsx`、`src/lib/vault-url.ts`、`src/lib/frontmatter.ts`、`src/lib/wikilink.ts`
- 改同步语义：LWW 裁决、tombstone 传播、端口策略（硬约定 5）
- 改窄屏断点（硬约定 6 是 JS + CSS 双源，必须同步改）
- 加 / 升级依赖，尤其 `tauri-runtime-wry`（升级需重放 `patches/` 补丁）
- 改发版产物矩阵或 `release.yml`

**从不**

- 删掉 `src-tauri/gen/android` 重新 init（会冲掉 SyncService / SAF 代码，见硬约定 2）
- 把构建路径上的东西移进 `.cache/`（`patches/` 曾因此让 CI 三端全挂，见硬约定 9）
- 把密钥 / keystore / `.env` 写进仓库（Android release keystore 只走环境变量；与 `patches/` 公开源码的性质相反）
- 让 `db.rs` 的 SQLite 变成事实源——vault 下的文件才是（硬约定 4）
- 打开笔记时重写文件（硬约定 3）
- 手改 `src-tauri/gen/schemas`（每次构建自动再生，已 gitignore）

## 硬约定

1. **工具链与缓存一律进仓库 `.cache/`**（cargo/rustup/pnpm/JDK/SDK/gradle），不污染 `$HOME`；新增缓存照此办（`scripts/env.sh` 已处理，别绕过；`.gitignore` 已忽略 `.cache/`）。
2. **`gen/android` 是手工改的，删目录重 init 会丢工作**：`tauri android build/dev` 对已存在文件只读不写（手改安全），但删掉重 init 会冲掉 SyncService/SAF 代码。
3. **往返保真是硬门槛**：打开笔记不得重写文件（Crepe 建实例会发一次伪 `markdownUpdated`，`EditorPane.tsx` 里 `MilkdownHost` 的 `lastKnownDoc` 基线专门压它）；frontmatter 与 wikilink 不进编辑器、保存时回填还原；图片显示走 `vault://`、落盘还原相对引用。动 `src/components/EditorPane.tsx`、`src/lib/vault-url.ts`、`src/lib/frontmatter.ts`、`src/lib/wikilink.ts` 前先看这些文件内的注释；护栏是 `pnpm test` 里的 roundtrip 与往返用例。
4. **vault 文件是唯一事实源**；`src-tauri/src/db.rs` 的 SQLite 只是可重建索引（含正文搜索缓存）。任何「数据」改动先问文件侧怎么表达。
5. **同步方向固定**：手机 = axum 服务器（`0.0.0.0:4180`，被占则 +1，见 `sync_server.rs` 的 `DEFAULT_PORT` / `spawn`），桌面 = 客户端；JSON over HTTP，文件级 sha256 版本对比；冲突按 **mtime LWW 裁决**（较新者留原路径、较旧者存为可见冲突副本），删除走 tombstone 传播——规则实现在 `sync.rs` / `sync_client.rs` / `sync_server.rs`。
6. **窄屏断点是双源**：JS `useIsNarrow`（`innerWidth < 768`，`src/App.tsx`）与 CSS `@media (max-width: 767.98px)`（`src/index.css`），必须同步改。
7. **Crepe 主题覆盖靠 specificity**：引入的是 `frame-dark.css`（仅变量块）+ common 规则，浅色「晨窗」全靠 `index.css` 更高优先级规则盖（如 `.editor-host .milkdown`）。新增覆盖要核对优先级；注释里标了已知漏覆盖点。
8. **提交信息一律 `类型(可选范围): 中文简述`**（如 `fix(sync): 删除传播补 tombstone 时序`、`feat: M3b tombstone 删除传播`）；类型只用 feat/fix/perf/refactor/style/test/docs/build/ci/chore/revert，半角冒号 + 一个空格，简述不加句号。
9. **构建路径上的东西必须入库，`.cache/` 只放可再生的缓存**：`patches/tauri-runtime-wry`（tauri#15671，仅 lib.rs 7 行差异，`[patch.crates-io]` 指向它）曾放 `.cache/` 导致 CI 三端全挂。升级该依赖时重拷 registry 原件 + 重放补丁，步骤见 `patches/README.md`。
10. **设备偏好进 `AppConfig`，vault 级视图状态进 localStorage，笔记内容进文件**（M4a 定，docs/08 §4.1）：字体/字号/行距/编辑器偏好/回收站策略都存 `app_config_dir/config.json`，**换库不该改变偏好**；折叠目录等跟库走的视图状态留 localStorage；`.lanmark/settings.json` 这种放 vault 里的做法是错的（会让设置随库漂移并卷进同步清单判定）。
11. **外观设置只走 CSS 变量，绝不进编辑器 `key`**（M4b 定，docs/08 §9 R2）：改字体/字号不得重建 Crepe 实例——建实例会发伪 `markdownUpdated`，等于把打开着的笔记重写一遍（硬约定 3）。`editorKey(path, mode)` 是这条的护栏函数，`settings.test.ts` 有用例钉住；`applyCssVars`（`src/lib/settings.ts`）是唯一写入点。

## 完成标准（DoD）

- [ ] `pnpm test` 与 `cd src-tauri && cargo test` 全绿，成绩写进提交（命令与当前基线见硬约定 8）
- [ ] 动过往返链路 → `src/milkdown/roundtrip.test.ts` 与相关往返用例必须绿
- [ ] 动过 UI → 先用 `scripts/cdp-eval.mjs` 核数值，再截图存档到 `.cache/screenshots/`（见「真机调试」）
- [ ] 移动端改动 / 里程碑收尾 → 附真机走查结论（机型 + Android 版本）
- [ ] 改了构建、测试约定或目录结构 → 同一提交内更新本文
- [ ] 涉及发版 → `.github/workflows` 三端全绿

## 发版（v0.1 起）

- **只发三件产物**：Linux `lanmark-linux-x64.tar.gz`（原生二进制）/ Windows `*-setup.exe`（NSIS）/ Android `*-aarch64.apk`；deb/AppImage/msi 不进 release。`.github/workflows/release.yml` 里 Linux 用 `--no-bundle`、Windows 用 `--bundles nsis` 对应这个约定
- 流程：改三处版本号（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`）→ 提交推送 → **先** `gh release create vX.Y.Z --title … --notes-file …` 建 release 说明 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` 自动三端构建并附产物
- 坑：仓库默认 GITHUB_TOKEN 只读，`release.yml` 的 `permissions: contents: write` 不能删（缺了上传 403）
- **Android release 资产走固定 release 签名（M4g，2026-09-24 起）**：`release.yml` 的 android job 解码 `RELEASE_KEYSTORE` secret → 真实 release 构建（**不再是 `--debug`**）→ `apksigner` 校验指纹后才上传；产物路径 `outputs/apk/universal/release/`。keystore 永不入库，4 个值来自 repo secrets，**缺失时 job 直接 fail**（不再静默产出 debug 签名的「release」）。
  - 本地构建（无环境变量）**回退 debug 签名**，`build.gradle.kts` 里 `hasReleaseSigning=false` 时 `release` build type 用 debug signingConfig——所以本地 `--apk` 产物仍是 debuggable、CDP 可用；**看到 CDP 可用先确认产物路径是 `debug/` 还是本地回退，别误判 CI 配置**
  - 一次性迁移：v0.2.1 及更早的存量 Android 用户还需**最后一次**卸载重装（签名从 CI debug 钥匙换成固定钥匙）；应用目录用户的笔记库在应用私有存储，卸载即丢，release notes 必须写明
  - 真 release 包 **CDP 不可用**（`/proc/net/unix` 无 `webview_devtools` 记录）→ 走查回归本地 debug APK

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
