#!/usr/bin/env bash
# Lanmark 模拟器调试流程（Android 17 / 16KB 页 / x86_64）。
#
# 用法：
#   scripts/android-emu.sh up        缺 AVD 则建，后台启动无头模拟器，等 boot 完成并断言 PAGE_SIZE=16384
#   scripts/android-emu.sh install   构建 x86_64 debug APK 并安装（--rebuild 强制重建）
#   scripts/android-emu.sh seed      写 config.json + 长笔记，重启 App（启动时自动开库并 reindex）
#   scripts/android-emu.sh probe     adb forward + 跑 scripts/probe-android.mjs（滚动回归，失败退出码非 0）
#   scripts/android-emu.sh all       up → install → seed → probe
#   scripts/android-emu.sh status    设备 / AVD / 转发端口状态
#   scripts/android-emu.sh down      关模拟器
#
# SDK 解析顺序：$ANDROID_SDK_ROOT（须含 emulator/）→ /opt/android-sdk → .cache/android-sdk。
# 踩过的坑都写进 AGENTS.md「模拟器调试」：emulator 要求 <SDK>/platform-tools 存在；
# App 配置在 /data/user/0/<pkg>/config.json；vault 目录必须由 App uid 建（adb push 建的 shell 属主会被 FUSE 拒）。
set -euo pipefail

WS="$(cd "$(dirname "$0")/.." && pwd)"
AVD="${LANMARK_AVD:-lanmark-37-16k}"
IMG="system-images;android-37.0;google_apis_ps16k;x86_64"
PKG="${LANMARK_PKG:-com.lanmark.app.debug}"
VAULT="/storage/emulated/0/Android/data/$PKG/files/lanmark-vault"
NOTE="long-note.md"
PORT="${CDP_PORT:-9222}"
LOGDIR="$WS/.cache/logs"
SHOTDIR="$WS/.cache/screenshots"
mkdir -p "$LOGDIR" "$SHOTDIR" "$WS/.cache/tmp"

die() { echo "android-emu: $*" >&2; exit 1; }

# ── SDK / 工具 ────────────────────────────────────────────────────────────
SDK="${ANDROID_SDK_ROOT:-}"
if [ -z "$SDK" ] || [ ! -x "$SDK/emulator/emulator" ]; then
  if [ -x /opt/android-sdk/emulator/emulator ]; then
    SDK=/opt/android-sdk
  elif [ -x "$WS/.cache/android-sdk/emulator/emulator" ]; then
    SDK="$WS/.cache/android-sdk"
  else
    die "找不到含 emulator/ 的 Android SDK（设 ANDROID_SDK_ROOT=/opt/android-sdk）"
  fi
fi
ADB="${ADB:-$SDK/platform-tools/adb}"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"
[ -n "$ADB" ] && [ -x "$ADB" ] || die "找不到 adb"
EMU="$SDK/emulator/emulator"
AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
[ -x "$EMU" ] || die "$EMU 不存在"
[ -d "$SDK/platform-tools" ] || die "$SDK/platform-tools 缺失：模拟器启动会 FATAL（先 android sdk install platform-tools）"

SERIAL="${SERIAL:-}"
ad() { if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi; }

find_emulator() { "$ADB" devices | awk '$2 == "device" && $1 ~ /^emulator-/ { print $1; exit }'; }

boot_completed() { ad shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' | grep -qx 1; }

wait_boot() {
  local i
  for i in $(seq 1 240); do
    if boot_completed; then return 0; fi
    sleep 1
  done
  return 1
}

ensure_device() {
  if [ -z "$SERIAL" ]; then SERIAL="$(find_emulator)"; fi
  [ -n "$SERIAL" ] || die "没有运行中的模拟器（先 scripts/android-emu.sh up）"
  boot_completed || die "$SERIAL 未 boot 完成"
}

forward_devtools() {
  local pid="$1" i
  ad forward --remove "tcp:$PORT" >/dev/null 2>&1 || true
  for i in 1 2 3; do
    ad forward "tcp:$PORT" "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "adb forward tcp:$PORT 失败（端口被占？）"
}

wait_devtools() {
  local i
  for i in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/json" | grep -q webSocketDebuggerUrl && return 0
    sleep 1
  done
  return 1
}

# 启动 App、等 pid、转发 devtools；成功后把 pid 打到 stdout。
launch_app() {
  ad shell am force-stop "$PKG" >/dev/null 2>&1 || true
  ad shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
  ad shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || die "启动 App 失败"
  local pid="" i
  for i in $(seq 1 60); do
    pid="$(ad shell pidof "$PKG" | tr -d '\r')"
    [ -n "$pid" ] && break
    sleep 1
  done
  [ -n "$pid" ] || die "App 没起来"
  forward_devtools "$pid"
  wait_devtools || die "WebView devtools 没就绪（debug 包才有；检查是否装成 release 包）"
  echo "$pid"
}

# ── 命令 ──────────────────────────────────────────────────────────────────
cmd_up() {
  [ -e /dev/kvm ] || echo "android-emu: 警告：/dev/kvm 不存在，模拟器会极慢或起不来" >&2
  SERIAL="$(find_emulator)"
  if [ -n "$SERIAL" ]; then
    echo "已在运行：$SERIAL"
    wait_boot || die "已有模拟器但 boot 超时"
  else
    if [ ! -f "$HOME/.android/avd/$AVD.avd/config.ini" ]; then
      echo "创建 AVD $AVD（$IMG）…"
      ANDROID_SDK_ROOT="$SDK" ANDROID_USER_HOME="$HOME/.android" \
        "$AVDMANAGER" create avd -n "$AVD" -k "$IMG" -d pixel_7 --force >/dev/null
    fi
    echo "启动 $AVD（无头）… 日志：$LOGDIR/emulator-$AVD.log"
    ANDROID_SDK_ROOT="$SDK" ANDROID_USER_HOME="$HOME/.android" \
      nohup "$EMU" -avd "$AVD" -no-window -no-audio -gpu swiftshader_indirect \
        -no-snapshot -no-boot-anim -no-metrics >"$LOGDIR/emulator-$AVD.log" 2>&1 &
    for i in $(seq 1 120); do
      SERIAL="$(find_emulator)"
      [ -n "$SERIAL" ] && break
      sleep 1
    done
    [ -n "$SERIAL" ] || die "模拟器 120s 内没出现在 adb devices（看 $LOGDIR/emulator-$AVD.log）"
    wait_boot || die "boot 超时（看 $LOGDIR/emulator-$AVD.log）"
  fi
  # 探针要稳定的动画/窗口状态
  ad shell settings put global window_animation_scale 0 >/dev/null 2>&1 || true
  ad shell settings put global transition_animation_scale 0 >/dev/null 2>&1 || true
  ad shell settings put global animator_duration_scale 0 >/dev/null 2>&1 || true
  ad shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  ad shell wm dismiss-keyguard >/dev/null 2>&1 || true
  local page
  page="$(ad shell getconf PAGE_SIZE | tr -d '\r')"
  echo "boot 完成：$SERIAL，PAGE_SIZE=$page"
  [ "$page" = "16384" ] || die "期望 16KB 页镜像，实际 PAGE_SIZE=$page（检查 AVD 是否用了 ps16k 镜像）"
}

cmd_install() {
  ensure_device
  local apk="$WS/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
  if [ "${1:-}" = "--rebuild" ] || [ ! -f "$apk" ]; then
    local pnpm="pnpm"
    command -v pnpm >/dev/null 2>&1 || pnpm="$WS/.cache/bin/pnpm"
    [ -x "$pnpm" ] || [ -n "$(command -v "$pnpm" 2>/dev/null)" ] || die "找不到 pnpm（装 pnpm 或建 .cache/bin/pnpm shim）"
    echo "构建 x86_64 debug APK…"
    # env.sh 会把 ANDROID_HOME 指向 .cache/android-sdk（含 NDK/Gradle 配置），只在本子 shell 生效
    (
      set +u
      # shellcheck disable=SC1091
      source "$WS/scripts/env.sh" >/dev/null
      PATH="$WS/.cache/bin:$PATH" "$pnpm" tauri android build --apk --debug --target x86_64
    )
  fi
  [ -f "$apk" ] || die "构建后仍没有 APK：$apk"
  echo "安装 $(du -h "$apk" | cut -f1) …"
  ad install -r -t "$apk" >/dev/null || die "adb install 失败"
  echo "已安装 $PKG"
}

cmd_seed() {
  ensure_device
  # 1) 固定长笔记（80 节，足够撑出远超一屏的滚动范围）
  node -e '
    const fs = require("node:fs");
    const out = [];
    for (let i = 1; i <= 80; i++) {
      const n = String(i).padStart(2, "0");
      out.push(`## 第 ${n} 节`, "");
      for (let p = 1; p <= 3; p++) {
        out.push(`这是第 ${i} 节的第 ${p} 段。模拟器视口高度约 900 CSS 像素，本节内容用于把文档撑到远超一屏。这是第 ${i} 节的第 ${p} 段，包含一些中文与 English mixed text，以及 \`inline code\` 和**加粗**。这是第 ${i} 节的第 ${p} 段，用来保证每节至少三行，累计高度足够触发滚动。`, "");
      }
    }
    fs.writeFileSync(process.argv[1], out.join("\n"));
  ' "$WS/.cache/$NOTE"

  # 2) config.json：App 在 Android 上读 /data/user/0/<pkg>/config.json（不是 files/）
  printf '{"vaultPath":"%s","syncAuto":false}\n' "$VAULT" > "$WS/.cache/emu-config.json"

  # 3) 配置先落盘：run-as 可以写 App 私有目录 /data/user/0/<pkg>/config.json
  ad push "$WS/.cache/emu-config.json" /data/local/tmp/lm-config.json >/dev/null
  ad shell run-as "$PKG" cp /data/local/tmp/lm-config.json config.json

  # 4) 先启动一次 App，用 App 自己的 IPC 建 vault 目录。
  #    不能用 adb push/run-as 预建：外部存储上 shell 属主的目录会被 FUSE 拒（EACCES）。
  echo "首次启动 App（用于建库目录）…"
  launch_app >/dev/null
  node "$WS/scripts/cdp-eval.mjs" \
    "window.__TAURI_INTERNALS__.invoke('vault_ensure_dir', { path: '$VAULT' })" "$PORT" >/dev/null \
    || die "IPC vault_ensure_dir 失败"
  ad shell test -d "$VAULT" || die "vault 目录没建出来"

  # 5) 笔记放进已存在的 App 属主目录（shell 属主的文件 App 可读，探针只读不写）
  ad push "$WS/.cache/$NOTE" "$VAULT/$NOTE" >/dev/null

  # 6) 重启：启动路径读 config.vaultPath → open_vault_at（含全量 reindex），侧栏就能看到笔记
  echo "重启 App 打开笔记库…"
  launch_app >/dev/null
  echo "种子完成：$VAULT/$NOTE"
}

cmd_probe() {
  ensure_device
  local pid
  pid="$(ad shell pidof "$PKG" | tr -d '\r')"
  [ -n "$pid" ] || die "App 没在跑（先 seed）"
  forward_devtools "$pid"
  wait_devtools || die "WebView devtools 没就绪"
  node "$WS/scripts/probe-android.mjs" --note "$NOTE" --port "$PORT"
  echo "截图：$SHOTDIR/emu-probe-wysiwyg.png、$SHOTDIR/emu-probe-read.png"
}

cmd_status() {
  echo "SDK=$SDK"
  echo "AVD=$AVD（$HOME/.android/avd/$AVD.avd）"
  "$ADB" devices
  SERIAL="$(find_emulator)"
  if [ -n "$SERIAL" ]; then
    echo "PAGE_SIZE=$(ad shell getconf PAGE_SIZE | tr -d '\r')  pid=$(ad shell pidof "$PKG" | tr -d '\r')"
    "$ADB" forward --list
  fi
}

cmd_down() {
  SERIAL="$(find_emulator)"
  [ -n "$SERIAL" ] || { echo "没有运行中的模拟器"; return 0; }
  ad emu kill >/dev/null 2>&1 || true
  for i in $(seq 1 30); do
    [ -z "$(find_emulator)" ] && { echo "已关闭 $SERIAL"; return 0; }
    sleep 1
  done
  echo "已发 kill，但设备仍在（可 adb -s $SERIAL emu kill 再试）" >&2
}

case "${1:-}" in
  up) cmd_up ;;
  install) shift; cmd_install "$@" ;;
  seed) cmd_seed ;;
  probe) cmd_probe ;;
  all)
    cmd_up
    cmd_install
    cmd_seed
    cmd_probe
    ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *)
    sed -n '2,12p' "$0"
    exit 1
    ;;
esac
