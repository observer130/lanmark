# Lanmark

局域网优先的 Markdown 笔记软件（Windows / Linux / Android），手机作为局域网同步中心节点。

```
Tauri 2 (Rust core) + React 19 + TypeScript + Tailwind CSS v4 + Zustand
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-可行性评估与需求确认.md](docs/01-可行性评估与需求确认.md) | 可行性、风险、已确认需求 |
| [docs/02-技术选型与工程路线.md](docs/02-技术选型与工程路线.md) | 选型论证、架构、同步协议、里程碑 |
| [docs/03-M0-环境与构建指南.md](docs/03-M0-环境与构建指南.md) | 本机开发环境、构建、Android 安装 |
| [docs/04-M1-数据与组织模型.md](docs/04-M1-数据与组织模型.md) | vault/目录树/编辑器/搜索设计、实现决策与验证记录 |
| [docs/05-M2-移动端与同步设计.md](docs/05-M2-移动端与同步设计.md) | 手机同步服务器、协议、Android 专项、真机验收与 review 修复记录 |
| [docs/06-Android端内嵌HTTP服务器保活调研.md](docs/06-Android端内嵌HTTP服务器保活调研.md) | 前台服务/wakelock/Doze 保活调研（结论附来源） |
| [docs/07-M3-同步引擎深化设计.md](docs/07-M3-同步引擎深化设计.md) | M3：自动同步循环、删除传播（tombstone）、冲突 LWW 裁决设计 |

> 代理/协作开发约定见 [AGENTS.md](AGENTS.md)；调研记录在 [docs/research/](docs/research/)。

## 快速开始（桌面端）

```bash
pnpm install
pnpm tauri dev            # 开发调试（热重载）

# 或运行 release 原生二进制（本机 AppImage 有 Intel Arc 兼容性问题，用原生启动器）
pnpm tauri build --no-bundle
scripts/lanmark-desktop.sh
```

首次启动选择笔记库目录。想快速体验完整功能，可先生成一个演示库：

```bash
scripts/make-demo-vault.sh    # → ~/lanmark-demo-vault（中文笔记/图片/frontmatter + 验收清单）
```
然后在首启页「打开现有笔记库」指向它，按「欢迎使用 Lanmark.md」里的 验收清单走一遍。

Linux 桌面首选用原生启动器：`lanmark-desktop.sh` 会在缺桌面入口时自动补装
（`scripts/install-desktop-entry.sh`，用户级 `~/.local`，把任务栏/Alt+Tab 图标
修复为应用自有图标 —— 依赖 `tauri.conf.json` 的 `enable-gtk-app-id` 与
`com.lanmark.app.desktop` 的 app_id 匹配）。也可手动单独执行安装脚本。

## 开发

```bash
pnpm install

# 前端构建 + 类型检查
pnpm build

# 前端测试（往返保真 / 路径换算 / 纯函数）
pnpm test

# Rust 侧检查与测试
cd src-tauri && cargo check && cargo test

# Android 交叉编译门禁（不跑完整 gradle，快速验证 Rust 侧编过）
scripts/android-check.sh
```

## 构建

```bash
pnpm tauri build          # 桌面安装包（deb/AppImage/NSIS）
pnpm tauri android build --apk --target aarch64   # Android APK（需 SDK/NDK）
```

推送到 GitHub 后，[build workflow](.github/workflows/build.yml) 会自动产出三端构建物（Artifacts）。

## 约定

- 本仓库把 pnpm/cargo 缓存重定向到 `.cache/`（已 gitignore），避免污染 `$HOME`。
- Rust 桥接命令位于 `src-tauri/src/`，前端封装位于 `src/lib/`，状态位于 `src/stores/`。

## 许可

见 [LICENSE](LICENSE)。
