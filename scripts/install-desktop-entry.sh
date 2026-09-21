#!/usr/bin/env bash
# 安装用户级桌面入口 + 图标（KDE/GNOME 任务栏、启动器、Alt+Tab 识别 Lanmark）。
#
# 背景：KDE Wayland 的任务栏图标按 app_id 匹配桌面文件（com.lanmark.app.desktop），
# 匹配不上就显示 Wayland 默认图标。本脚本把入口装到 ~/.local（无需 root），
# 图标用 src-tauri/icons/ 里的 Lanmark 图标（scripts/gen-icon.py 生成）。
#
# 用法: scripts/install-desktop-entry.sh [二进制路径]
#       默认 src-tauri/target/release/lanmark（先 pnpm tauri build --no-bundle）
set -e
WS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-$WS/src-tauri/target/release/lanmark}"

if [ ! -x "$BIN" ]; then
  echo "找不到可执行文件: $BIN"
  echo "先构建: (cd $WS && pnpm tauri build --no-bundle)，或把路径作为参数传入"
  exit 1
fi

APPS="$HOME/.local/share/applications"
ICO="$HOME/.local/share/icons/hicolor"
mkdir -p "$APPS" "$ICO/32x32/apps" "$ICO/128x128/apps" "$ICO/256x256/apps" "$ICO/512x512/apps"

cp "$WS/src-tauri/icons/32x32.png"      "$ICO/32x32/apps/lanmark.png"
cp "$WS/src-tauri/icons/128x128.png"    "$ICO/128x128/apps/lanmark.png"
cp "$WS/src-tauri/icons/128x128@2x.png" "$ICO/256x256/apps/lanmark.png"
cp "$WS/src-tauri/icons/icon.png"       "$ICO/512x512/apps/lanmark.png"

# Wayland：任务栏按 app_id（= com.lanmark.app，见 tauri.conf.json 的
# enableGtkAppId）匹配桌面文件 ID → 文件名必须是 com.lanmark.app.desktop。
# X11/XWayland 兜底：StartupWMClass = 二进制名（WM_CLASS instance）。
# 注意 StartupWMClass 只能出现一次（desktop 文件规范禁止重复键）。
cat > "$APPS/com.lanmark.app.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Lanmark
GenericName=Markdown 笔记
Comment=局域网优先的 Markdown 笔记（手机 = 同步中心）
Exec=$BIN
TryExec=$BIN
Icon=lanmark
Terminal=false
Categories=Utility;TextEditor;
Keywords=markdown;notes;笔记;lanmark;
StartupNotify=true
StartupWMClass=lanmark
EOF

# 刷新缓存（尽力而为：GNOME 需要 icon cache，KDE 需要 sycoca；失败不影响安装本身）
gtk-update-icon-cache -f -t "$ICO" 2>/dev/null || true
if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
elif command -v kbuildsycoca5 >/dev/null 2>&1; then
  kbuildsycoca5 --noincremental >/dev/null 2>&1 || true
fi

echo "已安装:"
echo "  $APPS/com.lanmark.app.desktop"
echo "  $ICO/{32x32,128x128,256x256,512x512}/apps/lanmark.png"
echo "重新启动 Lanmark 后，KDE 任务栏/Alt+Tab 应显示 Lanmark 图标；"
echo "若启动器里还没出现，注销重登一次（或跑 kbuildsycoca6）。"
