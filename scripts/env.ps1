# Lanmark Windows 构建环境（PowerShell 等价物，zsh/bash 用户继续用 scripts/env.sh）。
# 与 env.sh 同一原则：工具链与缓存一律在仓库 .cache/，不污染 $HOME（硬约定 1）。
# 用法：在 pwsh 中 `. D:\Projects\lanmark\scripts\env.ps1`，或让自动化直接 dot-source。
#
# 内容：
#   - cargo/rustup（.cache\cargo、.cache\rustup）
#   - MSVC 工具链环境（vs-buildtools 里的 vcvars64 捕获：INCLUDE/LIB/PATH）
#   - TMP/TEMP 指向 .cache\tmp（沙箱与临时文件归位）
# 本脚本不做任何安装；安装步骤见 AGENTS.md「Windows 本机构建」。

$ErrorActionPreference = "Stop"
$ws = Split-Path -Parent $PSScriptRoot  # scripts/ 的上级 = 仓库根

# ── Rust（rustup/cargo 固定在 .cache）──
$env:CARGO_HOME = "$ws\.cache\cargo"
$env:RUSTUP_HOME = "$ws\.cache\rustup"
$env:PATH = "$ws\.cache\cargo\bin;$env:PATH"

# ── 临时文件归位 ──
$env:TMP = "$ws\.cache\tmp"
$env:TEMP = "$ws\.cache\tmp"

# ── MSVC 环境（从 vs-buildtools 捕获 vcvars64；缓存到 .cache 供增量复用）──
$vcvarsCache = "$ws\.cache\vcvars64.env"
if (-not (Test-Path $vcvarsCache)) {
    $vcvars = Get-ChildItem "$ws\.cache\vs-buildtools\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue
    if ($vcvars) {
        New-Item -ItemType Directory -Force -Path "$ws\.cache" | Out-Null
        # vcvars64.bat 是 cmd 批处理：借 cmd /v 延迟展开把 set 结果导出来
        $cmd = "`"$($vcvars.FullName)`" >NUL && set"
        $out = & cmd.exe /c $cmd 2>$null
        [IO.File]::WriteAllLines($vcvarsCache, $out)
    }
}
if (Test-Path $vcvarsCache) {
    foreach ($line in Get-Content $vcvarsCache) {
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            Set-Item -Path "env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

# ── 摘要 ──
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
$link = Get-Command link.exe -ErrorAction SilentlyContinue
Write-Host "lanmark env (pwsh) → cargo=$($cargo.Source) | link=$($link.Source) | TMP=$env:TMP"
