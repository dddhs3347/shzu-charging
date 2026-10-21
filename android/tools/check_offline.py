"""静态检查 webassets/offline.html 的内联 JS 与结构（不依赖浏览器）。

用法：python tools/check_offline.py
退出码 0 = 全部通过；1 = 有问题。
"""
import io
import os
import re
import subprocess
import sys
import tempfile

# Windows 控制台默认 GBK，输出中文会乱码；强制 UTF-8（Python 3.7+）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "webassets", "offline.html")

REQUIRED_IDS = ["retry", "feed", "bundled", "addr", "reason"]
REQUIRED_TEXT = ["公共频道", "重试", "relay"]
# 中继地址已内置，离线页不应再出现任何「改地址 / 设置」入口
FORBIDDEN_IDS = ["change", "settings"]
FORBIDDEN_TEXT = ["修改地址", "测试连接"]


def main():
    if not os.path.exists(HTML):
        print("FAIL 找不到 %s" % HTML)
        return 1
    s = io.open(HTML, encoding="utf-8").read()
    ok = True

    for token in REQUIRED_TEXT:
        if token not in s:
            print("FAIL 缺少文案/关键字: %r" % token)
            ok = False

    ids = set(re.findall(r'id="([^"]+)"', s))
    for need in REQUIRED_IDS:
        if need not in ids:
            print("FAIL 缺少元素 id=%s（现有: %s）" % (need, ", ".join(sorted(ids))))
            ok = False

    # task-9：中继地址内置，离线页不能再提供改地址入口
    for bad in FORBIDDEN_IDS:
        if bad in ids:
            print("FAIL 离线页仍有中继设置入口 id=%s（地址已内置，应删除）" % bad)
            ok = False
    for bad in FORBIDDEN_TEXT:
        if bad in s:
            print("FAIL 离线页仍有配置类文案: %r（地址已内置，应删除）" % bad)
            ok = False

    scripts = re.findall(r"<script[^>]*>(.*?)</script>", s, re.S)
    print("内联 script 块: %d" % len(scripts))
    if not scripts:
        print("FAIL 没有内联脚本，按钮点不了")
        return 1

    tmpdir = tempfile.mkdtemp(prefix="offchk_")
    for i, sc in enumerate(scripts):
        p = os.path.join(tmpdir, "inline_%d.js" % i)
        io.open(p, "w", encoding="utf-8").write(sc)
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode == 0:
            print("  [OK]   inline_%d.js 语法通过" % i)
        else:
            print("  [FAIL] inline_%d.js 语法错误:\n%s" % (i, r.stderr.strip()))
            ok = False

    # 检查引用的桥方法在 Java 侧真的存在，避免按钮点了没反应
    java = os.path.join(ROOT, "src", "cn", "edu", "shzu", "charger", "MainActivity.java")
    if os.path.exists(java):
        jsrc = io.open(java, encoding="utf-8").read()
        for method in sorted(set(re.findall(r"ShzuShell\.(\w+)\(", s))):
            if ("public void %s(" % method) in jsrc or ("public String %s(" % method) in jsrc \
                    or ("public boolean %s(" % method) in jsrc:
                print("  [OK]   JS 桥 ShzuShell.%s() 在 Java 里存在" % method)
            else:
                print("  [FAIL] JS 调用了 ShzuShell.%s()，但 MainActivity 里没有对应方法" % method)
                ok = False

    # 检查兜底逻辑：没有桥（用浏览器直接打开离线页）时不能报错
    if "location.href" not in s and "location.reload" not in s:
        print("WARN 离线页在无 JS 桥环境下没有 fallback 跳转")

    print("")
    print("结果: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
