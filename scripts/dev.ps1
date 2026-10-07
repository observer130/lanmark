# Windows 一键 tauri dev：先激活 .cache 工具链（cargo + MSVC），再转发 pnpm tauri dev。
# 用法: pnpm tauri:dev            （等价于下面两步的手工版：）
#       . .\scripts\env.ps1 ; pnpm tauri dev
# Linux 用户不受影响：继续 `source scripts/env.sh && pnpm tauri dev`。
. (Join-Path $PSScriptRoot "env.ps1")

# 本机安全软件会拦截未签名 dev exe 读写 %LOCALAPPDATA%\com.lanmark.app（WebView2
# 用户数据目录报 0x800700AA / 0x8000FFFF，日志写入报 os error 5；安装版因签名/信誉
# 背书不受影响）。dev 把 WebView2 profile 指到仓库 .cache（WebView2 官方环境变量，
# tauri/wry 尊重之）；日志已由 lib.rs 在 debug 构建落到 .cache/logs。
# 已验证：指到 .cache 后窗口正常创建；release/CI 完全不受影响。
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $PSScriptRoot "..\.cache\webview-profile"

pnpm tauri dev @args
