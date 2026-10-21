"""验证「内置离线版 UI」这条路真的能打通。

APK 里打包的 app/ 是用 file:///android_asset/app/index.html?relay=... 加载的，
前端靠 config.js 的 resolveRelay() 从 URL 查询串里取 relay 地址。
这里用 node 造一个最小的 window/localStorage/location 环境，把 app/config.js
和 assets 里那份字节完全相同的文件跑一遍，断言解析结果正确。

用法：python tools/check_bundled_app.py [assets/目录]
退出码 0 = 通过。
"""
import io
import json
import os
import subprocess
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.normpath(os.path.join(ROOT, "..", "app"))

# 内置 UI 依赖的文件（缺一个就是白屏）
REQUIRED = [
    "index.html", "config.js", "util.js", "charts.js", "api.js", "app.js", "app.css",
]

JS_HARNESS = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appDir = process.argv[2];
const search = process.argv[3];

// 最小 window 环境：够 config.js 用
const store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const window = {
  location: { search: search, protocol: 'file:', href: 'file:///android_asset/app/index.html' + search },
  localStorage: localStorage,
  navigator: { userAgent: 'android-webview' },
};
window.window = window;

const sandbox = {
  window,
  globalThis: window,
  localStorage,
  location: window.location,
  navigator: window.navigator,
  console,
  document: { addEventListener() {}, querySelector: () => null, createElement: () => ({ style: {} }) },
};
vm.createContext(sandbox);

const code = fs.readFileSync(path.join(appDir, 'config.js'), 'utf8');
vm.runInContext(code, sandbox, { filename: 'config.js' });

const S = window.SHZU;
const out = {
  relay: S.relay,
  relaySource: S.relaySource,
  apiSnapshot: S.apiUrl('/api/snapshot'),
  apiHealth: S.apiUrl('/api/health'),
  campuses: S.campuses.map(c => c.id),
  storedRelay: localStorage.getItem('shzu.relay'),
  version: S.version,
};
process.stdout.write(JSON.stringify(out));
"""


def run_node(app_dir, search):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(JS_HARNESS)
        harness = f.name
    try:
        r = subprocess.run(
            ["node", harness, app_dir, search],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[:2000])
        return json.loads(r.stdout)
    finally:
        os.unlink(harness)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else APP
    print("被测 app 目录: %s" % target)
    if not os.path.isdir(target):
        print("FAIL 目录不存在: %s" % target)
        return 1

    ok = True
    for name in REQUIRED:
        p = os.path.join(target, name)
        if os.path.exists(p):
            print("  [OK]   %-14s %7d 字节" % (name, os.path.getsize(p)))
        else:
            print("  [FAIL] 缺少 %s" % name)
            ok = False
    if not ok:
        return 1

    cases = [
        # (URL 查询串, 期望 relay, 期望 source)
        ("?relay=" + "http%3A%2F%2F192.168.0.100%3A8080", "http://192.168.0.100:8080", "query"),
        ("?relay=" + "http%3A%2F%2F10.0.0.5%3A8080%2F", "http://10.0.0.5:8080", "query"),
        ("?relay=192.168.0.7%3A8080", "http://192.168.0.7:8080", "query"),
        ("", "", "same-origin"),
    ]
    print("")
    for search, want_relay, want_source in cases:
        try:
            got = run_node(target, search)
        except Exception as e:
            print("  [FAIL] %-52s 运行 node 失败: %s" % (search or "(无查询串)", e))
            ok = False
            continue
        good = got["relay"] == want_relay and got["relaySource"] == want_source
        print("  [%s] %-52s relay=%r source=%r"
              % ("OK  " if good else "FAIL", search or "(无查询串)", got["relay"], got["relaySource"]))
        if not good:
            print("         期望 relay=%r source=%r" % (want_relay, want_source))
            ok = False

    # 六校区必须齐（契约里 campuses 恒 6 项）
    got = run_node(target, "?relay=" + "http%3A%2F%2F192.168.0.100%3A8080")
    want = ["zhongqu", "beiqu", "dongqu", "beiyuan", "nanqu", "jiangjunshan"]
    if got["campuses"] == want:
        print("  [OK  ] 六校区 id 与契约一致: %s" % ", ".join(got["campuses"]))
    else:
        print("  [FAIL] 校区 id 不匹配: %s" % got["campuses"])
        ok = False

    print("")
    print("样本 apiUrl: %s" % got["apiSnapshot"])
    print("结果: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
