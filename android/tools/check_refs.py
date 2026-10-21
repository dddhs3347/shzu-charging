#!/usr/bin/env python3
"""资源引用交叉校验（构建前的廉价静态检查，不依赖 Android SDK）。

aapt2 能抓到的错误它也能抓到一部分，但跑得更快、报错更直白：
  * Java 里 findViewById(R.id.xxx) 的每个 id 是否真的在 layout 里定义
  * Java 里 R.string.xxx / R.color.xxx 等是否在 values/ 里定义
  * layout 与 AndroidManifest.xml 里的 @string/ @color/ @style/ @mipmap/ @drawable/
    @xml/ @layout/ 引用是否都能解析到 res/ 下真实的资源
  * values/ 里有但没人用的字符串（只提示，不算失败）

用法:
    python tools/check_refs.py
退出码 0 = 全部通过；1 = 有缺失引用（详情会打印出来）。
"""

import re
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RES = ROOT / 'res'
SRC = ROOT / 'src'

fails = []


def note(msg):
    print(msg)


def fail(msg):
    fails.append(msg)
    print('  [MISS] ' + msg)


# ---------------------------------------------------------------- 收集源码
src_files = sorted(SRC.rglob('*.java'))
if not src_files:
    sys.exit('在 %s 下找不到 .java 源码' % SRC)
java = '\n'.join(p.read_text(encoding='utf-8') for p in src_files)
note('源码: %s' % ', '.join(p.name for p in src_files))

# ---------------------------------------------------------------- 收集资源定义
values = {}          # type -> set(names)
for p in (RES / 'values').glob('*.xml'):
    t = p.read_text(encoding='utf-8')
    for typ, pat in [('string', r'<string name="(\w+)"'),
                     ('color', r'<color name="(\w+)"'),
                     ('style', r'<style name="([\w.]+)"'),
                     ('dimen', r'<dimen name="(\w+)"'),
                     ('integer', r'<integer name="(\w+)"')]:
        values.setdefault(typ, set()).update(re.findall(pat, t))

files = {'mipmap': set(), 'drawable': set(), 'xml': set(), 'layout': set()}
for typ in list(files):
    for p in RES.rglob(typ + '*/*'):
        if p.is_file():
            files[typ].add(p.stem)


def pool_of(typ):
    return values.get(typ) or files.get(typ, set())


# ---------------------------------------------------------------- 1. findViewById
note('\n== 1. findViewById(R.id.*) vs layout ==')
layout_text = '\n'.join(p.read_text(encoding='utf-8') for p in (RES / 'layout').glob('*.xml'))
used_ids = re.findall(r'findViewById\(\s*R\.id\.(\w+)\s*\)', java)
declared_ids = set(re.findall(r'@\+id/(\w+)', layout_text))
note('  layout 定义: %d 个 id，Java 使用: %d 处' % (len(declared_ids), len(used_ids)))
for i in sorted(set(used_ids)):
    if i not in declared_ids:
        fail('layout 里没有 @+id/%s（但 Java 里 findViewById 了）' % i)
unused_ids = sorted(declared_ids - set(used_ids))
if unused_ids:
    note('  [note] layout 里没人 findViewById 的 id: %s' % ', '.join(unused_ids))

# ---------------------------------------------------------------- 2. R.xxx.yyy
note('\n== 2. Java 里的 R.<type>.<name> 引用 ==')
for typ in ('string', 'color', 'style', 'dimen', 'integer', 'mipmap', 'drawable', 'xml', 'layout'):
    used = sorted(set(re.findall(r'R\.' + typ + r'\.(\w+)', java)))
    if not used:
        continue
    pool = pool_of(typ)
    note('  R.%-8s 使用: %s' % (typ, ', '.join(used)))
    for nm in used:
        if nm not in pool:
            fail('R.%s.%s 在 res/ 里不存在' % (typ, nm))

# ---------------------------------------------------------------- 3. XML 里的 @ 引用
note('\n== 3. layout / manifest 里的 @type/name 引用 ==')
for label, path in [('layout/', None), ('AndroidManifest.xml', ROOT / 'AndroidManifest.xml')]:
    targets = sorted((RES / 'layout').glob('*.xml')) if path is None else [path]
    for p in targets:
        t = p.read_text(encoding='utf-8')
        refs = sorted(set(re.findall(r'@(string|color|style|mipmap|drawable|xml|layout)/([\w.]+)', t)))
        note('  %s: %d 个资源引用' % (p.relative_to(ROOT), len(refs)))
        for typ, nm in refs:
            if nm not in pool_of(typ):
                fail('%s 引用了不存在的 @%s/%s' % (p.relative_to(ROOT), typ, nm))

# ---------------------------------------------------------------- 4. 未使用字符串（提示）
note('\n== 4. values/strings.xml 里未使用的字符串（仅提示）==')
referenced = set(re.findall(r'R\.string\.(\w+)', java))
for label, p in [('layout', None), ('manifest', ROOT / 'AndroidManifest.xml')]:
    targets = sorted((RES / 'layout').glob('*.xml')) if p is None else [p]
    for q in targets:
        referenced.update(re.findall(r'@string/(\w+)', q.read_text(encoding='utf-8')))
unused = sorted(values.get('string', set()) - referenced)
note('  未使用: %s' % (', '.join(unused) if unused else '(无)'))

# ---------------------------------------------------------------- 结论
note('')
if fails:
    note('有 %d 处资源引用缺失，先修这些再构建：' % len(fails))
    for f in fails:
        note('  - ' + f)
    sys.exit(1)

note('资源引用全部可解析（%d 个 id / %d 个字符串 / %d 个颜色）'
     % (len(declared_ids), len(values.get('string', ())), len(values.get('color', ()))))
sys.exit(0)
