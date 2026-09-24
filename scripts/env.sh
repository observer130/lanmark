#!/usr/bin/env bash
# Lanmark 构建环境（桌面 + Android）。用法：source scripts/env.sh
# 原则：工具链与缓存统一放在仓库 .cache/（已 gitignore），不污染 $HOME。
# 取脚本自身路径：zsh 下 BASH_SOURCE 为空，若只用它会把 WS 静默解析到「上级目录」，
# 整套缓存就被写到仓库外（zsh 里跑一次即多出 Projects/.cache/{cargo,data,tmp}）。
# 故退回 $0（zsh 会把它设为被 source 的脚本路径），并对结果做一次断言。
_self="${BASH_SOURCE[0]:-$0}"
WS="$(cd "$(dirname "$_self")/.." && pwd)"
if [ ! -d "$WS/src-tauri" ]; then
  echo "env.sh: 仓库根解析失败（算得 $WS，缺 src-tauri）——环境未生效。请 cd 到仓库根后再 source。" >&2
  return 1 2>/dev/null || exit 1
fi

export RUSTUP_HOME="$WS/.cache/rustup"
export CARGO_HOME="$WS/.cache/cargo"

# pnpm v11 store 索引（SQLite）也需要重定向，否则会写 $HOME/.local/share
export XDG_CACHE_HOME="$WS/.cache"
export XDG_DATA_HOME="$WS/.cache/data"
export XDG_CONFIG_HOME="$WS/.cache/config"
export npm_config_cache="$WS/.cache/npm"

# 临时文件也归位到 .cache：本机 /tmp 是仅 10M 的 tmpfs，跑一次 pnpm test 就被 Node 的
# 编译缓存（node-compile-cache）吃掉近 9M，紧接着的 cargo test 里 tempfile::TempDir
# 建 SQLite 会成批报 "disk I/O error"（实测：先测前端再测 Rust，30 项必挂）。
export TMPDIR="$WS/.cache/tmp"
mkdir -p "$TMPDIR"

# Temurin JDK 21（本机 JDK 26 与 Gradle 8.14 不兼容，见 AGENTS.md 硬约定 1）
jdk="$(ls -d "$WS"/.cache/jdk/jdk-21* 2>/dev/null | head -n1)"
if [ -n "$jdk" ]; then
  export JAVA_HOME="$jdk"
fi

# Android SDK / NDK：本机是 curl 手工组的（本网络下 Java 直连 dl.google.com 会被连接重置，
# sdkmanager 拉不下 manifest），缓存/配方见 docs/长效知识.md §5；Java 侧强制 IPv4 见下方 JAVA_TOOL_OPTIONS
if [ -d "$WS/.cache/android-sdk" ]; then
  export ANDROID_HOME="$WS/.cache/android-sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | head -n1)"
  export ANDROID_NDK_HOME="$NDK_HOME"
  export GRADLE_USER_HOME="$WS/.cache/gradle"
  # AGP 的 debug keystore/analytics 写到 ANDROID_USER_HOME（默认 ~/.android，沙箱只读会崩）。
  # 注意：不能同时设已弃用的 ANDROID_SDK_HOME，AGP 会因路径语义冲突直接报错。
  export ANDROID_USER_HOME="$WS/.cache/android-user-home"
  mkdir -p "$ANDROID_USER_HOME"
  # 本网络下 Java 直连 dl.google.com 会被重置（curl 正常）：强制 IPv4 + 阿里云镜像 init 脚本
  export JAVA_TOOL_OPTIONS="-Djava.net.preferIPv4Stack=true"
fi

export PATH="$CARGO_HOME/bin:${JAVA_HOME:+$JAVA_HOME/bin}:$ANDROID_HOME/platform-tools:$PATH"

echo "lanmark env → WS=$WS | TMPDIR=${TMPDIR:-unset} | cargo=$(command -v cargo) | JAVA_HOME=${JAVA_HOME:-unset} | ANDROID_HOME=${ANDROID_HOME:-unset} | NDK_HOME=${NDK_HOME:-unset}"
