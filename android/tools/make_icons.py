#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_icons.py — 从一张 1024 设计稿生成 App 全部图标（Android 各密度 + PWA）

设计稿是 `android/tools/icon-source.png`：**整张都要用** —— 黑底 + 绿色圆角方 +
黑色闪电 + 底部一行白色 "shzucharge.xyz"。2026-10-22 用户明确要求「黑色背景和
下面的文字都要保留」，所以不再裁掉水印、也不再只取绿色方块。

做法：
  1. 按亮度找出「非黑内容」的外接矩形（绿方块 + 文字整体的包围盒），
     以它为中心裁成正方形、四周留 8% 边距 —— 黑底保留，文字和方块一起留下；
  2. 方图标（桌面/通知/PWA any）直接用这张裁好的图，满幅黑底不透明；
  3. 圆图标（圆形启动器）把整张稿缩到 90% 居中放黑底再套正圆遮罩 ——
     内容整体落在圆内，文字不会被切；
  4. maskable 图标（安卓把 PWA 装成 App 时用）缩到 80%，保证内容全在
     安全区圆内，四角被裁也不丢东西。

输出：
    android/res/mipmap-*/ic_launcher.png        方图标（黑底满幅）
    android/res/mipmap-*/ic_launcher_round.png  圆图标
    android/res/drawable/ic_launcher_big.png    512 通知/关于页大图
    app/icons/icon-192.png / icon-512.png       PWA / 网页 favicon（any）
    app/icons/icon-maskable-512.png             PWA maskable
    docs/icon-1024.png                          仓库 README 用（原稿未裁）

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

# 非黑内容判定：三通道之和超过这个值就算「有东西」
CONTENT_THRESHOLD = 40
# 方图标：内容包围盒向外留的边距比例（每边）
SQUARE_PAD_RATIO = 0.08
# 圆图标：整张稿缩到多少再套圆（内容最远点到中心约 0.97 半径，缩 0.90 后安全）
ROUND_SHRINK = 0.90
# maskable：内容必须落在直径 80% 的安全圆内
MASKABLE_SHRINK = 0.80
SS = 4  # 超采样倍数，画圆用


def content_box(im):
    """返回非黑内容的外接矩形 (l, t, r, b)；找不到就报错退出。"""
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            if r + g + b > CONTENT_THRESHOLD:
                if x < minx:
                    minx = x
                if y < miny:
                    miny = y
                if x > maxx:
                    maxx = x
                if y > maxy:
                    maxy = y
    if maxx < 0:
        sys.exit("设计稿是全黑的？路径/图片对吗？")
    return (minx, miny, maxx + 1, maxy + 1)


def square_crop(im, box):
    """以内容包围盒为中心裁正方形，四周留 SQUARE_PAD_RATIO 的边距（黑底保留）。"""
    w, h = im.size
    cx = (box[0] + box[2]) / 2.0
    cy = (box[1] + box[3]) / 2.0
    side = max(box[2] - box[0], box[3] - box[1]) * (1.0 + 2.0 * SQUARE_PAD_RATIO)
    side = min(side, min(w, h))
    left = cx - side / 2.0
    top = cy - side / 2.0
    # 超出原图就往里挪，保证裁的是原图内的正方形
    left = max(0.0, min(left, w - side))
    top = max(0.0, min(top, h - side))
    return im.crop((int(round(left)), int(round(top)),
                   int(round(left + side)), int(round(top + side))))


def background_color(im):
    """取左上角像素当背景色（这份稿的黑底不是纯 0,0,0）。"""
    r, g, b = im.getpixel((2, 2))[:3]
    return (r, g, b, 255)


def circle_mask(size):
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def render_square(cropped, size):
    """方图标：裁好的图直接缩放，满幅不透明。"""
    return cropped.resize((size, size), Image.LANCZOS).convert("RGBA")


def render_round(src, size, bg):
    """圆图标：整张稿缩到 ROUND_SHRINK，居中放黑底，再套正圆遮罩。"""
    inner = max(1, int(round(size * ROUND_SHRINK)))
    body = Image.new("RGBA", (size, size), bg)
    body.paste(src.resize((inner, inner), Image.LANCZOS).convert("RGBA"),
               ((size - inner) // 2, (size - inner) // 2))
    body.putalpha(circle_mask(size))
    return body


def render_maskable(src, size, bg):
    """maskable：整张稿缩到 MASKABLE_SHRINK，居中放黑底（方图不透明）。"""
    inner = max(1, int(round(size * MASKABLE_SHRINK)))
    body = Image.new("RGBA", (size, size), bg)
    body.paste(src.resize((inner, inner), Image.LANCZOS).convert("RGBA"),
               ((size - inner) // 2, (size - inner) // 2))
    return body


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--dry-run", action="store_true", help="只打印目标路径，不写文件")
    args = ap.parse_args(argv)

    if not os.path.exists(args.source):
        sys.exit("设计稿不存在：%s" % args.source)
    src = Image.open(args.source)
    if src.mode != "RGBA":
        src = src.convert("RGB")
    if src.size[0] != src.size[1]:
        print("提示：设计稿不是正方形（%dx%d），按内容外接框裁" % src.size)

    box = content_box(src)
    cropped = square_crop(src, box)
    bg = background_color(src)
    print("内容外接框：%s（%dx%d）" % (box, box[2] - box[0], box[3] - box[1]))
    print("方图标裁切：%dx%d；背景色：%s" % (cropped.size + (bg,)))

    todo = []
    for name, size in DENSITIES.items():
        todo.append(("android/res/mipmap-%s/ic_launcher.png" % name, size, "square"))
        todo.append(("android/res/mipmap-%s/ic_launcher_round.png" % name, size, "round"))
    todo.append(("android/res/drawable/ic_launcher_big.png", 512, "square"))
    todo.append(("app/icons/icon-192.png", 192, "square"))
    todo.append(("app/icons/icon-512.png", 512, "square"))
    todo.append(("app/icons/icon-maskable-512.png", 512, "maskable"))
    todo.append(("docs/icon-1024.png", 1024, "full"))

    for rel, size, kind in todo:
        path = os.path.join(REPO, rel)
        if args.dry_run:
            print("  [dry-run] %s (%d, %s)" % (rel, size, kind))
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if kind == "square":
            img = render_square(cropped, size)
        elif kind == "round":
            img = render_round(src, size, bg)
        elif kind == "maskable":
            img = render_maskable(src, size, bg)
        else:  # full：原稿原样（README 展示用）
            img = src.resize((size, size), Image.LANCZOS).convert("RGBA")
        img.save(path, "PNG", optimize=True)
        print("  ✓ %s (%d, %s)" % (rel, size, kind))
    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))