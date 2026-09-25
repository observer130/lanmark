#!/usr/bin/env python3
"""生成 Lanmark 应用图标全套（src-tauri/icons/ 下的位图）。

设计：「行与句点」——浅灰渐变圆角方块上四条蓝色圆头横线（第二行弱化衬行）
+ 琥珀色句点。几何参数与配色和 src-tauri/icons/icon.svg 逐一对应（512 视箱）：
  底 #F9FAFB→#F5F6F8 渐变，rx=118；描边 #E3E5E7 w=2.5；
  行 #3061D8：(102,119,224,52,r26) (102,217,308,34,r17,α.14)
             (102,285,224,34,r17) (102,353,152,34,r17)；
  句点 #F0C781：圆心 (308,370) r=23。
历史：v0.3.0 前的旧版是「靛蓝圆角方块 + 白 L」（oklch 换算 --c-acc + Noto Sans），
a6a5a13 换图标后本脚本曾漏改——重跑会把新图覆盖回旧 L，现与 SVG 设计源对齐。

只写位图（png/ico/icns/Store 资产）；SVG 变体（icon*.svg）与
src-tauri/gen/android 的自适应 mipmap 是手工维护的，本脚本不碰。

用法: python3 scripts/gen-icon.py （需要 Pillow）
"""
import io
import pathlib
import struct

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

# icon.svg 的 512 视箱几何（x, y, w, h, r, α），乘 size/512 等比缩放
BARS = [
    (102, 119, 224, 52, 26, 1.0),    # 标题行（粗）
    (102, 217, 308, 34, 17, 0.14),   # 衬行（弱化）
    (102, 285, 224, 34, 17, 1.0),
    (102, 353, 152, 34, 17, 1.0),
]
DOT = (308, 370, 23)                 # 句点（cx, cy, r）
BG_TOP, BG_BOTTOM = (0xF9, 0xFA, 0xFB), (0xF5, 0xF6, 0xF8)
BLUE, GOLD, EDGE = (0x30, 0x61, 0xD8), (0xF0, 0xC7, 0x81), (0xE3, 0xE5, 0xE7)
CORNER = 118 / 512                   # 底板圆角比例
STROKE_W = 2.5                       # 发丝描边宽（512 视箱）
SS = 4                               # 超采样倍率（Pillow 圆角矩形无抗锯齿）

MASTER = 1024


def _v_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """size×size 垂直线性渐变（逐行插值）。"""
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        d.line([(0, y), (size, y)], fill=c)
    return img


def draw_icon(size: int) -> Image.Image:
    """size×size 的完整图标（浅底圆角方块 + 行与句点，四角透明）。"""
    s = size * SS / 512
    big = size * SS

    # 底板：渐变透过圆角矩形蒙版
    img = _v_gradient(big, BG_TOP, BG_BOTTOM).convert("RGBA")
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=round(CORNER * big), fill=255
    )
    img.putalpha(mask)

    # 行与句点：画在独立 RGBA 层再合成，弱化衬行（α=.14）与 SVG 的
    # opacity 混合语义一致（对局部渐变底逐像素叠加，不做预混近似）
    overlay = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for x, y, w, h, r, alpha in BARS:
        od.rounded_rectangle(
            [x * s, y * s, (x + w) * s, (y + h) * s],
            radius=r * s,
            fill=BLUE + (round(alpha * 255),),
        )
    cx, cy, r = DOT
    od.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=GOLD + (255,))
    img = Image.alpha_composite(img, overlay)

    # 发丝描边：小尺寸下不足 1px，跳过
    stroke = round(STROKE_W * s)
    if stroke >= 1:
        ImageDraw.Draw(img).rounded_rectangle(
            [stroke // 2, stroke // 2, big - 1 - stroke // 2, big - 1 - stroke // 2],
            radius=round(CORNER * big) - stroke // 2,
            outline=EDGE,
            width=stroke,
        )

    return img.resize((size, size), Image.LANCZOS)


def write_icns(out: pathlib.Path) -> None:
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
        buf = io.BytesIO()
        draw_icon(size).save(buf, "PNG")
        data = buf.getvalue()
        chunks += code + struct.pack(">I", len(data) + 8) + data
    out.write_bytes(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


def main() -> None:
    ICONS.mkdir(exist_ok=True)

    # Tauri/Linux 用
    for name, size in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ]:
        draw_icon(size).save(ICONS / name)

    # Windows（ico 多尺寸，从 1024 master 缩）
    draw_icon(MASTER).save(
        ICONS / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    # macOS（工程不发布 mac，但保持图标不再是最旧的 Tauri 默认）
    write_icns(ICONS / "icon.icns")

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
