# 分支与发布说明

Lanmark 的分支模型、发版流程与 Release Notes 规范。**命令、门禁与平台细节以 `AGENTS.md` 为准**，本文只固化「怎么走流程」与「怎么写信」。

---

## 分支模型

| 分支 | 角色 | 规则 |
|---|---|---|
| `master` | 发布快照 | 只在发版时前进，不在其上开发或直接提交 |
| `dev` | 集成分支 | 日常验收通过的改动都合到这里；已推送后不再 rebase |
| `feat/<主题>` `fix/<主题>` `chore/<主题>` | 改动分支 | 一律从 `dev` 拉出，验收通过后 `--no-ff` 合回 `dev` |
| `release/v<版本>` | 发版分支 | 从 `dev` 拉出，只放版本号提升与发布说明；`--no-ff` 合回 `dev`，再由 `dev` 合入 `master` |

要点：

- **合入一律 `--no-ff`**，保留分支边界；`git switch dev && git merge --no-ff <branch>`。
- **已推送的 `dev` / `master` 不 rebase**：会改写别人已拉取的基点，冲突只能靠合并解决。
- **并行开发用 worktree**，放 `.cache/wt/<topic>`，不要来回切脏工作区：
  ```bash
  git worktree add .cache/wt/<topic> -b fix/<topic> dev
  ```
  `git branch` 里带 `+` 的分支表示正被某个 worktree 检出；这类分支在 worktree 移除前删不掉（git 拒绝删除已检出的分支）。收尾顺序：
  ```bash
  git worktree remove .cache/wt/<topic> && git branch -d fix/<topic>
  ```
- `dev` 稳定后再合 `master`；`master` 前进后把 `dev` 快进对齐（见发版第 7 步）。

---

## 发版流程

前提：`dev` 已通过验收，门禁全绿（`pnpm test`、`cargo test`，见 `AGENTS.md` 的「完成标准」）。

1. **拉发版分支**：`git switch -c release/v<版本> dev`。
2. **同一提交里提升四处版本号**（前三处是 `preflight` 的硬校验，缺一处 CI 直接 fail；`Cargo.lock` 不校验，但漏了会在下次 cargo 构建时被改写）：

   | 文件 | 字段 |
   |---|---|
   | `package.json` | `.version` |
   | `src-tauri/tauri.conf.json` | `.version` |
   | `src-tauri/Cargo.toml` | `[package] version` |
   | `src-tauri/Cargo.lock` | `lanmark` 包的 `version` |

   提交信息：`chore(release): 版本号升至 <版本>`。
   `pnpm-lock.yaml` 不含根版本号，无需改动。
3. **写发布说明**：`.cache/release-notes/v<版本>.md`，格式见下一节。
   不要写进 `dist/`——那是 Vite 的输出目录，`pnpm build` 会整个清空。
4. **合入**：`release/v<版本>` `--no-ff` → `dev`，`dev` `--no-ff` → `master`，推送 `master`。
5. **建 Release（先正文）**：
   ```bash
   gh release create v<版本> --title "v<版本>" \
     --notes-file .cache/release-notes/v<版本>.md
   # 预发布加 --prerelease：不进 releases/latest，更新器不会向用户提示
   ```
   `gh` 会先建草稿、再发布；发布动作在远端写入**轻量 tag**（落在 `master` 的 HEAD），Release 页带着正文出现，同时触发 `release.yml` 的 `push` 事件。
6. **对齐本地 tag**：
   ```bash
   git tag v<版本> && git push origin v<版本>
   ```
   远端已有同值 tag，这一步正常是 no-op（`Everything up-to-date`）。**若被拒**，说明本地 `master` 与远端不一致、tag 指向了别的提交——停下来查，不要加 `-f`。
   CI 侧先跑 `preflight`（tag 必须等于 `package.json` / `tauri.conf.json` / `Cargo.toml` 三处版本号），再三端并行构建、把 5 个资产挂到这个 Release 上。
7. **发布后**：`git switch dev && git merge --ff-only master && git push origin dev`，让 `dev` 与发布快照对齐。

**为什么 tag 是轻量、且必须先建 Release：**

- `gh release create` 会自动建 tag；此时远端已存在同名轻量 tag，再把本地换成 annotated tag 推送会被拒（`! [rejected] ... (already exists)`）。想改 annotated 必须先推 tag、再建 Release，而那样 CI 会在正文写好之前跑完。
- `release.yml` 的 Windows job 会把 Release 正文前 500 字符写进 `latest.json`（`release.yml` 里 `gh release view --json body`），作为更新器弹窗文案。正文晚于构建，用户看到的就是空文案。

**出错时**：

- 某个 job 红了 → 修好后 `gh run rerun <run-id>`。同一 tag 的 run 是串行的（`concurrency`），不会有两个 run 抢着写 `latest.json`。
- tag 已发出但版本内容有误 → **不要删 tag 重推**。更新器按 `latest.json` 判版本，重推同一版本号会让已升级的用户收不到修复；直接发下一个补丁版本。
- Release 页只有正文、没有资产 → 说明 `release.yml` 没跑起来或半途失败，看 Actions 页面，不要手工上传（签名与 `latest.json` 的 URL 都由 CI 现算）。

**发布资产**（共 5 个，均不得缺失）：`lanmark-linux-x64.tar.gz` + `.sig`、`Lanmark_<版本>_x64-setup.exe`、`lanmark-android-aarch64.apk`、`latest.json`。deb / AppImage / msi 不进 release。

---

## Release Notes 规范

- **正文不写 H1**，也不写版本号标题（如 `## v0.8.1`）：版本号由 tag 与 Release 标题承载，正文直接从一句话概述开始。
- **首段是一句话概述**，说明这一版的重心（如「本版是 Android 打包修复，功能与 v0.8.0 相同」）。它会进入更新器弹窗，务必简短。
- **分类固定四个**，没有内容的分类直接省略：

  | 分类 | 收什么 |
  |---|---|
  | `### 新增功能` | 用户可感知的新能力 |
  | `### 体验优化` | 行为、性能、交互的改进 |
  | `### 问题修复` | 修掉的缺陷 |
  | `### 其他变更` | 构建、依赖、文档等用户影响小但需告知的改动 |

- 分类标题用 `###`；**条目按影响从大到小排序**，每条**一句话**，不加句号。
- 外部贡献者在条目末尾以 ` @handle` 标注。
- **tag、Release 标题、说明文件名三者一致**，统一为 `v<版本>`：tag `v0.8.2`、标题 `v0.8.2`、文件 `v0.8.2.md`。

模板：

```markdown
本版集中修复同步方向的问题，未引入新功能。

### 问题修复

- 清单读取失败时整轮报错，不再静默跳过单个笔记
- 冲突副本按 mtime 裁决后保留在可见路径

### 其他变更

- 升级 `tauri-runtime-wry` 并重放 `patches/` 补丁
```

