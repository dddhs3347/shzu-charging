#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 classes.dex 注入 aapt2 link 产出的基础 APK，生成可直接 zipalign 的未签名 APK。

    python tools/pack_apk.py <base.apk> <classes.dex> <out.apk>

要点：
  * 逐条重建 zip，保留原有条目的压缩方式 / 时间戳 / 属性（resources.arsc 等不动）；
  * classes.dex 用 DEFLATED 写入；
  * 若基础 APK 里已存在 classes.dex，则跳过旧的。
"""
import os
import sys
import zipfile


def main(argv):
    if len(argv) != 4:
        sys.stderr.write("用法: pack_apk.py <base.apk> <classes.dex> <out.apk>\n")
        return 2

    base_apk, dex_path, out_apk = argv[1], argv[2], argv[3]

    for p, what in ((base_apk, "基础 APK"), (dex_path, "classes.dex")):
        if not os.path.isfile(p):
            sys.stderr.write("错误: 找不到%s: %s\n" % (what, p))
            return 1

    if os.path.abspath(base_apk) == os.path.abspath(out_apk):
        sys.stderr.write("错误: 输出不能和输入相同\n")
        return 1

    skipped = 0
    with zipfile.ZipFile(base_apk, "r") as src:
        with zipfile.ZipFile(out_apk, "w", zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                if item.filename == "classes.dex":
                    skipped += 1
                    continue
                data = src.read(item.filename)
                zi = zipfile.ZipInfo(item.filename, date_time=item.date_time)
                zi.compress_type = item.compress_type
                zi.external_attr = item.external_attr
                zi.internal_attr = item.internal_attr
                zi.create_system = item.create_system
                zi.comment = item.comment
                dst.writestr(zi, data)
            dst.write(dex_path, "classes.dex", zipfile.ZIP_DEFLATED)

    size = os.path.getsize(out_apk)
    with zipfile.ZipFile(out_apk, "r") as z:
        names = z.namelist()
        if "classes.dex" not in names:
            sys.stderr.write("错误: 注入后仍没有 classes.dex\n")
            return 1
        dex_size = z.getinfo("classes.dex").file_size

    print("packed %s  (%d bytes, %d entries, classes.dex %d bytes%s)"
          % (out_apk, size, len(names), dex_size,
             (", 覆盖旧 dex %d 个" % skipped) if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
