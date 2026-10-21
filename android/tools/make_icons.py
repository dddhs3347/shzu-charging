#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_icons.py — 从一张 1024 设计稿生成 App 全部图标（Android 各密度 + PWA）

设计稿是 `android/tools/icon-source.png`：1024×1024 黑底，中间一块绿色圆角方 +
黑色闪电，底部还有一行白色 "shzucharge.xyz" 水印（宣传图才有，图标不要）。

所以本脚本做三件事：

  1. 自动找出绿色圆角方的外接矩形（按颜色判定，不写死坐标，换稿也能跑）；
  2. 裁掉水印、只留圆角方；
  3. 按用途套不同形状的遮罩，输出全部尺寸：
       android/res/mipmap-*/ic_launcher.png        圆角方 + 透明角（各启动器都好看）
       android/res/mipmap-*/ic_launcher_round.png  正圆遮罩（圆形启动器）
       android/res/drawable/ic_launcher_big.png    512 通知/关于页大图
       app/icons/icon-192.png / icon-512.png       PWA / 网页 favicon
       docs/icon-1024.png                          仓库 README 用

用法（需要 Pillow，只在开发机上跑；仓库里的 PNG 是已经生成好的）：

    python android/tools/make_icons.py
    python android/tools/make_icons.py --source 别的稿.png --dry-run
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install Pillow（只在生成图标时需要，运行时不需要）")

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_SOURCE = os.path.join(REPO, "android", "tools", "icon-source.png")

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# 圆角半径占边长比例（设计稿量出来约 0.23）
CORNER_RATIO = 0.23
SS = 4  # 超采样倍数，避免缩放锯齿


def find_green_square(im):
    """返回绿色圆角方的外接矩形；找不到就报错退出。"""
    w, h = im.size
    px = im.load()
    xs = []
    ys = []
    step = max(1, w // 512)
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y][:3]
            if g > 120 and g - r > 60 and g - b > 40:
                xs.append(x)
                ys.append(y)
    if not xs:
        sys.exit("设计稿里找不到绿色圆角方，路径/配色对吗？")
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def crop_square(im):
    """裁出圆角方（外扩一点点，避免把边缘切掉）。"""
    box = find_green_square(im)
    pad = 2
    return im.crop((max(0, box[0] - pad), max(0, box[1] - pad),
                    min(im.size[0], box[2] + pad), min(im.size[1], box[3] + pad)))


def rounded_mask(size, radius_ratio):
    """圆角方遮罩（超大画再缩，边缘才平滑）。"""
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(big * radius_ratio), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def circle_mask(size):
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def render(square, size, shape):
    """把裁好的圆角方缩到 size 并套遮罩，返回 RGBA。"""
    body = square.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = circle_mask(size) if shape == "circle" else rounded_mask(size, CORNER_RATIO)
    body.putalpha(mask)
    return body


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--dry-run", action="store_true", help="只打印目标路径，不写文件")
    args = ap.parse_args(argv)

    if not os.path.exists(args.source):
        sys.exit("设计稿不存在：%s" % args.source)
    src = Image.open(args.source)
    if src.mode not in ("RGB", "RGBA"):
        src = src.convert("RGB")
    if src.size[0] != src.size[1]:
        print("提示：设计稿不是正方形（%dx%d），按绿色方块裁" % src.size)
    square = crop_square(src)
    print("绿色圆角方裁出：%dx%d" % square.size)

    todo = []
    for name, size in DENSITIES.items():
        todo.append(("android/res/mipmap-%s/ic_launcher.png" % name, size, "rounded"))
        todo.append(("android/res/mipmap-%s/ic_launcher_round.png" % name, size, "circle"))
    todo.append(("android/res/drawable/ic_launcher_big.png", 512, "rounded"))
    todo.append(("app/icons/icon-192.png", 192, "rounded"))
    todo.append(("app/icons/icon-512.png", 512, "rounded"))
    todo.append(("docs/icon-1024.png", 1024, "rounded"))

    for rel, size, shape in todo:
        path = os.path.join(REPO, rel)
        if args.dry_run:
            print("  [dry-run] %s (%d, %s)" % (rel, size, shape))
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        render(square, size, shape).save(path, "PNG", optimize=True)
        print("  ✓ %s (%d, %s)" % (rel, size, shape))
    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))