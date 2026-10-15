# AGENTS.md — Lanmark

局域网优先的 Markdown 笔记：**手机 = 同步中心节点**（App 内嵌 axum 服务器），**桌面 = 客户端**（Win/Linux）。
技术栈：Tauri 2 · React 19 · TypeScript 6（strict）· Vite 8 · Tailwind v4 · Zustand 5 · pnpm，一套 Rust core 跑三端。测试：vitest（jsdom，`src/**/*.test.ts`）+ `cargo test`。

> **本文定位**：只记**不随实现漂移的稳定约定与操作手册**，是面向 agent 的**唯一事实源**；具体行为一律**以代码为准**。
> `README.md` 面向用户（功能/下载/首次使用），开发约定不进 README。
> `docs/`、`design/` 是本地阶段稿，**已被 gitignore、不入库**：天然滞后于代码，且已与 M4 起的新决策有多处冲突（如已取消的扫码配对、已推翻的前台服务插件方案）。**读它会错**；拿不准时用代码与本文，并顺手更正本地稿。

## 命令

```bash
source scripts/env.sh            # 构建环境（Android / 交叉编译前必跑）；兼容 zsh/bash

pnpm dev                         # vite 开发（仅前端，无 Tauri IPC）
pnpm tauri:dev                   # 一键 tauri dev（跨平台分发：Windows→pwsh+env.ps1；Linux/macOS→env.sh+tauri dev）
pnpm build                       # tsc + vite build（tsc 即类型门禁）
pnpm test                        # vitest run
pnpm vitest run -t "往返"         # 按用例名过滤
pnpm vitest run src/lib/vault-url.test.ts   # 只跑单个文件

cd src-tauri && cargo check      # Rust 静态检查
cd src-tauri && cargo test       # Rust 测试
cd src-tauri && cargo test --lib sync_server   # 按模块过滤

scripts/android-check.sh         # Android 交叉编译门禁（不跑 gradle）
```

**Windows 本机构建**（本机无全局 Rust/MSVC 时）：工具链已按硬约定 1 落在仓库 `.cache/`——
`.cache\cargo`、`.cache\rustup`（rustup-init `-y --profile minimal --no-modify-path` 装 stable）与
`.cache\vs-buildtools`（VS Build Tools，VCTools 工作负载 + Windows SDK）。pwsh 下先
`. scripts/env.ps1` 再跑 `cargo`（它会捕获 vcvars64 的 INCLUDE/LIB/PATH 并缓存到
`.cache\vcvars64.env`）；首次 `cargo check/test` 全量编译依赖树约十几分钟，之后增量秒级。
`.cache\vs_BuildTools.exe` / `.cache\rustup-init.exe` 是安装器留存，删了不影响已装工具链。

**`pnpm tauri:dev` 是跨平台的**（`scripts/dev.mjs` 分发：Windows → `scripts/dev.ps1`；Linux/macOS → `source scripts/env.sh` + `pnpm tauri dev`）。**别再把它写成 pwsh 专用**——曾直接写死 `pwsh -File scripts/dev.ps1`，非 Windows 上必报 `pwsh: 未找到命令`，把桌面 dev 入口堵死（2026-09-30 实测）。额外参数原样透传：`pnpm tauri:dev -- --no-watch`；`pnpm tauri:dev -- -- --appArg` 里第二个 `--` 会保留（tauri 用它标记 runner 参数起点）。

**Windows 本机跑 dev 一律用 `pnpm tauri:dev`**（分发到 `scripts/dev.ps1`）：它除激活工具链外，
还把 `WEBVIEW2_USER_DATA_FOLDER` 指到 `.cache\webview-profile`——本机安全软件会拦截
**未签名 dev exe** 读写 `%LOCALAPPDATA%\com.lanmark.app`（WebView2 报 0x800700AA /
0x8000FFFF「资源在使用中/灾难性故障」，日志写入报 os error 5；安装版有签名/信誉背书
不受影响，CI 亦然）。dev 构建的日志同样因此落到 `.cache\logs`（lib.rs 按
`cfg!(debug_assertions)` 分流，release 仍是标准 LogDir）。裸跑 `pnpm tauri dev` 会复现拦截。
`vite.config.ts` 的 `watch.ignored` 必须同时忽略 `src-tauri` 与 `.cache`：TMP 指向
`.cache/tmp` 时链接器临时文件会让 watcher 直接 EBUSY 崩掉 dev server（2026-10-07 实测）。

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
| `src/components` | 界面：`App.tsx` 装配 · `Sidebar`（搜索/收藏/最近/树/回收站（可恢复，v0.5.1）+ 收藏/回收站分区折叠 + 底部设置行 + 同步条）· `TreeView` · `EditorPane`（往返保真关键，见硬约定 3；`editorKey` 是外观不进 key 的护栏）· `BlockMenu`（块级操作浮层/底部抽屉：上移·下移·删除，三条触发路径见硬约定 13/17）· `InsertMenu` / `ModeMenu`（窄屏底部抽屉：插入块 / 编辑模式，见硬约定 13/21）· `useDismissable`（浮层统一关闭行为）· `SyncSection` · `SettingsDialog`（宽屏模态 / 窄屏全屏页）· `VaultPicker`（首启选库）· `CreateDialog` · `WindowControls`（Linux 无边框窗控）· `AppMark`（应用品牌标，见硬约定 12） |
| `src/stores` | Zustand：`vault.ts`（目录树/编辑/防抖保存/搜索/切库）、`sync.ts`（配对/LAN 扫描/探测/自动循环）、`settings.ts`（乐观更新 + CSS 变量/外观属性 + 回滚）、`update.ts`（M5-4 更新检测：启动静默检查 + 手动检查，关于页展示）、`back.ts`（M4i 返回手势：上报浮层状态 / 监听 `lanmark:back` DOM 事件）、`bridge.ts`（Rust 事件日志）；每个 store 旁有同名 `*.test.ts` |
| `src/lib` | 纯逻辑 + 前端测试：`vault.ts`（IPC 封装）、`vault-url.ts`（`vault://` ↔ 相对引用换算）、`frontmatter.ts`、`wikilink.ts`、`image.ts`、`sync.ts`、`settings.ts`（枚举→像素映射的**唯一来源** + `applyCssVars`/`applyScheme`/`applyFont`；外观 = 配色 + 编辑区字体 + 字号/行距，色值与字体栈在 index.css）、`ime-anchor.ts`（Windows 缩放后输入法候选框跑屏幕左上角的护栏，见硬约定 15）、`bridge.ts` |
| `src/milkdown` | 编辑器纯逻辑（**唯一配置来源**）：`product.ts`（`PRODUCT_FEATURES` / `PRODUCT_PLUGINS` / `createProductCrepe`——`EditorPane` 与护栏测试共用，见硬约定 18）· `block-move.ts`（块定位 + 移动原语：单元长度/行间隙天然层级/整体升降级/上下移命令 + `Alt-↑/↓`，见硬约定 19/20）· `block-drag.ts`（**接管手柄拖放的落点**：拖拽源记录、行间隙落点、层级、指示线与父标题高亮，见硬约定 17/19/20）· `block-insert.ts`（插入块命令，见硬约定 21）· `highlight.ts`（荧光笔 `==文字==`：remark 切分 + mark + 命令/输入规则/快捷键/图标，见硬约定 22）· `roundtrip.test.ts`（往返保真护栏，M1 决策门）· `insert.test.ts`（插入块护栏） |
| `src/index.css` | 设计 token（`:root` = 浅色 + 默认字体；`:root[data-scheme=…]` 深色/纸页、`:root[data-font=…]` 宋体/楷体，再加 `@theme`）与**全部 Crepe / CodeMirror 主题覆盖**；顶部 `@import` 内置字体（见硬约定 16）；改编辑器外观或加配色/字体先来这里 |
| `src-tauri/src` | Rust core：`commands.rs`（IPC 入口，`xxx` 是 3 行封装、`xxx_op` 是可测纯逻辑）· `bridge.rs`（事件通道，纯逻辑不依赖运行时）· `fs_ops`（文件/回收站/**vault 统计与回收站清理**）· `db`（SQLite 索引 + 全文搜索；搜索是 LIKE 而非 FTS5——中文 2 字词用 FTS5 trigram 查不到）· `vault`（`AppConfig` 持久化）· `settings`/`settings_cmd`（M4a 设备级偏好：结构 + 归一化 + 白名单，与 vault 无关）· `alias`（M4h-4 设备代号：词表生成/归一化/AppConfig 持久化/进程内缓存，语义对标 LocalSend alias）· `protocol`（`vault://`）· `sync_server`/`sync_client`/`sync` · `lan_scan`（M4h-1 LAN 并发探测发现）· `update`（M5-4 GitHub release 更新检测：纯逻辑版本比较 + 24h 节流进 AppConfig，`update_check` 命令）· `mobile`（SAF 选库 + 授权）· `sanitize`（文件名规则） |
| `src-tauri/gen/android` | **手工维护的 Android 工程**（`SyncService.kt` 前台服务、`MainActivity.kt`、`app/build.gradle.kts` 钉 `buildToolsVersion 34.0.0`），已入库，见硬约定 2 |
| `scripts/` | `env.sh`（构建环境，必 source）· `env.ps1`（Windows 等价物：.cache 工具链 + vcvars64 捕获）· `dev.mjs`（`pnpm tauri:dev` 的跨平台分发器：Windows→`dev.ps1`，Linux/macOS→`env.sh`+`tauri dev`）· `dev.ps1`（Windows 分支：工具链 + WEBVIEW2_USER_DATA_FOLDER，见「Windows 本机构建」）· `android-check.sh`（交叉编译门禁）· `cdp-eval.mjs`（真机 CDP）· `make-demo-vault.sh` · `lanmark-desktop.sh` · `gen-icon.py` · `install-desktop-entry.sh` |
| `patches/` | vendor 的依赖补丁（tauri-runtime-wry，tauri#15671），见硬约定 9 |
| `licenses/fonts/` | 内置字体的许可文本与义务清单（OFL 全文 / MiSans 协议节选 / 各包 LICENSE），见硬约定 16 |
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
10. **设备偏好进 `AppConfig`，vault 级视图状态进 localStorage，笔记内容进文件**（M4a 定，docs/08 §4.1）：配色/字体/字号/行距/编辑器偏好/回收站策略都存 `app_config_dir/config.json`，**换库不该改变偏好**；折叠目录等跟库走的视图状态留 localStorage；`.lanmark/settings.json` 这种放 vault 里的做法是错的（会让设置随库漂移并卷进同步清单判定）。**唯一例外（M6c）**：外观 key 额外写一份 localStorage 作**首帧启动缓存**——`index.html` 的 `<head>` 内联脚本读它先把 `data-scheme`/`data-font` 落位，否则深色用户每次冷启动闪一帧白（读设置是异步 IPC、赶不上首帧；初始窗口来自 `tauri.conf.json`，没有建窗钩子可注入）。**真源仍是 AppConfig**：缓存被清只退化为一帧闪白，不丢设置；`applyScheme`/`applyFont` 是唯一写入点，与属性同步维护（M7 起是两个 key：`lanmark-scheme`/`lanmark-font`，**index.html 里的字符串必须与 `src/lib/settings.ts` 的常量一致**）。
11. **外观设置只走 CSS 变量 / DOM 属性，绝不进编辑器 `key`**（M4b 定，docs/08 §9 R2；M6 扩到主题，M7 拆成配色 + 字体）：改字号/行距/配色/字体不得重建 Crepe 实例——建实例会发伪 `markdownUpdated`，等于把打开着的笔记重写一遍（硬约定 3）。`editorKey(path, mode)` 是这条的护栏函数，`settings.test.ts` 有用例钉住；写入点是 `src/lib/settings.ts` 的 `applyCssVars`（→ `:root` 变量）、`applyScheme`（→ `<html data-scheme>`）与 `applyFont`（→ `<html data-font>`），store 里统一经 `applyAppearance` 调用，**色值与字体栈只写在 `index.css` 的 `:root[data-scheme=…]` / `:root[data-font=…]` 块、JS 不持有色值也不持有字体串**。**配色与字体解耦**：两个属性覆盖的属性集不相交（颜色 token vs `--lanmark-font-text`），所以 3×3 组合天然成立，加新配色/字体只需加一个 CSS 块 + 一个枚举值；`light`/`sans` 故意不写块（`:root` 即默认，脏值/缺属性安全回落）。字体只作用于**编辑区**，界面壳 `--font-sans` 常驻不随动（M5 D3 边界，别再引入「界面字体」设置）。
12. **应用图标改一处要改全套，UI 内品牌标走 `AppMark`**：图标有 4 处独立副本——`src-tauri/icons/`（Tauri 打包位图 + SVG + 桌面 entry 图标）、`scripts/gen-icon.py`、**`src/components/AppMark.tsx`**（界面内联矢量）、`public/app-icon.svg`（favicon）、`src-tauri/gen/android/**/mipmap-*`（Android 自适应层，手工维护）。a6a5a13 换图标时只换了前两处，界面里手写的「蓝底白 L」占位块漏改（就是这个 bug），**别再手写 `bg-accent` + 文字当 logo**。投影用 `index.css` 的 `.lanmark-appmark`（`filter: drop-shadow`），不用 `shadow-*`：那是 `box-shadow`，会按 svg 矩形边界投影，圆角外的透明四角露出直角阴影。`scripts/gen-icon.py` 必须与设计源 `icon.svg` 同步更新——它是「重跑即回退」的陷阱（旧版画的是白 L）。

13. **移动端（窄屏）UI 按触屏做，不做「桌面布局缩小版」**（M4i 定）：触控目标 **≥44px**（树行 / 搜索框 / 菜单项 / 图标按钮）——**44px 只属于窄屏**：类名写移动优先的 `min-h-[44px]` / `h-11`，再跟 `md:` 前缀恢复桌面紧凑高度（Tailwind v4 默认 `md:` = 768px，与硬约定 6 的断点一致；28eed13 只给新建按钮加了 `md:`、树行/搜索框/菜单项/齿轮漏加，桌面端被连带放大，已修）。手机上**没有 hover**，依赖 `group-hover` 的控件等于不可达——行级操作走**长按 `contextmenu`**（真机实测 WebView 长按会派发该事件）。**编辑器里的块级操作同理**：Crepe 的左侧「+」与六个点手柄靠 ProseMirror `pointermove` 悬浮显示，触屏一进入滚动、浏览器就发 `pointercancel` 掐断 `pointermove`，手柄等于不可达——所以块操作在窄屏走长按唤出 `BlockMenu`（`src/components/BlockMenu.tsx`），**别指望把手柄样式改大就能用**（M8 G2）。侧栏在窄屏是 **85vw 半屏抽屉 + 遮罩**（Gmail / Obsidian Mobile 式，此前是全屏铺满，右侧无可点遮罩区，是「像桌面端」的根因）。**新建入口留在侧栏「笔记本」标题右侧**（M4i：曾加过编辑器右下角 FAB，因悬在正文上挡字、且「新建」属导航/管理动作而非编辑器行为而移除——别再加回来）。
    返回手势：**有浮层先关浮层，没有就正常退出**，**不做「再划一次退出」**——两段式是把侧栏当一级菜单页的设计，半屏浮层下不成立（M4i 中途推翻）。
    `src/index.css` 的窄屏块里有三条手机端适配（去点击高亮蓝块 / `overscroll-behavior: contain` / `text-size-adjust`），别顺手删。
    **窄屏头部（编辑器页头）的实测布局**（M8 批次 2，385px）：塞得下的是「面包屑 + 插入块「+」+ 编辑模式 + Linux 窗控」；**别再往这里加东西**。两处刻意的取舍：① 模式切换在窄屏**收成一个 44px 按钮 + 抽屉**（`ModeMenu`）——原来三段内联每段只有 31px，本身就违反本条的 ≥44px，而且挤掉面包屑；② **窄屏不渲染「收藏」星**——它只有 23px、且同一动作侧栏树行的长按/右键菜单里已有，省下的 31px 让面包屑从 28px 回到 ~109px（28px 约等于一个字，等于没有）。Linux 窗控那三个 ~26px 的按钮不动：那是桌面标题栏惯例、Android 上不存在。
14. **Android 返回键要拦两条路，且事件不走插件通道**：`generated/TauriActivity.kt` 把 `handleBackNavigation` 覆盖成 **false**，返回默认直接 finish、前端收不到任何事件。自拦时必须同时覆盖 **`OnBackPressedCallback`** 与 **`dispatchKeyEvent`**——部分 ROM（真机 2510DRK44C / Android 16 的 MIUI）把返回键转成广播 `miui.intent.KEYCODE_BACK`，**不派发给 `OnBackPressedDispatcher`**，只注册回调根本不触发。
    原生→前端的事件**不要用 `addPluginListener`**（实测注册后 Kotlin 侧 `hasListener=false`，事件永远收不到），改在插件里持 WebView 用 `evaluateJavascript` 派发 DOM CustomEvent（见 `BackPlugin.kt` / `src/stores/back.ts`）。
    Kotlin 纯逻辑单测放 `gen/android/app/src/test/java/`，跑法：`source scripts/env.sh && cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest`（注意是 **universal** 变体，`testDebugUnitTest` 会因多 flavor 歧义报 ambiguous）。
15. **Windows 缩放窗口后输入法候选框跑到屏幕左上角，靠 `src/lib/ime-anchor.ts` 重锚焦点；别「简化」那 60ms**：WebView2 宿主窗口被**真实拖拽缩放**后（鼠标拖边框；`SetWindowPos` 这类程序化改尺寸不复现、真实移动窗口也不复现），浏览器进程侧的 TSF 文本库丢了 caret 布局，候选框与预编辑浮到屏幕原点且**不自愈**——直到发生一次真正的焦点转移（用户说的「点别处再点回来就好了」就是它）。上游记录 MicrosoftEdge/WebView2Feedback#5675，复现环境就是本仓库这套 tauri / wry / webview2 154，Edge/Chrome 不复现。护栏做法：窗口尺寸稳定后（防抖 120ms）把当前可编辑元素重锚一次——`blur()` → **等 60ms** → `focus({preventScroll:true})` + 还原选区与滚动。**实测结论（别再试更「干净」的替代）**：同一任务内同步 `blur+focus`、`setTimeout(0)`、只调 `focus()`、只挪 DOM 选区，全部无效；`setTimeout(0)` 在所见即所得（ProseMirror）够用、**源码模式（CodeMirror 6）不够**，故统一钉 60ms。合成中输入法不打断（等 `compositionend` 再补），且只在 Windows/WebView2 上装（Linux WebKitGTK / macOS WKWebView 的输入法行为不同，不替它们做这个动作）。复核手法：拖窗口边框缩放后立刻用微软拼音打字，看候选框是否仍贴在光标下方（真机 CDP + `SendInput` 注入；本机探针脚本在 `.cache/`，已 gitignore 不入库）。

16. **字体随应用内置（npm 包 + 钉死版本），许可义务落在 `licenses/fonts/`**（M6d 定）：编辑区字体来自 `misans` / `@fontsource/noto-serif-sc` / `lxgw-wenkai-screen-webfont` / `@fontsource/jetbrains-mono`，在 `index.css` 顶部 `@import`，**版本号不带 `^`**（字体包的目录结构与切片范围随大版本变）。**MiSans 的协议要求「在软件中特别注明使用了 MiSans」——「设置 → 关于」页那行字体署名不能删**；不得改编 MiSans 字体、不得单独分发/售卖字体文件（随 App 分发是明确允许的）。`@fontsource` 每个切片都带 `woff` 回退，由 `vite.config.ts` 的 `stripWoffFallback()` 在构建期剥掉（实测省 226 个文件 ≈7.7MB；三端 WebView 都支持 woff2）。**加新字体前先读 `licenses/fonts/README.md`**。

17. **`tauri.conf.json` 的 `dragDropEnabled` 必须保持 `false`，别再加回来**（M8 定）：该字段默认 `true`，开启时 wry 会调 `SetAllowExternalDrop(false)` 并注册原生拖放处理器（`wry-*/src/webview2/mod.rs`），WebView2 从此**不再向页面派发 HTML5 拖放事件**；而 Crepe 的块手柄只走 HTML5 拖放（`@milkdown/plugin-block` 挂 `dragstart` + ProseMirror `handleDrop`），症状就是「六个点拖不动」。Tauri 官方文档原话：*Disabling it is required to use HTML5 drag and drop on the frontend on Windows.* 关掉之后**外部拖图不受影响**：wry 不再调 `SetAllowExternalDrop(false)`，WebView2 保持默认放行，文件仍以 HTML5 `drop` 到达页面、`dataTransfer.files` 可用（`src/lib/image.ts` 的 `uploadFile` 只吃 `File` 对象、不需要路径）。**别为外部文件改回 `onDragDropEvent`**：它是互斥方案——拿到文件路径的代价就是掐掉内部拖拽（tauri#15138）。
    拖拽**不能**是块移动的唯一通路，而且**拖放的落点由我们自己接管**（`src/milkdown/block-drag.ts`）：ProseMirror 内建的 `view.dragging` 链在部分 WebView 上会断，断掉后它回退成「从 `dataTransfer` 解析 HTML 再插入」——**源块不删、目标处多一份**，也就是「拖了变成复制」。别把 `handleDrop` 交回去，那等于把复制 bug 请回来。**Linux 也受影响，别以为这条只对 Windows 有意义**（2026-10-13 本机 Linux/KDE 实测）：`true` 时用户报「六个点拖动无效」，改成 `false` 后同一台机器拖拽立即有反应（先是复制，去掉对 `view.dragging` 的依赖后才是移动）。**外部拖入图片在三端仍待复核**——改这里之后 Windows 与 Linux 都要真机走一遍「拖拽」与「拖入图片」两件事。

18. **Crepe 的 feature 开关与 feature 配置是两个字段，别混**（M8 定）：开关走 `new Crepe({ features })`，配置走**独立的 `featureConfigs`**。把 `{ buildToolbar }` 之类塞进 `features[CrepeFeature.Toolbar]` 会**静默无效**——不报错、不生效，界面上只是少了个按钮（2026-10-13 实测踩过）。产品配置的唯一来源是 `src/milkdown/product.ts`：`EditorPane.tsx` 与往返护栏测试都经 `createProductCrepe` 建实例，**别再各自抄一份 feature 表**（两边漂移时护栏会失效）。同理，给编辑器加自研插件只经 `PRODUCT_PLUGINS` 注册。

19. **块移动的语义是「标题 = 一节」：整节搬 + 可升降级；移动原语只有一份**（M8 定）：`src/milkdown/block-move.ts` 是**唯一**的移动原语，块菜单、`Alt-↑/↓`、拖放三条路都走它，别各写一套。
    - **单元长度**（`unitLengthAt`）：标题连同它下属的内容，直到下一个**同级或更高级**标题为止；其余块恒为 1。所以拖一个 h2 会带走它的段落、列表与更深的 h3。
    - **标题只与同级节交换**：上移时跳过更深的标题、遇到更高级标题就停（那说明它已是父节的第一节，再上移等于把它「提升」出父节）；下移时若下一节更高级也停。不这么限，就会把别的节的内容悄悄改归它管。
    - **非标题单元**（段落/列表/代码块等）仍是**逐块**移动（上半区插到它之前、下半区插到它之后），这样节内段落重排不会被放大成整节跳动；**标题单元**另有层级语义，见硬约定 20。
    - **命中判定与坐标定位必须同一口径**（`topBlockIndexFromPoint`）：右键/长按/落点常常落在正文之外（左侧槽位、`.ProseMirror` 自身 padding、手指偏出文本列），`posAtCoords` 在那里**直接返 null**——横向出内容列时只按纵向定位、横向取内容列中线。分开写两份必然漂移，表现成「点了没反应」。
    - 菜单置灰用 `planMove` **预演**（`moveUnitTo` 传 `undefined` dispatch），别在 UI 里重算索引。
    - **落点指示线**（`computeDropSlot` 一个函数同时产出「插入序号」与「线的位置」）：拖拽时必须让用户看见精确落点，且**线画在哪就必须落在哪**——判定与画线分成两份必然漂移，变成「线在这儿、东西落在别处」，比没有线更糟。落点算出来是「不动」时**不画线**，让「这里放不下」也有反馈。
    - **手柄拖拽一律由本插件给结论（`handleDrop` 必须返回 true）**：只有它不是手柄拖拽（正文选字 / 外部文件）时才返回 false。曾在这里 `return moved !== null`，于是「落点算出来无操作」时把 drop 交回 prosemirror-view 的内建路径，而它只搬**单个节点**——表现就是「拖标题只搬标题」（2026-10-13 走查反馈）。**别再让它有机会接手。**
    - 别改用 ProseMirror 的 `dropCursor`（`CrepeFeature.Cursor`）当指示线：它按 `dropPoint` 画在**块级**位置，而这里的落点带**节层级**语义（见硬约定 20），拖标题时两者必然不一致。

20. **标题拖拽 = 行间隙 + 层级；落点不折叠、层级取该间隙的天然值**（M8 定）：markdown 的标题是**显式层级**（`##`/`###`）而不是容器，节边界由「最近的上层标题」决定。
    - **落点就是顶层块之间的行间隙**（`computeDropSlot`）：上半区插到该行之前、下半区插到该行之后——**每一行之间都能插入**。层级由 `naturalLevelAtGap`（纯逻辑、有用例）给出：间隙后是标题 M → 与它**同级**（M）；间隙后是正文或文末 → 成为**所属节**的子节（P+1，P = 最近的上层标题）。P+1 同时也是**吞得最少**的层级（该节会在下一个比 P 更深的标题处就结束）。
    - ⚠️ **别把落点折叠到节末**。曾以「插入标题必然把后面内容划进新节」为由，把整节内容区的落点折到该节末尾，结果一篇「H1 + 两个 H2」的文档里除标题行外**全部指向文末**，用户只能拖到两处（2026-10-13 走查判定不可用）。**吞并是 markdown 的固有语义**（手打一个标题在那里也一样），不能用牺牲落点精度来回避。
    - **主动作**：落在标题**下半区** = 放进该节**末尾**、成为它的最后一个子节（降一级，**整块高亮该标题**）。落节末而不是紧跟标题之后，是为了不把该节原有正文挤到新区块之下——这是唯一一处刻意不做「行间隙」的手势。
    - **落在自己身上 = 不动**（`computeDropSlot` 里显式返回 null，判据是**间隙**落在 `[srcIndex, srcIndex+unitLength]`）：否则「拖歪一点、松手落在自己正文上」就会被降级。
    - **升降级要整体平移**：被移动节内的**所有**标题按同一差值调整（`shiftHeadingLevels`），夹在 1..6。`###` 提到 `##` 时它下面的 `####` 也要跟着变 `###`，否则节内相对层级被压平。
    - **不做横向拖动映射层级**——本编辑器标题不缩进（没有横向刻度可对齐），且手柄在左侧、指针自然落在文本右侧，横向映射会导致「永远最深层级」。
    - **刻度起点 = 文档里最浅的「大于 `#`」的那一级**（`outlineBaseline`，纯逻辑 + 用例）：`#` 在笔记里是**文档标题**，`##` 及以下才是分节 → `##` = 第 0 格、**贴着内容列左边缘**，`###` = 1 格…；文档里没有 `##` 及以下时退化取 `##`。**这是绝对约定，不许看 `#` 出现了几次**：
      - 最初用「绝对层级 − 1」→ `##` 落在第 2 格、圆点明显偏右（走查：视觉误导）。
      - 改成「全篇恰好一个 `#` 才算文档标题」→ 用户那篇测试文档里 `# 测试` 与 `# Hello world!` 都是 H1（两个），判据直接不成立，刻度毫无变化（走查：**真机验收不通过**）。**踩过两次的计数判据不要再回去用。**
    - **刻度只决定指示线画在哪，不改变落点层级**（`naturalLevelAtGap` **不**收口到起点）：否则拖动一个已有的 `#` 块会被强制降成 `##`。代价是 `#` 与 `##` 共用最左格——在「`#` 是文档标题」的文档里，落点在 `#` 之前的场景本就无意义。
    - **指示线同时表达位置与层级**：线画在**它将要插入的那一块的顶边**（`gapY`；不用上一块的底边——标题自带 24px 下边距会让线浮在空白里），**左端缩进与圆点横向位置 = 落点层级**（每深一级 +22px，`INDENT_PX`，超出时不画在内容列左侧之外）；「放进某节」时 `lanmark-drop-parent` 高亮父标题块。算出来是「不动」时**线不画、高亮不出**。

21. **「插入块」菜单（窄屏头部「+」）的两条不变量**（M8 批次 2 定）：执行层在 `src/milkdown/block-insert.ts`，逐条命令组合对齐 Crepe 同版本的斜杠菜单，**但有两处刻意不同**：
    - **不许抄 `clearTextInCurrentBlockCommand`**。Crepe 斜杠菜单每条命令前都挂它（用来抹掉用户敲的 `/h2`），照抄会把**当前块的正文整段删掉**——我们的菜单是点按钮打开的，当前块里是用户的字。文本类用 `setBlockTypeCommand` / `wrapInBlockTypeCommand`（转换当前块、保留文字）。
    - **块类（分割线/表格/公式）不要用 `addBlockTypeCommand`**（= `replaceSelectionWith`）：光标在「你好」中间时会得到 `你` + 块 + `好`，**把正文劈成两半**。它们走 `insertBlockAfterCurrent`（在当前顶层块**之后**新增一块），与桌面 hover「+」的「在下方插入」语义一致。
    - 菜单只列**标题 1–3**：窄屏抽屉里 h1–h6 六项太长，而 h4–h6 极少用（需要时 `Ctrl+1..6` 或源码模式）。真机走查觉得不够再加。
    - 浮层的关闭行为（Escape / 点外部 / 滚动 / 缩放）统一走 `src/components/useDismissable.ts`——块菜单、插入抽屉、模式抽屉三处**不要各写一份**，否则必然漂移成「某个菜单按 Esc 关不掉」。

22. **荧光笔是 `==文字==`，解析不走 micromark**（M8 批次 3 定）：实现全在 `src/milkdown/highlight.ts`，注册进 `PRODUCT_PLUGINS`，工具条按钮在 `product.ts` 的 `PRODUCT_FEATURE_CONFIGS`。
    - **别给 `==` 手写 micromark 分词器**。`~~删除~~` 那种要词法层识别，但荧光笔只要在 mdast 建好后**事后切分 `text` 节点**就够了（`remarkHighlight` 插件 → `lanmarkHighlight` mdast 节点 → mark 的 `parseMarkdown`/`toMarkdown` 双向映射）。手写分词器的定界符规则极易写错，而错了就是**往返损坏**（硬约定 3，本仓库最不能出的问题）。
    - **正则的形状是有约束的**：分隔符必须用**反向引用**（`\1`）而不是第三个捕获组——`markRule` 取**最后一个捕获组**当「要加标记的内容」，多一个捕获组就会把分隔符当成内容。切分用第 1 组（内容）。
    - **递归切分时必须跳过 `inlineCode` / `code` / `html` 子树**，否则代码块里的 `==x==` 会被当成语法吃掉。
    - **已知边界**（有意接受，别当 bug 修）：不支持跨行内节点，所以 `==**粗**==` 不会高亮；`== 文字 ==`（内侧贴空格）与 `a == b` 都**不**判为高亮。
    - **两个既有行为已用用例钉住**：① 段落行首的 `==文字==` 在没有本功能时会被 `remark-stringify` 加反斜杠转义（因为 `=` 可起 setext 下划线）——本功能**顺带修好了**它；② 行首 `\== 文字 ==`（不构成高亮的那种）仍会被转义，**非本功能引入**。
    - **CSS 里的 `color: inherit` 不能删**：色值走 `--c-mark`，在 `:root` / `[data-scheme="dark"]` / `[data-scheme="paper"]` 三块各给一个（浅色暖黄 / 深色低饱和琥珀 / 纸页沙金）；规则用 `.editor-host .milkdown .ProseMirror mark` 压过 Crepe 默认（硬约定 7）。frame 给 `mark` 设了自己的文字色，不继承就是**深色下黑底黑字**。

## 完成标准（DoD）

- [ ] `pnpm test` 与 `cd src-tauri && cargo test` 全绿，成绩写进提交（命令与当前基线见硬约定 8）
- [ ] 动过往返链路 → `src/milkdown/roundtrip.test.ts` 与相关往返用例必须绿
- [ ] 动过 UI → 先用 `scripts/cdp-eval.mjs` 核数值，再截图存档到 `.cache/screenshots/`（见「真机调试」）
- [ ] 移动端改动 / 里程碑收尾 → 附真机走查结论（机型 + Android 版本）
- [ ] 改了构建、测试约定或目录结构 → 同一提交内更新本文
- [ ] 涉及发版 → `.github/workflows` 三端全绿

## 发版（v0.1 起）

- **只发三件产物**：Linux `lanmark-linux-x64.tar.gz`（原生二进制）/ Windows `*-setup.exe`（NSIS）/ Android `*-aarch64.apk`；deb/AppImage/msi 不进 release。`.github/workflows/release.yml` 里 Linux 用 `--no-bundle`、Windows 用 `--bundles nsis` 对应这个约定
- **release 标题一律只写版本号**（`v0.6.0` / `v0.7.0` / `v0.7.1` 这样；notes 正文首行标题同此），**永远不加「— 描述」后缀**：releases 列表里只展示版本号，功能说明一律写进 notes 正文。`v0.6.0 — 外观系统 · 四套主题 · 内置字体` 那种写法不再使用（v0.6.1 起已改）
- 流程：改三处版本号（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`，`Cargo.lock` 里的 `lanmark` 版本随之更新）→ 提交推送 → **先** `gh release create vX.Y.Z --title vX.Y.Z --notes-file …` 建 release 说明 → `git tag vX.Y.Z && git push origin vX.Y.Z` → `.github/workflows/release.yml` 自动三端构建并附产物
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
