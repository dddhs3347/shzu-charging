#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_icons.py — 从设计稿图标包生成 App 全部图标（Android 各密度 + PWA）

设计稿的自适应图标对用的是「挖空」做法，这一点是理解全部代码的前提：

  ic_launcher_foreground.png = 绿色圆角方，**闪电处 alpha=0**（挖空）
  ic_launcher_background.png = 纯黑

也就是说闪电不是画上去的黑像素，而是「背景的黑从绿色里漏出来」。所以想要闪电
的轮廓，不能去找深色像素（会一个都找不到），必须把透明区域分成两类：

  1. 圆角方**外面**的透明 —— 从四个角泛洪填充可达
  2. 圆角方**里面**的透明 —— 闪电孔，泛洪填充不可达

本脚本用 Pillow 的 floodfill 做这个区分，再据此合成三种图标：

  android/res/mipmap-*/ic_launcher.png        透明底 + 黑填底圆角方（92% 占比）
  android/res/mipmap-*/ic_launcher_round.png  绿圆 + 黑闪电（满幅，圆角启动器）
  android/res/drawable/ic_launcher_big.png    512，黑底 + 圆角方（86%）
  app/icons/icon-192.png / icon-512.png       黑底 + 圆角方（84%，PWA maskable 安全区）

用法（需要 Pillow，只在开发机上跑；仓库里的图标是已经生成好的 PNG）：

    python android/tools/make_icons.py --pack "C:/path/to/logo-shzu-charging/final/pack"
    python android/tools/make_icons.py            # 用默认设计稿路径
"""
import argparse
import os
import sys
from collections import Counter

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install Pillow（只在生成图标时需要，运行时不需要）")

DEFAULT_PACK = (r"C:\Users\Administrator\WorkBuddy AI\2026-10-21-04-35-48"
                r"\logo-shzu-charging\final\pack")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# 圆角方在各用途下的占比：APK 启动器 92%、大图 86%、PWA maskable 84%（留安全区）
FILL_LAUNCHER = 0.92
FILL_BIG = 0.86
FILL_WEB = 0.84


def build_bolt_and_squircle(pack_dir):
    """返回 (圆角方 RGBA 图, 闪电 mask, 品牌绿 RGB)。"""
    fg = Image.open(os.path.join(pack_dir, "android", "ic_launcher_foreground.png")).convert("RGBA")
    W, H = fg.size
    alpha = fg.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        sys.exit("前景图全透明，路径不对？%s" % pack_dir)

    # 1) 透明区分成「外面」和「闪电孔」：从左上角泛洪填充，可达的是外面
    transparent = Image.new("L", (W, H), 0)
    transparent.paste(255, (0, 0, W, H), alpha.point(lambda v: 255 if v < 128 else 0))
    ImageDraw.floodfill(transparent, (0, 0), 128, thresh=0)
    tpx = transparent.load()
    hole = Image.new("L", (W, H), 0)
    hpx = hole.load()
    for y in range(H):
        for x in range(W):
            if tpx[x, y] == 255:      # 透明、且从边界到不了 -> 闪电孔
                hpx[x, y] = 255
    if not hole.getbbox():
        sys.exit("没找到闪电孔，前景图可能不是「挖空」版本")

    # 2) 品牌绿取前景图里出现最多的饱和绿
    px = fg.load()
    greens = Counter()
    for y in range(bbox[1], bbox[3], 3):
        for x in range(bbox[0], bbox[2], 3):
            r, g, b, a = px[x, y]
            if a > 200 and g > 120 and g > r + 40:
                greens[(r, g, b)] += 1
    brand = greens.most_common(1)[0][0]

    # 3) 圆角方：先按 alpha 填黑，再盖上前景（闪电孔就透出黑的）
    squircle = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    squircle.paste((0, 0, 0, 255), (0, 0, W, H), alpha)
    squircle.alpha_composite(fg)
    return squircle.crop(bbox), hole.crop(hole.getbbox()), brand


def squircle_icon(sq, size, fill_ratio, bg):
    canvas = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    target = int(size * fill_ratio)
    off = (size - target) // 2
    canvas.alpha_composite(sq.resize((target, target), Image.LANCZOS), (off, off))
    return canvas


def round_icon(bolt, brand, size):
    ss = 4                                   # 超采样，圆边才干净
    big = size * ss
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).ellipse((0, 0, big - 1, big - 1), fill=brand + (255,))
    bh = int(big * 0.50)
    bw = max(1, int(round(bh * (bolt.size[0] / float(bolt.size[1])))))
    mask = bolt.resize((bw, bh), Image.LANCZOS)
    lay = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    lay.paste((0, 0, 0, 255), (0, 0), mask)
    canvas.alpha_composite(lay, ((big - bw) // 2, (big - bh) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", default=DEFAULT_PACK, help="设计稿 pack 目录")
    ap.add_argument("--repo", default=REPO, help="仓库根目录")
    args = ap.parse_args()

    if not os.path.isdir(args.pack):
        sys.exit("找不到设计稿目录：%s" % args.pack)
    sq, bolt, brand = build_bolt_and_squircle(args.pack)
    print("圆角方 %dx%d，闪电 %dx%d，品牌绿 #%02X%02X%02X"
          % (sq.size[0], sq.size[1], bolt.size[0], bolt.size[1], brand[0], brand[1], brand[2]))

    for dpi, sz in DENSITIES.items():
        d = os.path.join(args.repo, "android", "res", "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        squircle_icon(sq, sz, FILL_LAUNCHER, None).save(
            os.path.join(d, "ic_launcher.png"), "PNG", optimize=True)
        round_icon(bolt, brand, sz).save(
            os.path.join(d, "ic_launcher_round.png"), "PNG", optimize=True)
        print("  mipmap-%-7s %dx%d" % (dpi, sz, sz))

    squircle_icon(sq, 512, FILL_BIG, (0, 0, 0, 255)).save(
        os.path.join(args.repo, "android", "res", "drawable", "ic_launcher_big.png"),
        "PNG", optimize=True)
    print("  drawable/ic_launcher_big.png 512")

    for sz in (192, 512):
        squircle_icon(sq, sz, FILL_WEB, (0, 0, 0, 255)).save(
            os.path.join(args.repo, "app", "icons", "icon-%d.png" % sz), "PNG", optimize=True)
        print("  app/icons/icon-%d.png" % sz)
    print("完成")


if __name__ == "__main__":
    main()