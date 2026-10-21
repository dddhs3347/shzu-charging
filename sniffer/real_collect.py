# -*- coding: utf-8 -*-
"""
石河子大学充电桩 —— 真实数据采集器（生产用，零第三方依赖）

数据来源（两个，均为微信小程序后端，实测免 token）：

  源 A：charge.shzu.edu.cn「石河子大学充电桩」（学校官方）
     GET  /api/v1/devices/nearby?lng=&lat=&pageSize=100&current=N
          免鉴权，分页有重复必须按 id 去重
     GET  /api/v1/devices/<id>
          data.device        设备信息（含 campus / estate.name / ports_number / online）
          data.device_status 逐端口明细 [{Port, Status, Charging, CurrentPower, ...}]
          Status = FREE / WORKING / BREAKDOWN
    ★ 该域名 TLS 在本机 Python 下握手失败（SSLV3_ALERT_HANDSHAKE_FAILURE），
      必须走 curl 子进程；浏览器也无 CORS 头，App 不能直连，只能由平板 relay 代采。

  源 B：appapi.lvcchong.com「充充充充电桩-铭创电子」（绿充充平台）
     POST /appBaseApi/nearbyDeviceListWithoutLogin   body: lat=..&lng=..
          免 token，恒返 20 条、分页无效 → 必须多中心点扫描 + 按 id 去重
          每设备有 portNumber（总端口）/ freePortCount（空闲端口）
          estateName 恒 null，归区靠 name + address + estateId
    ★ CORS 全开，浏览器可直连；但只到设备级粒度（无逐端口明细，需 token）。

两个源都输出契约 shzu.ingest.v1，交给 relay 聚合。

用法：
  python real_collect.py                  # 两个源都采，写 out/ingest_real.json
  python real_collect.py --source shzu    # 只采源 A
  python real_collect.py --source lvcc    # 只采源 B
  python real_collect.py --post http://127.0.0.1:8080    # 采完直接 POST /api/ingest
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHARED = os.path.join(ROOT, "shared")

# 同目录的 netdns.py：系统 DNS 不可用时自己发 UDP 查询 + curl --resolve 兜底
if HERE not in sys.path:
    sys.path.insert(0, HERE)
try:
    import netdns as _dns
except Exception:  # pragma: no cover - 兜底模块缺失时不影响正常环境
    _dns = None

UA_WECHAT = (
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.50.2701(0x28003235) WeChat/arm64 Weixin "
    "NetType/WIFI Language/zh_CN ABI/arm64"
)

SHZU_BASE = "https://charge.shzu.edu.cn"
LVCC_BASE = "https://appapi.lvcchong.com"

# ---------------------------------------------------------------- 归区
# 别名表唯一事实来源是 shared/campus.json（真实数据暴露出的「南山新校区」
# 「新北北区」等别名已经收进契约）。注意别名之间存在包含关系：「北区」是
# 「北苑新区」「新北北区」的子串，所以必须按长度倒序做最长匹配，否则
# 「北苑新区」会被误判成「北区」。

# campus_id 中文名，与 shared/campus.json 保持一致
CAMPUS_NAME = {
    "zhongqu": "中区",
    "beiqu": "北区",
    "dongqu": "东区",
    "beiyuan": "北苑新区",
    "nanqu": "南区",
    "jiangjunshan": "将军山校区",
}
CAMPUS_ORDER = ["zhongqu", "beiqu", "dongqu", "beiyuan", "nanqu", "jiangjunshan"]

# 源 B（绿充充）里挂着「石河子大学」字样、但实际在校园外的商家设备。
# 它们不属于校园充电桩设施，算进去会污染统计（实测速8酒店 3 台共 3 端口）。
LVCC_EXCLUDE = ["速8", "酒店", "万达", "公馆", "广场", "宾馆", "公寓出租", "快捷"]


def load_aliases():
    """读 shared/campus.json 的 aliases，返回 [(alias, campus_id)] 按长度倒序。"""
    pairs = []
    with open(os.path.join(SHARED, "campus.json"), encoding="utf-8") as f:
        data = json.load(f)
    for c in data.get("campuses", []):
        names = [c.get("name") or ""] + list(c.get("aliases") or [])
        for a in names:
            a = (a or "").strip()
            if a:
                pairs.append((a, c["id"]))
    # 最长优先（同长度按 campus 顺序稳定）
    seen = set()
    out = []
    for a, cid in pairs:
        k = (a, cid)
        if k in seen:
            continue
        seen.add(k)
        out.append((a, cid))
    out.sort(key=lambda x: (-len(x[0]), CAMPUS_ORDER.index(x[1]) if x[1] in CAMPUS_ORDER else 99))
    return out


ALIASES = []


def detect_campus(*texts):
    """按最长别名匹配归区，未命中返回 None。"""
    global ALIASES
    if not ALIASES:
        ALIASES = load_aliases()
    blob = " ".join(str(t) for t in texts if t)
    if not blob:
        return None
    for alias, cid in ALIASES:
        if alias in blob:
            return cid
    return None


# ---------------------------------------------------------------- HTTP
def find_curl():
    """找 curl 可执行文件。

    Windows 自带 System32\\curl.exe；Termux/Android 上叫 curl（没有 .exe 后缀），
    还有 /system/bin/curl 这个系统自带的。平板上必须能命中，否则采集器直接挂。
    """
    for p in (
        r"C:\Windows\System32\curl.exe",
        r"C:\Windows\SysWOW64\curl.exe",
        "/data/data/com.termux/files/usr/bin/curl",
        "/system/bin/curl",
        "/usr/bin/curl",
        "/usr/local/bin/curl",
    ):
        if os.path.isfile(p):
            return p
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not d:
            continue
        for name in ("curl.exe", "curl"):
            cand = os.path.join(d, name)
            if os.path.isfile(cand):
                return cand
    raise RuntimeError("找不到 curl（Windows 需 curl.exe，Termux 需 pkg install curl）")


CURL = None  # 懒加载缓存，避免每次请求都扫一遍 PATH


def _curl_bin():
    global CURL
    if CURL is None:
        CURL = find_curl()
    return CURL


def curl(url, data=None, timeout=40, headers=None):
    """调 curl 取文本。返回 (http_code, body_text)。失败抛 RuntimeError。

    ★ Android 兜底：从 root 派生出来的进程（KernelSU 的 su、/data/adb/service.d
    开机脚本）SELinux 域是 u:r:ksu:s0，连不上 netd 的 /dev/socket/dnsproxyd，
    所以系统 DNS 解析一律失败（curl http=000 / urllib Errno 7），但 TCP/UDP 出网
    完全正常。这里用 netdns 自己发 UDP DNS 查询拿 IP，再用 curl 的 --resolve
    注入，绕开系统解析器。正常环境首次就能成功，永远不会走到兜底分支。
    """
    exe = _curl_bin()
    cmd = [exe, "-s", "-k", "--max-time", str(timeout),
           "-A", UA_WECHAT,
           "-w", "\n__HTTP__%{http_code}",
           url]
    if data is not None:
        cmd = [exe, "-s", "-k", "--max-time", str(timeout),
               "-A", UA_WECHAT,
               "-X", "POST",
               "-H", "Content-Type: application/x-www-form-urlencoded",
               "--data-raw", data,
               "-w", "\n__HTTP__%{http_code}",
               url]
    for h in (headers or []):
        cmd.extend(["-H", h])
    try:
        p = subprocess.run(cmd, capture_output=True)
        # 退出码 6 = 解析失败；也兼容某些 curl 只返回空 stdout 的情况
        if p.returncode == 6 or not (p.stdout or b"").strip():
            extra = _dns.resolve_args(url) if _dns else []
            if extra:
                p = subprocess.run([cmd[0]] + extra + cmd[1:], capture_output=True)
    except FileNotFoundError:
        raise RuntimeError("找不到 curl（已尝试 PATH 与常见安装路径）")
    raw = p.stdout.decode("utf-8", "replace")
    code = 0
    body = raw
    m = re.search(r"\n__HTTP__(\d+)\s*$", raw)
    if m:
        code = int(m.group(1))
        body = raw[:m.start()]
    if code == 0:
        raise RuntimeError("curl 无有效响应（网络不可达？）url=%s" % url)
    return code, body


def get_json(url, timeout=40):
    code, body = curl(url, timeout=timeout)
    if code != 200:
        raise RuntimeError("HTTP %d from %s : %s" % (code, url[:120], body[:200]))
    return json.loads(body)


def post_form(url, data, timeout=40):
    code, body = curl(url, data=data, timeout=timeout)
    if code != 200:
        raise RuntimeError("HTTP %d from %s : %s" % (code, url[:120], body[:200]))
    return json.loads(body)


# ================================================================ 源 A：石大官方
def collect_shzu(max_pages=12, detail_delay=0.05, verbose=True, workers=16):
    """采集 charge.shzu.edu.cn，返回 ingest.stations

    workers：逐台详情并发数。逐端口明细只能靠 /api/v1/devices/<id> 拿
    （列表接口不含端口状态，updated_at 也不随端口状态变化，没有便宜的
    增量接口），182 台串行约 55 秒；实测并发后 workers=16 约 4 秒，
    这正是「源 A 15 秒刷新一次」能成立的前提。
    """
    CENTERS = [
        (44.3063, 86.0637),  # 中区
        (44.3140, 86.0620),  # 北区
        (44.3060, 86.0780),  # 东区
        (44.3160, 86.0700),  # 北苑新区
        (44.2980, 86.0620),  # 南区
        (44.2900, 86.0400),  # 将军山 / 南山新校区
    ]

    seen = {}
    for (lat, lng) in CENTERS:
        for page in range(1, max_pages + 1):
            url = ("%s/api/v1/devices/nearby?lng=%s&lat=%s&pageSize=100&current=%d"
                   % (SHZU_BASE, lng, lat, page))
            try:
                j = get_json(url)
            except Exception as e:
                if verbose:
                    print("  [A] 列表失败 center=%s,%s page=%d : %s" % (lat, lng, page, e), file=sys.stderr)
                break
            arr = j.get("data") or []
            if not isinstance(arr, list) or not arr:
                break
            added = 0
            for d in arr:
                if not isinstance(d, dict):
                    continue
                did = d.get("id")
                if did is None:
                    continue
                if did not in seen:
                    seen[did] = d
                    added += 1
            if verbose:
                print("  [A] center=(%s,%s) page=%d 返回 %d 台，新增 %d，累计 %d"
                      % (lat, lng, page, len(arr), added, len(seen)))
            if added == 0 and page > 1:
                break
            if len(arr) < 10:
                break
    if verbose:
        print("  [A] 设备去重后 = %d 台" % len(seen))

    # 逐台取详情拿 device_status（逐端口）
    #
    # 先并发把所有详情抓回来，再单线程做归站/归区。归站逻辑会往
    # stations 里写共享字典，并发放过去就数据竞争了；而且它很便宜，
    # 串行跑一点不慢，真正慢的是网络等待，所以瓶颈全在抓取阶段。
    stations = {}
    ok = 0
    fail = 0
    ordered = sorted(seen.items(), key=lambda x: int(x[0]))

    def _fetch_detail(item):
        did = item[0]
        try:
            return did, get_json("%s/api/v1/devices/%s" % (SHZU_BASE, did)), None
        except Exception as e:
            return did, None, e

    detail_t0 = time.time()
    fetched = []
    if workers and workers > 1:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for did, j, err in ex.map(_fetch_detail, ordered):
                fetched.append((did, j, err))
    else:
        for item in ordered:
            fetched.append(_fetch_detail(item))
    detail_dt = time.time() - detail_t0
    if verbose:
        print("  [A] 详情并发 %d 路，%d 台耗时 %.1fs" % (workers or 1, len(ordered), detail_dt))

    for i, (did, j, err) in enumerate(fetched):
        dev = seen.get(did) or {}
        if err is not None or j is None:
            fail += 1
            if verbose and fail <= 5:
                print("  [A] 详情 %s 失败：%s" % (did, err), file=sys.stderr)
            continue
        ok += 1
        data = j.get("data") or {}
        devfull = data.get("device") or dev
        ports = data.get("device_status") or []
        estate = devfull.get("estate") or {}
        estate_name = estate.get("name") or ""

        # 归区：campus 字段优先（已是 zhongqu/beiqu/... 英文 id），否则靠名字
        cid = None
        raw_campus = (devfull.get("campus") or "").strip().lower()
        if raw_campus in CAMPUS_NAME:
            cid = raw_campus
        if cid is None:
            cid = detect_campus(estate_name, devfull.get("name"), devfull.get("address"))
        area = cid or "_unassigned"

        dev_name = devfull.get("name") or ("设备 %s" % did)

        # 站点归并：按**物理充电站**（设备名去尾部序号），不是一个校区一个站。
        # 真实设备名「石河子大学北苑新区41号机」→ 站「北苑新区」，
        # 该站下 41/42/…/75 号机共 72 台设备的端口全部归到同一个站。
        sname = station_name_of(dev_name)
        station_key = "%s:st-%s" % (area, sname)
        st = stations.get(station_key)
        if st is None:
            st = {
                "raw_id": station_key,
                "raw_name": sname,
                "raw_area": CAMPUS_NAME.get(cid) if cid else None,
                "address": devfull.get("address") or estate.get("address"),
                "lat": _num(estate.get("lat") if estate.get("lat") else devfull.get("lat")),
                "lng": _num(estate.get("lng") if estate.get("lng") else devfull.get("lng")),
                "devices": [],
            }
            stations[station_key] = st

        for p in ports:
            if not isinstance(p, dict):
                continue
            pno = p.get("Port")
            if pno is None:
                continue
            # 厂商 CurrentPower 是真实瞬时功率：空闲端口本来就是 0 W（不是缺失）
            pw = _num(p.get("CurrentPower"))
            st["devices"].append({
                "raw_id": "%s-p%s" % (did, pno),
                "code": "%s-%s" % (devname_code(dev_name), pno),
                "name": "%s %s号端口" % (dev_name, pno),
                "raw_status": str(p.get("Status") or ""),
                "power_w": pw,
            })
        if not ports:
            # 没有端口明细时退化成一个虚拟端口，避免整台设备丢失
            st["devices"].append({
                "raw_id": "%s-p0" % did,
                "code": devname_code(dev_name),
                "name": "%s（无端口明细）" % dev_name,
                "raw_status": "UNKNOWN",
                "power_w": None,
            })
        if verbose and (i + 1) % 40 == 0:
            print("  [A] 详情进度 %d/%d" % (i + 1, len(seen)))

    if verbose:
        print("  [A] 详情成功 %d 失败 %d，站点 %d 个，端口 %d 个（抓取 %.1fs + 归站 %.1fs）"
              % (ok, fail, len(stations), sum(len(s["devices"]) for s in stations.values()),
                 detail_dt, time.time() - detail_t0 - detail_dt))
    return list(stations.values()), {
        "free": ["FREE"],
        "busy": ["WORKING", "CHARGING", "OCCUPIED"],
        "offline": ["BREAKDOWN", "OFFLINE", "FAULT", "ERROR"],
        "unknown": ["UNKNOWN"],
    }


def devname_code(name):
    """从设备名里抽编号：'石河子大学北苑新区41号机' -> '41'；失败则留空。"""
    m = re.search(r"(\d+)\s*号机", name or "")
    if m:
        return m.group(1)
    m = re.search(r"(\d+)", name or "")
    return m.group(1) if m else ""


# ---------------------------------------------------------------- 站点归并
# 真实设备名形如「石河子大学北苑新区41号机」「石大将军山校区1号公寓14号机」
# 「图书馆2号快充」「东区5号公寓（二段）3号机」。去掉尾部序号就是**物理充电站**。
# 不能直接用 estate.id 归站：全校 estate 只有 5 个值，会把一个校区压成一个站。
RE_HAOJI = re.compile(r"\s*\d+\s*号机\s*$")          # ...41号机
RE_GENHUAN = re.compile(r"[（(]\s*更换\s*\d*\s*机?\s*[）)]\s*$")  # ...（更换1机）
RE_HAO_MODE = re.compile(r"^(.+?)\d+\s*号\s*(慢充|快充|汽充)\s*$")  # 图书馆2号快充
RE_HAO_TAIL = re.compile(r"^(.+?)\d+\s*号\s*$")       # 图书馆4号

# 设备名前缀：长前缀优先，避免「石河子大学」先吃掉「石河子大学将军山校区」
STATION_PREFIXES = [
    ("石河子大学", ""),
    ("石大", ""),
    ("将军山校区", "将军山"),
]


def station_name_of(dev_name):
    """设备名 → 充电站名。多次剥离尾部序号，直到稳定为止。

    '石河子大学北苑新区41号机'        -> '北苑新区'
    '石大将军山校区1号公寓14号机'      -> '将军山1号公寓'
    '图书馆2号快充'                  -> '图书馆快充'
    '石大将军山校区5号公寓（更换1机）'  -> '将军山5号公寓'
    '东区5号公寓（二段）3号机'         -> '东区5号公寓（二段）'
    """
    name = (dev_name or "").strip()
    prev = None
    while name and name != prev:
        prev = name
        name = RE_HAOJI.sub("", name)
        name = RE_GENHUAN.sub("", name)
    m = RE_HAO_MODE.match(name)
    if m:
        name = m.group(1).rstrip() + m.group(2)
    elif RE_HAO_TAIL.match(name):
        name = RE_HAO_TAIL.match(name).group(1).rstrip()
    for prefix, repl in STATION_PREFIXES:
        if name.startswith(prefix):
            name = repl + name[len(prefix):]
            break
    return name.strip() or (dev_name or "").strip() or "未命名充电站"


def station_sort_key(station):
    """同一校区内站点的稳定排序：先按名字，再按 raw_id。"""
    return (station.get("raw_name") or "", station.get("raw_id") or "")


# 源 B（绿充充 / 小程序名「充充充充电桩-铭创电子」）的站名统一带这个后缀。
# 它同时承担两个职责：① 界面上区分这是哪个源的端口；② _station_source()
# 靠它判断一份数据属于哪个源（进而决定 ingest 里带不带 source_id）。
# 所以改这个常量 = 同时改显示名和分区判定，别只改一处。
LVCC_MARK = "（充充充充电桩-铭创电子）"
SOURCE_ID_OF_ARGS = {"shzu": "shzu", "lvcc": "lvcc", "both": "default"}


def _station_source(station):
    """猜一个站点属于哪个源：站名带源 B 标记 → 源 B，否则源 A。"""
    rid = station.get("raw_id") or ""
    if LVCC_MARK in rid or LVCC_MARK in (station.get("raw_name") or ""):
        return "lvcc"
    return "shzu"


def _is_single_source_exclusive(stations):
    """这一份 ingest 是否只含某一个源的数据（从而可以安全地只报一个 source_id）。

    刻意**不**用 ``--source`` 判断：--source 说的是「打算采谁」，
    而 _is_single_source_exclusive 回答的是「实际采到了谁」。采源 A 时
    万一某个站归区失败跑进了源 B 的分区，两边都会写错分区键，
    relay 就会静默丢掉一份数据。用实际内容判断更保险。
    """
    kinds = set(_station_source(s) for s in stations or [])
    return len(kinds) == 1


def _num(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
        if f != f:  # nan
            return None
        return f
    except (TypeError, ValueError):
        return None


# ================================================================ 源 B：绿充充
LVCC_CENTERS = [
    # 六校区各 2 点
    (44.3063, 86.0637), (44.3050, 86.0620),           # 中区
    (44.3140, 86.0620), (44.3155, 86.0600),           # 北区
    (44.3060, 86.0780), (44.3050, 86.0800),           # 东区
    (44.3160, 86.0700), (44.3175, 86.0680),           # 北苑新区
    (44.2980, 86.0620), (44.2965, 86.0640),           # 南区
    (44.2900, 86.0400), (44.2880, 86.0380),           # 将军山
    # 校园周边补充点（覆盖北四路221号 / 石河子大学内 / 北三路）
    (44.3120, 86.0640), (44.3180, 86.0650),
    (44.3020, 86.0660), (44.3100, 86.0720),
]

# 相邻两次请求之间强制等待的秒数。
#
# 原来这里是 0.12 秒，17 个中心点在 2 秒内打完 —— 这种「小窗口内密集请求」
# 正是阿里云 WAF 最容易判为异常的形态（实测源 B 反复被拦就是这个原因）。
# 拉长到 1.5 秒后单轮约 26 秒，请求密度从 ~8.5 次/秒降到 0.67 次/秒。
LVCC_REQ_DELAY = float(os.environ.get("SHZU_LVCC_REQ_DELAY", "1.5"))

# 刚从风控里恢复时先只打一个中心点探路：通了再全量扫。
# 上一次被拦说明这个 IP 在 WAF 里还有"案底"，一恢复就 17 连发极可能立刻又被锁。
LVCC_PROBE_CENTERS = 1

# 连续多少个中心点「一台新设备都没捞到」就提前收工。
#
# 实测（2026-10-20）：16 个中心点里，第 11 个点就累计到 269 台，
# 第 12~16 个点新增恒为 0 —— 后 5 个请求纯属浪费，而每一次多余的请求
# 都在给 WAF 攒计数。提前停止把单轮请求数从 16 降到 ~14，且不影响覆盖率。
# 取 3 而不是 1：设备在线状态会浮动，某个点偶尔返回空不该直接判定已覆盖完。
LVCC_IDLE_STOP = 3


def _lvcc_query(lat, lng, verbose=False):
    """发一次中心点查询，返回 (arr, blocked, message)。

    blocked=True 表示拿到了明确的业务错误（code 非 200），不是网络抖动 ——
    上层据此决定「立即中止本轮」而不是继续打剩下的中心点。
    """
    try:
        j = post_form(LVCC_BASE + "/appBaseApi/nearbyDeviceListWithoutLogin",
                      "lat=%s&lng=%s" % (lat, lng))
    except Exception as e:
        if verbose:
            print("  [B] 网络失败 (%s,%s): %s" % (lat, lng, e), file=sys.stderr)
        return [], False, str(e)
    code = j.get("code")
    if code is not None and code != 200:
        msg = "code=%s %s" % (code, str(j.get("message"))[:80])
        if verbose:
            print("  [B] WAF/限流 (%s,%s) %s" % (lat, lng, msg))
        return [], True, msg
    arr = j.get("data") or []
    return (arr if isinstance(arr, list) else []), False, ""


def collect_lvcc(verbose=True):
    """采集 appapi.lvcchong.com，返回 (stations, status_map)

    风控自适应（源 B 的接口有阿里云 WAF 限流，实测被封约 40 分钟后自动解封）：
    1. 距上次被拦不足退避时长（本轮取 1~2 小时阶梯）就**完全不发请求**，
       直接用缓存清单 + 全部端口标 UNKNOWN；
    2. 本轮真的被拦 → 记下失败时刻、退避档位 +1，并冻结上一次的设备清单；
    3. 本轮拿到真实数据 → 清零退避，回到正常节奏。

    无论哪种情况，端口数量都不会掉到 0（契约里 UNKNOWN 表示「取不到状态」，
    不是假的空闲），所以 relay 整份替换快照后 App 上不会出现南区凭空消失。

    **退避期内绝不会因为"本轮没发请求"而升级退避** —— 那是曾经把源 B 永久
    锁死的自锁 bug，详见下面 lvcc_note_blocked 调用处的注释。
    """
    state = _lvcc_state_load()
    blocked_before = int(state.get("backoff_level") or 0) > 0
    skipping = lvcc_should_skip(state)

    seen = {}
    block_msg = ""
    idle = 0        # 连续多少个中心点没有新增设备（LVCC_IDLE_STOP 用）
    if skipping:
        if verbose:
            s = lvcc_state_summary() or {}
            print("  [B] 风控退避中（%s 起被拦，第 %d 档，预计 %s 重试）——本轮不发请求"
                  % (s.get("since"), blocked_before, s.get("retry_after")))
    else:
        centers = list(LVCC_CENTERS)
        if blocked_before:
            # 刚恢复：先探一个点，通了再补齐其余中心点。
            centers = LVCC_CENTERS[:LVCC_PROBE_CENTERS] + LVCC_CENTERS[LVCC_PROBE_CENTERS:]
            if verbose:
                print("  [B] 上次被拦过，先探 %d 个中心点再决定是否全量" % LVCC_PROBE_CENTERS)
        for idx, (lat, lng) in enumerate(centers):
            arr, blocked, msg = _lvcc_query(lat, lng, verbose)
            if blocked:
                block_msg = msg
                # **立即中止**：WAF 已经表态，剩下十几发只会把封禁时间拉长。
                if verbose:
                    print("  [B] 已被 WAF 拦截，立即中止本轮（不再打剩余中心点）")
                break
            added = 0
            for d in arr:
                if not isinstance(d, dict):
                    continue
                did = d.get("id")
                if did is None:
                    continue
                if did not in seen:
                    seen[did] = d
                    added += 1
            if verbose and added:
                print("  [B] center=(%s,%s) 返回 %d 台，新增 %d，累计 %d"
                      % (lat, lng, len(arr), added, len(seen)))
            # 连续几个点都没捞到新设备 → 覆盖面已经饱和，提前收工省请求。
            # 每少发一个请求就少一分触发 WAF 的机会，而覆盖率并不下降。
            if added == 0:
                idle += 1
                if idle >= LVCC_IDLE_STOP:
                    if verbose:
                        print("  [B] 连续 %d 个中心点无新设备，判定已覆盖完，提前结束本轮"
                              % idle)
                    break
            else:
                idle = 0
            # 探路成功（已有数据）就继续把剩下的扫完
            if idx + 1 < len(centers):
                time.sleep(LVCC_REQ_DELAY)

    if verbose:
        print("  [B] 设备去重后 = %d 台" % len(seen))

    # 本轮 0 台时要不要记一次失败，取决于**到底发没发请求**。
    #
    # 这里踩过一个把自己彻底锁死的坑：退避期内 skipping=True，本轮一个请求都不发，
    # seen 必然是空的；如果这时也调 lvcc_note_blocked()，它会把 last_blocked_at
    # 重置成「现在」，于是下一轮 lvcc_should_skip() 算出的 elapsed 又约等于 0、
    # 永远小于 wait —— 退避永远不会到期，档位每一轮 +1 一路顶到最高档并永久停摆。
    # 平板上的指纹就是 last_blocked_message == "处于退避期，未发请求" 且
    # backoff_level 长期停在 3，看起来像「源 B 一直在限流」，其实是我们自己在原地打转。
    #
    # 所以：真的发过请求、真被拦了，才升级退避；退避期内静默跳过，什么都不改。
    if not seen and not skipping:
        level = lvcc_note_blocked(len(_lvcc_cache_load()), block_msg or "本轮未取到任何设备")
        if verbose:
            print("  [B] 记录风控失败，退避档位 → 第 %d 档（等 %.0f 秒后再试）"
                  % (level, LVCC_BACKOFF[level - 1]))
    elif not seen and skipping and verbose:
        print("  [B] 退避期内本轮未发请求，不记失败（否则退避永不到期）")

    # --- 兜底：本轮 0 台就复用上次成功的设备清单，全部标 UNKNOWN ---
    unknown_all = False
    if not seen:
        cached = _lvcc_cache_load()
        if cached:
            if verbose:
                print("  [B] 本轮 0 台（风控限流），复用缓存清单 %d 台，状态标记 UNKNOWN"
                      % len(cached))
            seen = dict(cached)
            unknown_all = True

    # 本轮真拿到数据 → 退避清零
    if seen and not unknown_all:
        lvcc_note_success()

    # 只保留石河子大学相关设备
    uni = []
    for d in seen.values():
        nm = str(d.get("name") or "")
        addr = str(d.get("address") or "")
        if "石河子大学" in nm or "石大" in nm or "石河子大学" in addr:
            # 排除挂名的校外商家（名字里带「石河子大学」但实际是酒店/广场/公馆）
            if any(k in nm for k in LVCC_EXCLUDE):
                if verbose:
                    print("  [B] 排除校外商家：%s" % nm)
                continue
            uni.append(d)
    if verbose:
        print("  [B] 石河子大学相关设备 = %d 台" % len(uni))

    stations = {}
    for d in uni:
        nm = str(d.get("name") or "")
        addr = str(d.get("address") or "")
        # 归区必须「设备名优先、地址兜底」：源 B 全部设备的 address 都是同一串
        # 「石河子市-北四路221号大学北区」，若与名字拼在一起做匹配，地址里的
        # 「北区」会把名字里的「南区/东区」压过去（实测南区被误归北区 20 端口）。
        cid = detect_campus(nm) or detect_campus(addr)
        area = cid or "_unassigned"
        eid = d.get("estateId")
        station_key = "%s:lvcc-%s" % (area, eid if eid is not None else ("dev-" + str(d.get("id"))))

        st = stations.get(station_key)
        if st is None:
            st = {
                "raw_id": station_key,
                "raw_name": "%s%s" % (CAMPUS_NAME.get(cid, area), LVCC_MARK),
                "raw_area": CAMPUS_NAME.get(cid) if cid else None,
                "address": addr,
                "lat": _num(d.get("lat")),
                "lng": _num(d.get("lng")),
                "devices": [],
            }
            stations[station_key] = st

        total = int(d.get("portNumber") or 0)
        free = int(d.get("freePortCount") or 0)
        online = d.get("online")
        dev_id = d.get("id")
        # 归区失败用 address 兜底已做过；这里按端口展开
        if total <= 0:
            total = 1
        free = max(0, min(free, total))
        for i in range(total):
            if unknown_all:
                # 取不到状态：按契约标记 UNKNOWN，绝不拿缓存里的旧状态冒充实时
                status = "UNKNOWN"
            elif online in (0, "0"):
                status = "OFFLINE"
            elif i < free:
                status = "FREE"
            else:
                status = "WORKING"
            st["devices"].append({
                "raw_id": "%s-p%d" % (dev_id, i + 1),
                "code": "%s-%d" % (devname_code(nm), i + 1),
                "name": "%s %d号端口" % (nm, i + 1),
                "raw_status": status,
                "power_w": _num(d.get("maxWatt")),
            })

    if verbose:
        print("  [B] 站点 %d 个，端口 %d 个"
              % (len(stations), sum(len(s["devices"]) for s in stations.values())))
    if seen and not unknown_all:
        _lvcc_cache_save(seen)
    return list(stations.values()), {
        "free": ["FREE"],
        "busy": ["WORKING", "CHARGING", "OCCUPIED"],
        "offline": ["BREAKDOWN", "OFFLINE", "FAULT", "ERROR"],
        # UNKNOWN 单独一类：被风控时全部端口都是 UNKNOWN，含义是「取不到状态」，
        # 不能混进 offline —— 否则 App 上会显示成红色「离线」，是错误信息。
        "unknown": ["UNKNOWN"],
    }


# --- 源 B 设备清单缓存（WAF 限流兜底用） --------------------------------
LVCC_CACHE = os.path.join(HERE, "out", "lvcc_devices_cache.json")
# 只缓存判断设备规模与状态所必需的字段，避免缓存里塞满无关的几十个 null 字段
LVCC_KEEP = ("id", "name", "address", "lat", "lng", "estateId",
             "portNumber", "freePortCount", "online", "maxWatt")


def _lvcc_cache_load():
    try:
        with open(LVCC_CACHE, encoding="utf-8") as f:
            data = json.load(f)
        devs = data.get("devices")
        if isinstance(devs, list) and devs:
            return {str(d["id"]): d for d in devs if isinstance(d, dict) and d.get("id") is not None}
    except Exception:
        pass
    return {}


def _lvcc_cache_save(seen):
    """把本轮设备清单落盘，作为风控期间的兜底。

    **必须防止用残缺轮次覆盖完整清单。** 这个缓存是源 B 被 WAF 拦时唯一
    的数据来源（见 collect_lvcc 的 unknown_all 分支），一旦被写坏，App 上
    对应校区的端口会整批消失，而且没有任何办法自动恢复——只能等下次
    真的采到全量才能长回来。实测踩过：某轮只返回了 136 台（应为 280 台），
    覆盖之后南区的设备全丢了，南区直接变成 0 端口。

    这里的判据是「本轮台数比上次少」而不是固定阈值：接口本来就按经纬度
    逐点返回、每次半径内的台数会浮动，固定阈值要么太松放过退化、
    要么太紧在正常波动时误报。
    """
    try:
        os.makedirs(os.path.dirname(LVCC_CACHE), exist_ok=True)
        slim = [{k: d.get(k) for k in LVCC_KEEP} for d in seen.values()]
        previous = _lvcc_cache_load()
        if previous and len(slim) < len(previous):
            print("[warn] 本轮只拿到 %d 台，比缓存里的 %d 台少，丢弃本轮清单、保留缓存"
                  % (len(slim), len(previous)), file=sys.stderr)
            return
        payload = {"saved_at": datetime.datetime.now().astimezone().replace(microsecond=0).isoformat(),
                   "count": len(slim), "devices": slim}
        tmp = LVCC_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, LVCC_CACHE)
    except Exception as e:
        print("[warn] 写源 B 缓存失败：%s" % e, file=sys.stderr)


# --- 源 B 风控自适应（被拦后退避 1~2 小时，恢复后回到正常节奏） ---------
LVCC_STATE = os.path.join(HERE, "out", "lvcc_state.json")

# 被 WAF 拦时的退避阶梯（秒）：先等 1 小时，再等 1.5 小时，最后 2 小时封顶。
# 实测源 B 约 40 分钟后自动解封，所以第一档给 3600 秒。
LVCC_BACKOFF = [3600.0, 5400.0, 7200.0]

# 源 B 正常情况下的采集间隔（秒），供 deploy/publish_loop.sh 参考。
#
# 定这个数的依据是实测（2026-10-20）：
#   - 完整一轮 16 个中心点 ≈ 54 秒（LVCC_REQ_DELAY=1.5 已把密度压到 0.67 次/秒）
#   - 源 B 只有设备级的 portNumber/freePortCount，没有逐端口明细，
#     所以它的数据"新鲜度"价值远低于源 A（源 A 每 15 秒一轮、有逐端口状态）
#   - ntfy 发布侧 PUBLISH_MIN_INTERVAL=420 秒才是真正的瓶颈，
#     取比它短的间隔没有意义（读了也发不出去）
#
# 300 秒（5 分钟）的取舍：
#   - 24 小时 ≈ 288 轮 ≈ 4600 次请求，摊到每 IP 上远低于 WAF 的常见阈值
#   - 两个校区（南区 60 端口 / 北苑新区新增部分）只靠源 B，5 分钟延迟可接受，
#     因为 App 上这部分显示的是"5 分钟前的状态"，配合 source_warning 已能说明
#   - 比原来的 180 秒再慢 67%，进一步降低触发概率
LVCC_INTERVAL = float(os.environ.get("SHZU_LVCC_INTERVAL", "300"))


def _lvcc_state_load():
    try:
        with open(LVCC_STATE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _lvcc_state_save(state):
    try:
        os.makedirs(os.path.dirname(LVCC_STATE), exist_ok=True)
        tmp = LVCC_STATE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, LVCC_STATE)
    except Exception as e:
        print("[warn] 写源 B 风控状态失败：%s" % e, file=sys.stderr)


def lvcc_should_skip(state=None):
    """距离上次被拦不足退避时长就 True，本轮不发任何源 B 请求。

    传 state 便于测试；不传则读磁盘上的状态文件。
    """
    st = state if state is not None else _lvcc_state_load()
    fail_at = st.get("last_blocked_at")
    level = int(st.get("backoff_level") or 0)
    if not fail_at or level <= 0:
        return False
    wait = LVCC_BACKOFF[min(level - 1, len(LVCC_BACKOFF) - 1)]
    elapsed = time.time() - float(fail_at)
    return elapsed < wait


def lvcc_note_success():
    """本轮拿到真实数据：清掉退避，回到正常节奏。"""
    _lvcc_state_save({
        "last_blocked_at": None,
        "backoff_level": 0,
        "last_ok_at": datetime.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        "last_ok_count": 0,
    })


def lvcc_note_blocked(device_count, message=""):
    """本轮被风控拦：记失败时刻并把退避档位 +1。"""
    st = _lvcc_state_load()
    level = min(int(st.get("backoff_level") or 0) + 1, len(LVCC_BACKOFF))
    now = datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()
    _lvcc_state_save({
        "last_blocked_at": time.time(),
        "last_blocked_at_iso": now,
        "backoff_level": level,
        "backoff_seconds": LVCC_BACKOFF[level - 1],
        "retry_after": (
            datetime.datetime.fromtimestamp(time.time() + LVCC_BACKOFF[level - 1], datetime.timezone.utc)
            .astimezone().replace(microsecond=0).isoformat()
        ),
        "last_blocked_message": message[:200],
        "last_frozen_count": device_count,
        "last_frozen_at": now,
    })
    return level


def lvcc_state_summary():
    """给 --quiet 模式一行人类可读摘要，也给上层调用方判定用。"""
    st = _lvcc_state_load()
    level = int(st.get("backoff_level") or 0)
    if level <= 0 or not st.get("last_blocked_at"):
        return None
    wait = LVCC_BACKOFF[min(level - 1, len(LVCC_BACKOFF) - 1)]
    return {
        "blocked": True,
        "since": st.get("last_blocked_at_iso"),
        "retry_after": st.get("retry_after"),
        "wait_seconds": wait,
        "frozen_count": st.get("last_frozen_count"),
        "message": st.get("last_blocked_message") or "",
    }


# ================================================================ main
def main():
    ap = argparse.ArgumentParser(description="石河子大学充电桩真实数据采集器")
    ap.add_argument("--source", default="both", choices=["both", "shzu", "lvcc"],
                    help="采集哪个数据源，默认两个都采")
    ap.add_argument("--out", default=os.path.join(HERE, "out", "ingest_real.json"),
                    help="输出 ingest JSON 路径")
    ap.add_argument("--post", default=None,
                    help="采完后 POST 到 relay，如 http://127.0.0.1:8080")
    ap.add_argument("--token", default=None, help="relay 的 X-Relay-Token（若启用）")
    ap.add_argument("--shzu-max-pages", type=int, default=12)
    ap.add_argument("--workers", type=int, default=16,
                    help="源 A 逐台详情的并发数（默认 16；1 = 串行，调试用）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    verbose = not args.quiet
    t0 = time.time()
    stations = []
    status_map = None
    # 每个源本轮的成功/失败，用于登记 sources。失败信息原样带出去，
    # 让「为什么少了一半数据」在界面上有答案，而不是靠猜。
    shzu_ok, shzu_err = False, ""
    lvcc_ok, lvcc_err = False, ""

    if args.source in ("both", "shzu"):
        if verbose:
            print("=" * 70)
            print("源 A：charge.shzu.edu.cn（石河子大学充电桩，官方）")
            print("=" * 70)
        try:
            st, sm = collect_shzu(max_pages=args.shzu_max_pages, verbose=verbose,
                                workers=args.workers)
            stations.extend(st)
            status_map = sm
            shzu_ok = bool(st)
            if not shzu_ok:
                shzu_err = "未返回任何站点"
        except Exception as e:
            shzu_err = str(e)
            print("源 A 采集失败：%s" % e, file=sys.stderr)

    if args.source in ("both", "lvcc"):
        if verbose:
            print("=" * 70)
            print("源 B：appapi.lvcchong.com（充充充充电桩-铭创电子）")
            print("=" * 70)
        try:
            st, sm = collect_lvcc(verbose=verbose)
            stations.extend(st)
            status_map = status_map or sm
            lvcc_ok = bool(st)
            if not lvcc_ok:
                lvcc_err = "未返回任何站点"
        except Exception as e:
            lvcc_err = str(e)
            print("源 B 采集失败：%s" % e, file=sys.stderr)

    now = datetime.datetime.now().astimezone().replace(microsecond=0).isoformat()

    # 站点排序：先按校区契约顺序，再按站名，保证 relay 分配站号（-01/-02/...）稳定且可读。
    def _campus_rank(s):
        cid = detect_campus(s.get("raw_area"), s.get("raw_name"))
        return (CAMPUS_ORDER.index(cid) if cid in CAMPUS_ORDER else 99,
                station_sort_key(s))

    stations.sort(key=_campus_rank)

    # source_id 告诉 relay 这一份是哪个源的。
    #
    # 这是「源 A 15 秒一轮、源 B 2~3 分钟一轮」的前提：两个源各发各的
    # ingest，relay 按 source_id 分区保存再合并成一份快照。少了它，
    # 源 A 每次 ingest 都会把源 B 的 60 个南区端口整体覆盖掉
    # （relay 的快照是整份替换语义，不是按源合并）。
    #
    # single_source：从站名能不能看出**独占某一源**推出，而不是简单
    # 等于 "--source 不是 both"——因为 relay 的分区键要求稳定，
    # 万一以后有人改成只采一个源但仍要写进同一个分区，语义才不会翻转。
    single_source = bool(_is_single_source_exclusive(stations))

    ingest = {
        "schema": "shzu.ingest.v1",
        "collected_at": now,
        "collector": "real_collect.py/1.0",
        "site": "石河子大学",
        "status_map": status_map or {
            "free": ["FREE"],
            "busy": ["WORKING"],
            "offline": ["BREAKDOWN", "OFFLINE"],
            "unknown": ["UNKNOWN"],
        },
        "stations": stations,
    }
    if single_source:
        ingest["source_id"] = SOURCE_ID_OF_ARGS.get(args.source, "default")

    # 源 A / 源 B 采集结果透传给 relay → App。
    #
    # sources 必须把两个源都登记，不能只登记 lvcc：App 的「数据源」面板是按
    # sources 逐个渲染的，少一个就等于这个源在界面上不存在，出问题时用户
    # 也看不出是哪一侧的锅。任一源本轮采集失败（ok=False）同样要登记，
    # 否则「静默少数据」和「数据源没配」在界面上长得一模一样。
    if args.source in ("both", "shzu", "lvcc"):
        ingest["sources"] = []
    if args.source in ("both", "shzu"):
        ingest["sources"].append({
            "id": "shzu",
            "name": "石河子大学充电桩",
            "host": SHZU_BASE,
            "ok": bool(shzu_ok),
            "throttled": False,
            "blocked_since": None,
            "retry_after": None,
            "frozen_ports": None,
            "message": shzu_err or "",
        })
    if args.source in ("both", "lvcc"):
        waf = lvcc_state_summary()
        ingest["sources"].append({
            "id": "lvcc",
            "name": "充充充充电桩-铭创电子",
            "host": LVCC_BASE,
            "ok": bool(lvcc_ok) and not waf,
            "throttled": bool(waf),
            "blocked_since": (waf or {}).get("since"),
            "retry_after": (waf or {}).get("retry_after"),
            "frozen_ports": (waf or {}).get("frozen_count"),
            "message": (waf or {}).get("message") or (lvcc_err or ""),
        })
        if waf and verbose:
            print("[B] ⚠ 风控退避中：数据暂时停在 %s，约 %s 重试"
                  % (waf.get("since"), waf.get("retry_after")))

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(ingest, f, ensure_ascii=False, indent=1)

    nports = sum(len(s["devices"]) for s in stations)
    per = {}
    for s in stations:
        a = s.get("raw_area") or "_未归区"
        per[a] = per.get(a, 0) + len(s["devices"])
    if verbose:
        print()
        print("=" * 70)
        print("采集完成 %.1fs" % (time.time() - t0))
        print("  stations=%d  ports=%d  写入 %s (%.1f KB)"
              % (len(stations), nports, out, os.path.getsize(out) / 1024.0))
        for k in CAMPUS_ORDER:
            nm = CAMPUS_NAME[k]
            print("  %-8s %d 端口" % (nm, per.get(nm, 0)))
        if "_未归区" in per:
            print("  %-8s %d 端口（需补别名）" % ("_未归区", per["_未归区"]))
        print("=" * 70)

    if args.post:
        url = args.post.rstrip("/") + "/api/ingest"
        headers = ["Content-Type: application/json"]
        if args.token:
            headers.append("X-Relay-Token: " + args.token)
        cmd = [_curl_bin(), "-s", "-k", "--max-time", "60", "-X", "POST", url,
               "-H", headers[0]]
        if args.token:
            cmd.extend(["-H", headers[1]])
        cmd.extend(["--data-binary", "@" + out, "-w", "\n__HTTP__%{http_code}"])
        p = subprocess.run(cmd, capture_output=True)
        if p.returncode == 6 or not (p.stdout or b"").strip():
            extra = _dns.resolve_args(url) if _dns else []
            if extra:
                p = subprocess.run([cmd[0]] + extra + cmd[1:], capture_output=True)
        raw = p.stdout.decode("utf-8", "replace")
        m = re.search(r"\n__HTTP__(\d+)\s*$", raw)
        code = int(m.group(1)) if m else 0
        body = raw[:m.start()] if m else raw
        if verbose:
            print("POST %s -> HTTP %s  %s" % (url, code, body[:300]))
        if code != 200:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
