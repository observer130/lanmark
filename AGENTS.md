# AGENTS.md — Lanmark

局域网优先的 Markdown 笔记：**手机 = 同步中心节点**（App 内嵌 axum 服务器），**桌面 = 客户端**（Win/Linux）。
技术栈：Tauri 2 · React 19 · TypeScript 6（strict）· Vite 8 · Tailwind v4 · Zustand 5 · pnpm；Rust core 三端共用。
测试：vitest（jsdom，`src/**/*.test.ts`）+ `cargo test`。

> **本文定位**：只记稳定的约定与操作手册，面向 agent；具体行为以代码与测试为准。
> `README.md` 面向用户；`docs/`、`design/` 是本地阶段稿（gitignore、不入库），会滞后于代码，**不要当事实源**。

## 命令

```bash
source scripts/env.sh            # 构建环境（Android / 交叉编译前必跑；兼容 zsh/bash）

pnpm dev                         # 仅前端，无 Tauri IPC
pnpm tauri:dev                   # 一键 tauri dev；跨平台（Windows→dev.ps1，Linux/macOS→env.sh+tauri dev）
pnpm build                       # tsc + vite build（tsc 即类型门禁）
pnpm test                        # vitest run

cd src-tauri && cargo check
cd src-tauri && cargo test

scripts/android-check.sh         # Android 交叉编译门禁（不跑 gradle）
```

- **没有 lint / format 工具**：无 ESLint / Biome / prettier / rustfmt / clippy 配置，`lint` 脚本不存在。门禁只有 `tsc`（strict）与 `cargo check`。风格沿用既有文件：TS 双引号 + 分号 + 2 空格；Rust 走 rustfmt 默认。
- **`/tmp` 只有 10M tmpfs**：`pnpm test` 的 Node 缓存会吃掉近 9M，随后 `cargo test` 的 SQLite 临时库会成批报 `disk I/O error`。`scripts/env.sh` 已把 `TMPDIR` 指到 `.cache/tmp`；没 source 时按「先 `cargo test` 再 `pnpm test`」跑。
- **Windows 本机**：工具链在 `.cache/`（cargo/rustup/vs-buildtools），pwsh 下先 `. scripts/env.ps1`。dev 一律用 `pnpm tauri:dev`：它把 `WEBVIEW2_USER_DATA_FOLDER` 指到 `.cache\webview-profile`（安全软件会拦未签名 dev exe 读写 `%LOCALAPPDATA%\com.lanmark.app`），日志也落 `.cache\logs`。裸跑 `pnpm tauri dev` 会复现拦截。
- **Android**：`source scripts/env.sh && pnpm tauri android build --apk --debug --target aarch64`，产物 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。它装成独立应用 `com.lanmark.app.debug`（「Lanmark Debug」），与 release 共存。
- 端到端自测：`scripts/make-demo-vault.sh` 生成 `~/lanmark-demo-vault`；桌面 release 用 `scripts/lanmark-desktop.sh`。

## 改动边界

**总是**

- 收尾跑 `pnpm test` 与 `cd src-tauri && cargo test`，成绩写进提交
- 新增工具链或缓存 → 落 `.cache/` 并由 `scripts/env.sh` 导出，不污染 `$HOME`
- 改了构建流程 / 测试约定 / 目录结构 → 同一提交内更新本文

**先问**

- 改 `src-tauri/gen/android/**` 与 `patches/**`——手工维护且是构建路径依赖
- 改往返保真链路：`src/components/EditorPane.tsx`、`src/lib/vault-url.ts`、`src/lib/frontmatter.ts`、`src/lib/wikilink.ts`
- 改同步语义：LWW 裁决、tombstone 传播、端口策略
- 改窄屏断点（JS `innerWidth < 768` 与 CSS `767.98px` 两处必须同步改）
- 加 / 升级依赖，尤其 `tauri-runtime-wry`（升级需重放 `patches/` 补丁）
- 改发版产物矩阵或 `release.yml`

**从不**

- 删掉 `src-tauri/gen/android` 重新 init（会冲掉 SyncService / SAF 代码）
- 把构建路径上的东西移进 `.cache/`（`patches/` 曾因此让 CI 三端全挂）
- 把密钥 / keystore / `.env` 写进仓库
- 让 `db.rs` 的 SQLite 变成事实源——vault 下的文件才是
- 打开笔记时重写文件
- 手改 `src-tauri/gen/schemas`（每次构建自动再生，已 gitignore）

## 硬约定

1. **往返保真是硬门槛**：打开笔记不得重写文件。Crepe 建实例会发一次伪 `markdownUpdated`，`EditorPane.tsx` 的 `lastKnownDoc` 基线专门压它；frontmatter 与 wikilink 不进编辑器、保存时回填；图片显示走 vault 协议、落盘还原相对引用。护栏：`src/milkdown/roundtrip.test.ts`。
   **协议前缀随平台不同**：桌面是 `vault://localhost/<相对路径>`，**Android 必须用 `http://vault.localhost/<相对路径>`**（Android WebView 不认自定义 scheme 的子资源）。生成 URL 一律走 `vaultUrlPrefix()` / `toVaultUrl()`（`src/lib/platform.ts`）；保存前两种前缀都要剥（`fromVaultUrl` / `vaultUrlsToRelative`），只剥一种会把 http URL 写进 md。

2. **vault 文件是唯一事实源**；`src-tauri/src/db.rs` 的 SQLite 只是可重建索引。任何「数据」改动先问文件侧怎么表达。
   同步方向固定：手机 = axum 服务器（`0.0.0.0:4180`，被占则 +1），桌面 = 客户端；文件级 sha256 版本对比，冲突按 **mtime LWW**（较新者留原路径、较旧者存可见冲突副本），删除走 tombstone。**任何裁决都不丢弃内容**：删除先进回收站，冲突输家必留副本。

3. **设置存放分层**：设备偏好（配色/字体/字号/行距/回收站策略）进 `AppConfig`（`app_config_dir/config.json`），换库不变；跟库走的视图状态（折叠目录等）进 localStorage；笔记内容进文件。**不要**把设置放 `.lanmark/settings.json`（会随库漂移、卷进同步清单）。唯一例外是外观 key 额外写一份 localStorage 作首帧缓存（`index.html` 内联脚本先落 `data-scheme`/`data-font`，防深色闪白）；真源仍是 AppConfig，key 名必须与 `src/lib/settings.ts` 常量一致。

4. **构建三禁忌**：
   - `gen/android` 是手工维护的，但 `pnpm tauri android build` 会**重新生成** `app/build.gradle.kts`，往里加的语句会被抹掉（注释会留下，极易误判成「改成功了」）。配置写进 `src-tauri/gen/android/build.gradle.kts`（Android 工程根）的 `subprojects` 钩子（`applicationIdSuffix` 就是这么加的），或新增 `app/src/debug/res/**` 这类不被重写的文件。别直接跑 `./gradlew :app:assembleXxx`（`rustBuild*` 会调只认短架构名的 CLI，必失败）。
   - 构建路径上的东西必须入库：`patches/tauri-runtime-wry`（tauri#15671）曾放 `.cache/` 导致 CI 三端全挂；升级时重拷原件 + 重放补丁，见 `patches/README.md`。
   - `tauri.conf.json` 的 `dragDropEnabled` **必须保持 `false`**：开启后 WebView2 不再向页面派发 HTML5 拖放事件，Crepe 手柄拖不动，且会退化成「拖了变复制」。外部文件拖入另走 `dragover` + `dataTransfer.files`。

5. **平台三坑**（真机 / 桌面 WebView 才复现，Chrome 探针永远绿）：
   - **Android 返回键要拦两条路**：`OnBackPressedCallback` 与 `dispatchKeyEvent`（部分 ROM 把返回转成广播，不走 dispatcher）。原生→前端事件**不要用 `addPluginListener`**，用 `evaluateJavascript` 派发 DOM CustomEvent。Kotlin 单测跑 `./gradlew :app:testUniversalDebugUnitTest`（universal 变体）。
   - **外部文件拖入**：`dragover` 一律 `preventDefault`，**绝不用 `types.includes("Files")` 判断**——WebKit 系在该阶段不暴露 Files，不 preventDefault 则 `drop` 根本不派发；过滤放到 `drop`。
   - **Windows 缩放窗口后输入法候选框跑到屏幕左上角**：`src/lib/ime-anchor.ts` 用 `blur()` → **等 60ms** → `focus()` 重锚；别简化这个间隔（`setTimeout(0)` 对 CodeMirror 不够），且只在 Windows/WebView2 上装。

6. **提交信息一律 `类型(可选范围): 中文简述`**（如 `fix(sync): 删除传播补 tombstone 时序`）；类型只用 feat/fix/perf/refactor/style/test/docs/build/ci/chore/revert，半角冒号 + 一个空格，简述不加句号。

## 环境与平台笔记

**`.cache/` 被清后重建（`scripts/env.sh` 承接不住的部分）**

- **Android SDK 是 curl 手工组装的**，不是 sdkmanager 装的：本网络下 Java 直连 `dl.google.com` 会被重置（curl 正常）。流程：`repo.xml` 查文件名 → curl 取 zip（NDK r27d、cmdline-tools、platform-tools、build-tools 34、platform 34/36）→ 解压成 `platforms/`、`build-tools/`、`ndk/`、`cmdline-tools/`、`platform-tools/` 标准布局 → **手写 `licenses/`**（否则 AGP 报 license 未接受）。
- **Gradle 镜像**：`.cache/gradle/init.d/mirrors.gradle` 把 `google()` / `mavenCentral()` 前置到阿里云（google/public；`buildscript` 另加 gradle-plugin）；分发包走腾讯镜像（`gen/android/gradle/wrapper/gradle-wrapper.properties`）。
- **不要同时设 `ANDROID_USER_HOME` 与已弃用的 `ANDROID_SDK_HOME`**（路径语义不同，AGP 报 `AndroidLocationsException`）；只设前者。
- 改了环境变量但 gradle 行为没变 → daemon 缓存旧环境：`cd src-tauri/gen/android && ./gradlew --stop`。
- `app/build.gradle.kts` 钉 `buildToolsVersion 34.0.0`（AGP 8.11 默认 35，本网络下不下来）。
- 桌面勿发 AppImage（本机 Intel Arc 上 WebKit 子进程 SIGABRT，`EGL_BAD_PARAMETER`）；走 `scripts/lanmark-desktop.sh`。

**vault 目录结构（兼容 Obsidian，纯 md + 附件）**

```
vault/
├── 笔记本A/…/*.md        # 图片引用用相对路径 assets/xxx.png
├── assets/               # 附件按原路径落盘（不强制内容寻址）
└── .lanmark/             # 不参与同步
    ├── sync.json         # 设备名、配对码、已发 token
    ├── lanmark.db        # SQLite 索引（全文搜索 LIKE，非 FTS5）
    ├── tombstones.json   # 删除传播账本（30 天 TTL）
    ├── sync-<id>.json    # 客户端基线
    └── trash/            # 回收站
```

备份 = 直接复制 vault 目录（Obsidian/VSCode 可直接打开）。

**Android 平台约束（不是 bug，别当缺陷修）**

- 前台服务常驻通知绕不开（Android 8+ 后台限制）；Android 15 对 `dataSync` FGS 有 6h/24h 上限，已在用 `specialUse` 规避。
- 国产 ROM（MIUI/HyperOS、EMUI、ColorOS）杀后台激进；熄屏可达依赖电池策略「不受限」，Doze 下 WifiLock 基本无效。MIUI 下 AppOps 授权后需冷启动一次才被 `isExternalStorageManager()` 识别。
- **vault 目录必须 MANAGE_EXTERNAL_STORAGE**：SAF tree URI 能映射到 `/storage/emulated/0/<rel>`，但 Android 11+ FUSE 下 `.md` 直写 EACCES。SAF 选择器只当目录选择 UI，v1 只承诺内部存储（primary 卷）；Android 16 禁选 `Documents/`、`Download/` 根目录。
- targetSdk 35+ 强制 edge-to-edge：删 `enableEdgeToEdge` 无效，必须在 `MainActivity` 对 decorView 做 insets 避让。
- mDNS 收包需 MulticastLock（随 SyncService 生命周期）；WifiLock 无效。
- 加 TLS 时 rustls 必须切 ring 后端（aws-lc-rs 在 Android 交叉编译会挂）。
- **原生库必须 16KB 页对齐**：Android 15+ 的 16KB 页设备上，`.so` 的 `LOAD` 段不是 16KB 对齐会在安装时弹「此应用不符合 16KB 对齐要求」，这类设备还可能加载失败。NDK r27 的 lld 默认只对齐 4KB，所以 `src-tauri/build.rs` 对 Android 目标显式加 `-Wl,-z,max-page-size=16384`（NDK r28 起默认对齐，可删）。改完用 `llvm-readelf -l liblanmark_lib.so` 核 `LOAD` 的 `Align` 应为 `0x4000`。
- 上滑划掉 Activity 会 `process::exit(0)` 连 FGS 一起杀（tauri#15671）→ `prevent_exit()` 保活；重建 Activity 后的白屏用 `ExitRequested` 置 `ACTIVITY_LOST` + 下次 `Resumed` 销毁旧窗口重建。零窗口时 wry 不分发 Resumed，所以 `patches/tauri-runtime-wry` 必须入库。

## 完成标准（DoD）

- [ ] `pnpm test` 与 `cd src-tauri && cargo test` 全绿，成绩写进提交
- [ ] 动过往返链路 → `src/milkdown/roundtrip.test.ts` 与相关往返用例必须绿
- [ ] 动过 UI → 用 `scripts/cdp-eval.mjs` 核数值，截图存档到 `.cache/screenshots/`
- [ ] 移动端改动 / 里程碑收尾 → 附真机走查结论（机型 + Android 版本）
- [ ] 改了构建、测试约定或目录结构 → 同一提交内更新本文
- [ ] 涉及发版 → `.github/workflows` 三端全绿

## 发版

- **只发三件产物**：Linux `lanmark-linux-x64.tar.gz`（原生二进制）/ Windows `*-setup.exe`（NSIS）/ Android `*-aarch64.apk`；deb/AppImage/msi 不进 release。`release.yml` 里 Linux 用 `--no-bundle`、Windows 用 `--bundles nsis`。
- **release 标题只写版本号**（`v0.7.0`），不加描述后缀；功能说明写进 notes 正文。
- 流程：改三处版本号（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`，`Cargo.lock` 随之更新）→ 提交推送 → **先** `gh release create vX.Y.Z --title vX.Y.Z --notes-file …` → `git tag vX.Y.Z && git push origin vX.Y.Z` → CI 三端构建并附产物。
- `release.yml` 的 `permissions: contents: write` 不能删（默认 GITHUB_TOKEN 只读，缺了上传 403）。
- **Android release 走固定签名**：`release.yml` 解码 `RELEASE_KEYSTORE` secret → 真实 release 构建 → `apksigner` 校验指纹后上传；keystore 永不入库，缺失时 job 直接 fail。本地无环境变量时回退 debug 签名，所以本地 `--apk` 产物仍可 CDP；真 release 包 CDP 不可用，走查回归本地 debug APK。

## 真机调试（手机 = 主验证场）

```bash
source scripts/env.sh   # adb 进 PATH（.cache/android-sdk/platform-tools）
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof com.lanmark.app.debug | tr -d '\r')
curl -s localhost:9222/json
node scripts/cdp-eval.mjs "document.querySelector('.ProseMirror')?.clientWidth"
```

- **debug 与 release 共存**：debug 包是 `com.lanmark.app.debug`（`applicationIdSuffix` 写在 `src-tauri/gen/android/build.gradle.kts` 的 `subprojects` 钩子，见硬约定 4），装它**不要卸载 release**——两者签名不同无法互相覆盖，卸载会清掉「应用目录」用户的笔记库。`app/src/debug/res/values/strings.xml` 改应用名「Lanmark Debug」；首启页「应用目录」路径要问插件（`vaultPicker.appDir()`），不要写死包名。
- **探针必须用真触摸**：`Input.dispatchTouchEvent`，别用合成 MouseEvent；坐标要减 `visualViewport.offsetTop/Left`（软键盘弹出时页面被上推）。
- **截图用 `adb exec-out screencap`**，不要 `Page.captureScreenshot`（真机 WebView 上会挂住）；`adb` 用绝对路径（探针不经 `env.sh`）。
- 探针别假设文档里有 `<p>`（前几轮会把段落转成标题），按「任意顶层块」取。
- **Android 16 忽略 `windowSoftInputMode`**：`adjustResize` 不生效（强制 edge-to-edge），键盘弹出时页面被上推、顶栏会滚出可视区；`interactive-widget=resizes-content` 也无效。要修得在 web 层监听 `visualViewport` 锚定，尚未做。
- 屏幕会休眠：黑截图 → `adb shell input keyevent KEYCODE_WAKEUP && adb shell wm dismiss-keyguard`；应用重启后 pid 变，`adb forward` 要重做（或先 `adb forward --remove-all`）。
