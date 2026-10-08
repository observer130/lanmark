# 内置字体与许可（M6d）

Lanmark 的编辑区字体**随应用内置**（不依赖系统字体），以保证三端字形一致（docs/09 §4.7）。
字体经 npm 包引入，版本在 `package.json` 里**钉死**（字体包的目录结构/切片范围会随大版本变）：

| 字体 | 用途 | npm 包 | 许可 | 版权 |
|---|---|---|---|---|
| **MiSans** 400/600 | 晨窗、夜航（正文 + 标题） | `misans@5.0.0`（Normal 切片） | 小米《MiSans 字体知识产权许可协议》——见 `MiSans-EULA.txt` | © 小米科技 |
| **Noto Serif SC** 400/600 | 纸页（正文 + 标题） | `@fontsource/noto-serif-sc@5.2.5` | SIL OFL 1.1——见 `OFL-1.1.txt` / `Noto-Serif-SC-NOTICE.txt` | © Google |
| **LXGW WenKai Screen GB** 400 | 文楷（正文） | `lxgw-wenkai-screen-webfont@1.7.0` | SIL OFL 1.1——见 `OFL-1.1.txt` | © LXGW（霞鹜） |
| **JetBrains Mono** 400/700 | 等宽（源码模式 / 代码块） | `@fontsource/jetbrains-mono@5.2.5` | SIL OFL 1.1——见 `OFL-1.1.txt` | © JetBrains s.r.o. |

> 说明：`@fontsource/*` 包内附的 LICENSE 是同一份 OFL 模板（署名写的是 Google Inc.），
> 对 JetBrains Mono 而言署名不准；上表的版权归属以字体上游为准，OFL 全文见 `OFL-1.1.txt`。

## 必须遵守的义务

1. **MiSans 须在使用它的软件中注明**（小米协议第 1 条）——已在应用「设置 → 关于」页列出字体来源；
   删掉那行即违约。
2. **不得改编或二次开发 MiSans 字体**，也不得**单独**分发/售卖字体文件本身（随 App 分发是明确允许的）。
   —— 因此**不要**对 `node_modules/misans` 里的 woff2 做子集化/改名再提交；要裁剪体积请换字体或换分发源。
3. OFL 三款：保留版权与许可声明（本目录）、不得单独出售字体文件；随应用分发、嵌入均允许。
4. 字体文件**不入库**（走 npm 依赖）；本目录只放许可文本与出处，随仓库分发。

## 构建期处理

`vite.config.ts` 的 `stripWoffFallback()` 会剥掉 `@fontsource` CSS 里的 `woff` 回退
（每个切片同时引 woff2 + woff，实测多出 226 个 `.woff` ≈ 7.7MB；三端 WebView 都支持 woff2）。
