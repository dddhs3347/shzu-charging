"""给需要 PowerShell 5.1 解析的 .ps1 加 UTF-8 BOM（幂等）。

Windows PowerShell 5.1 只在 .ps1 带 UTF-8 BOM 时才按 UTF-8 解析，
否则按系统 ANSI(GBK) 读，中文注释/字符串会把语法搞坏。
edit / write 工具保存时不留 BOM，所以这里做一次修正。

用法:
    python tools/fix_bom.py          # 修正 build.ps1 和 tools 下所有 .ps1
    python tools/fix_bom.py --check  # 只检查，不写（有缺失则退出码 1）
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BOM = b'\xef\xbb\xbf'

targets = [ROOT / 'build.ps1'] + sorted((ROOT / 'tools').glob('*.ps1'))

check_only = '--check' in sys.argv
missing = 0

for p in targets:
    if not p.exists():
        print('skip (不存在): %s' % p)
        continue
    data = p.read_bytes()
    has_bom = data[:3] == BOM
    has_non_ascii = any(b > 127 for b in data)
    if has_bom:
        print('OK      %s' % p.name)
        continue
    if not has_non_ascii:
        print('OK      %s  (纯 ASCII，不需要 BOM)' % p.name)
        continue
    missing += 1
    if check_only:
        print('MISSING %s  (有中文但缺 UTF-8 BOM，PS 5.1 会解析成乱码)' % p.name)
    else:
        p.write_bytes(BOM + data)
        print('FIXED   %s  (已补 UTF-8 BOM)' % p.name)

if check_only and missing:
    sys.exit(1)
sys.exit(0)
