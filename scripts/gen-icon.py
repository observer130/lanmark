#!/usr/bin/env python3
"""生成 Lanmark 应用图标全套（src-tauri/icons/）。

设计：靛蓝圆角方块 + 白色粗体「L」——与侧栏内 logo（bg-accent 圆角 + 白 L）一致。
色值由 src/index.css 的 --c-acc（oklch(0.53 0.19 264)）换算成 sRGB。
用法: python3 scripts/gen-icon.py （需要 Pillow + Noto Sans Bold）
"""
import io
import math
import struct
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

# ── oklch(0.53 0.19 264) → sRGB（Björn Ottosson 的 OKLab 矩阵） ──────────────
def oklch_to_srgb(L: float, C: float, h_deg: float):
    h = math.radians(h_deg)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    r = +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
    g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
    bb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_

    def gam(x):
        x = max(0.0, min(1.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055

    return tuple(round(gam(v) * 255) for v in (r, g, bb))


ACCENT = oklch_to_srgb(0.53, 0.19, 264)
FONT = "/usr/share/fonts/noto/NotoSans-Bold.ttf"
MASTER = 1024


def draw_icon(size: int) -> Image.Image:
    """在 size×size 画布上画图标（内容按 1024 master 等比缩放）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = round(size * 0.285)  # 与侧栏 logo 的 rounded-lg（8/28）一致
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=ACCENT + (255,))

    # 白色「L」：按 cap 高度光学居中（L 的 bbox 底部到基线即 cap，直接按 bbox 居中即可）
    font = ImageFont.truetype(FONT, round(size * 0.60))
    x0, y0, x1, y1 = font.getbbox("L")
    w, h = x1 - x0, y1 - y0
    d.text(
        ((size - w) / 2 - x0, (size - h) / 2 - y0 - size * 0.008),
        "L",
        font=font,
        fill=(255, 255, 255, 255),
    )
    return img


def write_icns(master: Image.Image, out: pathlib.Path) -> None:
    """手写 ICNS 容器（各尺寸块直接内嵌 PNG，macOS 10.15+ 均支持）。"""
    entries = [
        (b"icp4", 16),   # 16
        (b"icp5", 32),   # 32
        (b"ic07", 128),  # 128
        (b"ic08", 256),  # 256
        (b"ic09", 512),  # 512
    ]
    chunks = b""
    for code, size in entries:
        png = draw_icon(size)
        buf = io.BytesIO()
        png.save(buf, "PNG")
        data = buf.getvalue()
        chunks += code + struct.pack(">I", len(data) + 8) + data
    out.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main() -> None:
    ICONS.mkdir(exist_ok=True)
    print("accent =", "#%02x%02x%02x" % ACCENT)

    master = draw_icon(MASTER)

    # Tauri/Linux 用
    for name, size in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ]:
        draw_icon(size).save(ICONS / name)

    # Windows（ico 多尺寸）
    master.save(ICONS / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    # macOS（工程不发布 mac，但保持图标不再是最旧的 Tauri 默认）
    write_icns(master, ICONS / "icon.icns")

    # Windows Store 资产（沿用现有文件名/尺寸）
    for name in [
        "StoreLogo.png", "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png",
        "Square89x89Logo.png", "Square107x107Logo.png", "Square142x142Logo.png",
        "Square150x150Logo.png", "Square284x284Logo.png", "Square310x310Logo.png",
    ]:
        path = ICONS / name
        if path.exists():
            size = Image.open(path).size[0]
            draw_icon(size).save(path)

    print("written to", ICONS)


if __name__ == "__main__":
    main()
