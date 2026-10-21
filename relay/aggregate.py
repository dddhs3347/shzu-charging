#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""relay/aggregate.py — 聚合、状态翻译、六校区归区、稳定 ID 与快照构造。

本模块是 relay 的「纯逻辑层」：不碰 HTTP、不碰 SQLite，只做数据变换，
因此可以被 server.py、demo.py 和 tests/test_relay.py 共同复用。

所有对外 JSON 结构严格来自 shared/contract.md：
  - Snapshot  : shzu.snapshot.v1
  - Ingest    : shzu.ingest.v1
  - History   : shzu.history.v1

只依赖 Python 标准库（Termux 里直接 python server.py 就能跑）。
"""

from __future__ import annotations

import copy
import json
import os
import re
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------- #
# 常量 / 路径
# --------------------------------------------------------------------------- #

RELAY_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(RELAY_DIR)
SHARED_DIR = os.path.join(PROJECT_ROOT, "shared")
DEMO_DIR = os.path.join(PROJECT_ROOT, "demo")
CAMPUS_FILE = os.path.join(SHARED_DIR, "campus.json")

SNAPSHOT_SCHEMA = "shzu.snapshot.v1"
INGEST_SCHEMA = "shzu.ingest.v1"
HISTORY_SCHEMA = "shzu.history.v1"
UNASSIGNED_SCHEMA = "shzu.unassigned.v1"

FREE = "free"
BUSY = "busy"
OFFLINE = "offline"
UNKNOWN = "unknown"
STATUSES = (FREE, BUSY, OFFLINE, UNKNOWN)

#: 契约 §2.5：now - data_at > 15 分钟即 stale
STALE_MINUTES = 15

#: 契约 §2.4：时间一律 +08:00（石河子大学所在地，无夏令时）
LOCAL_TZ = timezone(timedelta(hours=8))

#: 契约 §5 允许的时间桶
BUCKETS = {"1m": 60, "5m": 300, "10m": 600, "30m": 1800, "1h": 3600}

#: 契约 §6.3 的虚拟校区（不属于六大校区，单独展示）
UNASSIGNED_CAMPUS = "_unassigned"

#: 契约 §2 示例里的 applet 名称
APPLET_NAME = "石河子大学充电桩"


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #

def load_json(path):
    """读 JSON，显式 utf-8（Windows 上默认编码是 GBK，必须显式）。"""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def coerce_str(value):
    """把任意值转成稳定的字符串（用于 raw_id / raw_status 等）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def optional_str(value):
    """允许为 null 的字符串字段：空串归一化成 None。"""
    if value is None:
        return None
    text = coerce_str(value)
    return text if text != "" else None


def optional_number(value):
    """允许为 null 的数值字段；能转就转，转不了返回 None（不猜测）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                return None
            return int(value) if value.is_integer() else value
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            num = float(text)
        except ValueError:
            return None
        if num != num or num in (float("inf"), float("-inf")):
            return None
        return int(num) if num.is_integer() else num
    return None


# --------------------------------------------------------------------------- #
# 时间（契约 §2.4：ISO8601 带时区偏移，不用 Unix 时间戳对外暴露）
# --------------------------------------------------------------------------- #

def now_local():
    return datetime.now(LOCAL_TZ)


def iso(dt):
    """datetime → 契约要求的 ISO8601 字符串（秒精度，带 +08:00 偏移）。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt.astimezone(LOCAL_TZ).isoformat(timespec="seconds")


def now_iso():
    return iso(now_local())


def iso_from_epoch(epoch):
    return iso(datetime.fromtimestamp(float(epoch), LOCAL_TZ))


def parse_iso(text):
    """解析 ISO8601；无时区的按 +08:00 处理；解析失败返回 None。"""
    if not isinstance(text, str):
        return None
    raw = text.strip()
    if not raw:
        return None
    if raw.endswith("Z") or raw.endswith("z"):
        raw = raw[:-1] + "+00:00"
    candidate = raw.replace(" ", "T", 1) if ("T" not in raw and " " in raw) else raw
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt


def epoch_of(dt):
    if dt is None:
        return None
    return int(dt.timestamp())


def is_stale(data_at, now_epoch=None, minutes=STALE_MINUTES):
    """契约 §2.5：data_at 缺失视为 stale；否则 now - data_at > 15min。"""
    dt = parse_iso(data_at) if isinstance(data_at, str) else data_at
    if dt is None:
        return True
    if now_epoch is None:
        now_epoch = datetime.now(timezone.utc).timestamp()
    age = float(now_epoch) - dt.timestamp()
    return age > minutes * 60


# --------------------------------------------------------------------------- #
# 状态翻译（契约 §1 / §3）
# --------------------------------------------------------------------------- #

def normalize_status_token(value):
    """raw_status 归一化：转字符串、去空白、转小写。

    注意：**不做**「猜测」。`"2"` 就是 `"2"`，映射表里没有就是 unknown。
    """
    return coerce_str(value).lower()


def normalize_status_map(mapping):
    """把 status_map 规整成 {token: status}，token 已归一化。

    容忍 `{"free": "0"}` 这种非数组写法（采集器可能偷懒）。
    支持独立的 `unknown` 列表：契约里 UNKNOWN 表示「取不到状态」，既不是空闲
    也不是离线。采集器若把 UNKNOWN 塞进 offline 列表（例如源 B 被风控时全部
    端口标 UNKNOWN），这里会把它纠正回 unknown —— 否则 App 上会把「取不到状态」
    渲染成红色「离线」，是明确的错误信息。
    """
    result = {}
    if not isinstance(mapping, dict):
        return result
    for status in (FREE, BUSY, OFFLINE, UNKNOWN):
        tokens = mapping.get(status)
        if isinstance(tokens, str):
            tokens = [tokens]
        elif isinstance(tokens, (list, tuple)):
            tokens = list(tokens)
        else:
            continue
        for token in tokens:
            key = normalize_status_token(token)
            if key and key not in result:
                result[key] = status
    # 纠正：UNKNOWN 词条只能是 unknown，不能是 offline/busy/free
    if normalize_status_token(UNKNOWN) in result:
        result[normalize_status_token(UNKNOWN)] = UNKNOWN
    return result


def merge_status_maps(default_map, override_map):
    """默认映射 + 覆盖映射（覆盖优先）。"""
    merged = dict(default_map or {})
    merged.update(override_map or {})
    return merged


def coerce_override_map(mapping):
    """把 ingress 带来的 ``status_map`` 统一成 ``{token: status}``。

    允许两种写法（契约 §3 的原始形态 + 内部已归一化形态）：
      - ``{"free": ["0"], "busy": ["1"]}``        ← 采集器上报的样子
      - ``{"0": "free", "1": "busy"}``            ← 归一化后的样子
    两种都接受，避免「已经归一化过的映射再被当成状态名」而静默失效。
    """
    if not isinstance(mapping, dict) or not mapping:
        return {}
    normalized = {}
    for key, value in mapping.items():
        if isinstance(value, str) and value in STATUSES:
            token = normalize_status_token(key)
            if token:
                normalized[token] = value
    if normalized:
        return normalized
    return normalize_status_map(mapping)


# --------------------------------------------------------------------------- #
# totals / free_ratio（契约 §2.1-2.3）
# --------------------------------------------------------------------------- #

def zero_totals():
    return {
        "total": 0,
        "free": 0,
        "busy": 0,
        "offline": 0,
        "unknown": 0,
        "free_ratio": 0.0,
    }


def totals_from_counts(free=0, busy=0, offline=0, unknown=0):
    """契约 §2.2/§2.3：total = 四态之和；free_ratio = free/(total-unknown)。"""
    total = free + busy + offline + unknown
    denom = total - unknown
    ratio = 0.0 if denom <= 0 else round(float(free) / float(denom), 4)
    return {
        "total": total,
        "free": free,
        "busy": busy,
        "offline": offline,
        "unknown": unknown,
        "free_ratio": ratio,
    }


def sum_totals(items):
    """累加一串 totals 字典（保持契约字段顺序）。"""
    free = busy = offline = unknown = 0
    for item in items or []:
        free += int(item.get("free") or 0)
        busy += int(item.get("busy") or 0)
        offline += int(item.get("offline") or 0)
        unknown += int(item.get("unknown") or 0)
    return totals_from_counts(free=free, busy=busy, offline=offline, unknown=unknown)


# --------------------------------------------------------------------------- #
# 六校区归区（契约 §6.3 / §6.4）
# --------------------------------------------------------------------------- #

_STRIP_PARENS = re.compile(r"[（(【\[][^）)】\]]*[）)】\]]")
_SPACE_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[·•,，.。/\\|_\-—:：;；!！?？\"'“”‘’`~+*#@$%^&]+")


def normalize_match_text(text):
    """归一化：去括号内容、去空白、去标点、转小写（与 sniffer 保持一致）。"""
    if text is None:
        return ""
    out = str(text)
    out = _STRIP_PARENS.sub("", out)
    out = _SPACE_RE.sub("", out)
    out = _PUNCT_RE.sub("", out)
    return out.lower()


class CampusRegistry:
    """shared/campus.json 的只读封装：校区顺序、alias 最长匹配、状态映射兜底。"""

    def __init__(self, campus_file=None):
        self.path = os.path.abspath(campus_file or CAMPUS_FILE)
        data = load_json(self.path)
        self.schema = data.get("schema") or "shzu.campus.v1"
        self.school = data.get("school") or "石河子大学"
        raw_campuses = data.get("campuses") or []
        # 契约 §2.1：campuses 顺序按 campus.json 的 order
        self.campuses = sorted(
            [c for c in raw_campuses if isinstance(c, dict) and c.get("id")],
            key=lambda c: (int(c.get("order") or 99), str(c.get("id"))),
        )
        self.default_status_map = normalize_status_map(data.get("status_map") or {})

        # alias 表：长度降序 → 校区顺序升序（更具体的优先，契约 §6.4）
        raw_pairs = []
        for campus in self.campuses:
            cid = campus["id"]
            order = int(campus.get("order") or 99)
            names = [campus.get("name") or ""] + list(campus.get("aliases") or [])
            for name in names:
                norm = normalize_match_text(name)
                if norm:
                    raw_pairs.append((len(norm), order, norm, cid))
        raw_pairs.sort(key=lambda item: (-item[0], item[1]))
        self._alias_pairs = raw_pairs

    # -- 校区元信息 ------------------------------------------------------ #
    @property
    def ids(self):
        return [c["id"] for c in self.campuses]

    def campus_list(self):
        """返回 [{"id","name","order","aliases"}]（已按 order 排序）。"""
        out = []
        for campus in self.campuses:
            out.append({
                "id": campus["id"],
                "name": campus.get("name") or campus["id"],
                "order": int(campus.get("order") or 99),
                "aliases": list(campus.get("aliases") or []),
            })
        return out

    def name_of(self, campus_id):
        for campus in self.campuses:
            if campus["id"] == campus_id:
                return campus.get("name") or campus_id
        if campus_id == UNASSIGNED_CAMPUS:
            return "未归类"
        return campus_id or ""

    def order_of(self, campus_id):
        for campus in self.campuses:
            if campus["id"] == campus_id:
                return int(campus.get("order") or 99)
        return 99

    # -- alias 匹配 ------------------------------------------------------ #
    def match(self, *texts):
        """在若干文本里找校区；返回 campus_id 或 None。

        规则（契约 §6.4）：一个站若命中多个校区，取**匹配到的 alias 最长者**
        （更具体优先），长度相同按校区 order。
        """
        haystack = normalize_match_text(" ".join(str(t) for t in texts if t))
        if not haystack:
            return None
        for _alias_len, _order, alias, campus_id in self._alias_pairs:
            if alias in haystack:
                return campus_id
        return None

    def match_station(self, raw_name=None, raw_area=None, address=None):
        """按**字段可信度**依次匹配，返回 campus_id 或 None。

        不能把三个字段拼成一个 haystack 交给 match()：真实数据里同一批设备
        的 address 常常是同一个笼统地址（绿充充全部是「石河子市-北四路221号
        大学北区」），而 raw_area 是采集器按设备名给出的**权威校区判定**。
        拼起来后，address 里的「北区」（alias 长 5、order 2）会压过 raw_area
        里的「南区」（同为长 5、order 5），导致南区整站被并进北区（实测 60 端口）。

        优先级：raw_area（权威）→ raw_name（站名）→ address（地理兜底）。
        """
        for text in (raw_area, raw_name, address):
            if not text:
                continue
            hit = self.match(text)
            if hit:
                return hit
        return None

    # -- 状态翻译 -------------------------------------------------------- #
    def translate(self, raw_status, override_map=None):
        """raw_status → free/busy/offline/unknown。

        契约 §3：campus.json.status_map 兜底，ingest 自带 status_map 优先；
        映射表里查不到的**不猜测**，一律 unknown。
        """
        token = normalize_status_token(raw_status)
        if not token:
            return UNKNOWN
        if override_map:
            hit = override_map.get(token)
            if hit in STATUSES:
                return hit
        return self.default_status_map.get(token, UNKNOWN)

    def status_map(self, override_map=None):
        return merge_status_maps(self.default_status_map, override_map)


# --------------------------------------------------------------------------- #
# 稳定 ID（契约 §6.1 / §6.2）
# --------------------------------------------------------------------------- #

class IdRegistry:
    """raw_id → 稳定 id 的映射表（relay 侧持久化，重启不重排）。

    契约 §6 把固化责任放在采集器，但 ingest 报文只带 raw_id，
    所以 relay 必须自己维护一份同样的映射，否则重启后 id 会重排、历史断裂。
    映射表由 server 存进 SQLite 的 state 表（JSON 字符串）。
    """

    VERSION = 1

    def __init__(self, data=None):
        data = data if isinstance(data, dict) else {}
        self.stations = dict(data.get("stations") or {})
        self.devices = dict(data.get("devices") or {})
        self.station_seq = dict(data.get("station_seq") or {})
        self.device_seq = dict(data.get("device_seq") or {})
        self.dirty = False

    # -- 序列化 ---------------------------------------------------------- #
    def export(self):
        return {
            "version": self.VERSION,
            "stations": self.stations,
            "devices": self.devices,
            "station_seq": self.station_seq,
            "device_seq": self.device_seq,
        }

    @classmethod
    def from_state(cls, data):
        return cls(data)

    # -- 键 -------------------------------------------------------------- #
    @staticmethod
    def station_key(raw_id, campus_id, name=""):
        raw = coerce_str(raw_id)
        if raw:
            return "raw:" + raw
        # 没有 raw_id 时退化到「校区 + 站名」，仍然稳定
        return "name:%s:%s" % (campus_id or UNASSIGNED_CAMPUS, normalize_match_text(name))

    @staticmethod
    def device_key(station_key, raw_device_id):
        return "%s||%s" % (station_key, coerce_str(raw_device_id))

    # -- 查询 ------------------------------------------------------------ #
    def station_campus(self, station_key):
        record = self.stations.get(station_key)
        return record.get("campus_id") if record else None

    def station_stable_id(self, station_key):
        record = self.stations.get(station_key)
        return record.get("stable_id") if record else None

    # -- 分配 ------------------------------------------------------------ #
    def station_id(self, raw_id, campus_id, name=""):
        """站点稳定 id：``<campus_id>-<两位序号>``（契约 §6.2）。"""
        campus = campus_id or UNASSIGNED_CAMPUS
        key = self.station_key(raw_id, campus_id, name)
        record = self.stations.get(key)
        if record and record.get("stable_id"):
            return record["stable_id"]
        seq = int(self.station_seq.get(campus, 0)) + 1
        self.station_seq[campus] = seq
        stable = "%s-%02d" % (campus, seq)
        self.stations[key] = {
            "stable_id": stable,
            "campus_id": campus,
            "raw_id": coerce_str(raw_id),
            "name": coerce_str(name),
            "seq": seq,
        }
        self.dirty = True
        return stable

    def device_id(self, station_key, station_stable_id, raw_device_id, code=None):
        """充电桩稳定 id：``<station_id>-<三位序号>``（契约 §6.2）。"""
        key = self.device_key(station_key, raw_device_id)
        record = self.devices.get(key)
        if record and record.get("stable_id"):
            return record["stable_id"]
        seq = int(self.device_seq.get(station_key, 0)) + 1
        self.device_seq[station_key] = seq
        stable = "%s-%03d" % (station_stable_id, seq)
        self.devices[key] = {
            "stable_id": stable,
            "station_stable_id": station_stable_id,
            "raw_id": coerce_str(raw_device_id),
            "code": coerce_str(code),
            "seq": seq,
        }
        self.dirty = True
        return stable


# --------------------------------------------------------------------------- #
# Ingest 校验与归一化（契约 §3 + shared/schema/ingest.schema.json）
# --------------------------------------------------------------------------- #

class IngestError(ValueError):
    """ingest 报文不合法 → server 返回 400 而不是 500。"""


def _require_device(raw_device, path):
    if not isinstance(raw_device, dict):
        raise IngestError("%s 必须是对象" % path)
    raw_id = coerce_str(raw_device.get("raw_id"))
    if not raw_id:
        raise IngestError("%s.raw_id 必须是非空字符串" % path)
    if "raw_status" not in raw_device:
        raise IngestError("%s.raw_status 必填（厂商原值，字符串）" % path)
    raw_status = raw_device.get("raw_status")
    if raw_status is None or isinstance(raw_status, (dict, list)):
        raise IngestError("%s.raw_status 必须是标量（字符串/数字）" % path)
    return {
        "raw_id": raw_id,
        "raw_status": coerce_str(raw_status),
        "code": optional_str(raw_device.get("code")),
        "name": optional_str(raw_device.get("name")),
        "power_w": optional_number(raw_device.get("power_w")),
    }


def validate_ingest(payload):
    """校验并归一化 ingest 报文；不合法抛 IngestError（server → 400）。

    严格程度：结构错误（schema 不符、stations 不是数组、device 缺 raw_id）拒绝；
    值的宽容度：raw_id/raw_status 是数字也接受（转字符串），不猜测状态。
    """
    if not isinstance(payload, dict):
        raise IngestError("请求体必须是 JSON 对象")

    schema = payload.get("schema")
    if schema != INGEST_SCHEMA:
        raise IngestError("schema 必须是 %r，实际 %r" % (INGEST_SCHEMA, schema))

    collected = parse_iso(payload.get("collected_at"))
    if collected is None:
        raise IngestError("collected_at 必须是 ISO8601 带时区的时间字符串")

    stations_raw = payload.get("stations")
    if not isinstance(stations_raw, list):
        raise IngestError("stations 必须是数组")

    status_map_raw = payload.get("status_map")
    if status_map_raw is not None and not isinstance(status_map_raw, dict):
        raise IngestError("status_map 必须是对象（free/busy/offline 三个数组）")
    status_map = normalize_status_map(status_map_raw or {})

    stations = []
    for index, raw_station in enumerate(stations_raw):
        path = "stations[%d]" % index
        if not isinstance(raw_station, dict):
            raise IngestError("%s 必须是对象" % path)
        raw_id = coerce_str(raw_station.get("raw_id"))
        if not raw_id:
            raise IngestError("%s.raw_id 必须是非空字符串" % path)
        devices_raw = raw_station.get("devices")
        if not isinstance(devices_raw, list):
            raise IngestError("%s.devices 必须是数组" % path)
        devices = []
        for dev_index, raw_device in enumerate(devices_raw):
            devices.append(_require_device(raw_device, "%s.devices[%d]" % (path, dev_index)))
        stations.append({
            "raw_id": raw_id,
            "raw_name": optional_str(raw_station.get("raw_name")),
            "raw_area": optional_str(raw_station.get("raw_area")),
            "address": optional_str(raw_station.get("address")),
            "lat": optional_number(raw_station.get("lat")),
            "lng": optional_number(raw_station.get("lng")),
            "devices": devices,
        })

    # 数据源健康状态（可选）：源 B 被风控时采集器会把 ok=false 传上来，
    # relay 透传到 snapshot.source_warnings，App 才能显示「数据暂时停在某时某分」
    sources = []
    for raw_src in payload.get("sources") or []:
        if not isinstance(raw_src, dict):
            continue
        sources.append({
            "id": optional_str(raw_src.get("id")),
            "name": optional_str(raw_src.get("name")),
            "host": optional_str(raw_src.get("host")),
            "ok": bool(raw_src.get("ok")) if raw_src.get("ok") is not None else True,
            "throttled": bool(raw_src.get("throttled")),
            "blocked_since": optional_str(raw_src.get("blocked_since")),
            "retry_after": optional_str(raw_src.get("retry_after")),
            "frozen_ports": optional_number(raw_src.get("frozen_ports")),
            "message": optional_str(raw_src.get("message")) or "",
        })

    return {
        "schema": INGEST_SCHEMA,
        "collected_at": iso(collected),
        "collector": optional_str(payload.get("collector")),
        "site": optional_str(payload.get("site")),
        # 多源异速刷新后新增：报文的 source_id 决定「这份数据存在哪个源名下」。
        # 缺省为 None，server 会落到 "default"，旧采集器行为完全不变。
        "source_id": optional_str(payload.get("source_id")),
        "status_map": status_map,
        "sources": sources,
        "stations": stations,
    }


# --------------------------------------------------------------------------- #
# 聚合：ingest → snapshot + 时序点
# --------------------------------------------------------------------------- #

def _station_sort_key(item):
    """按稳定 id 的自然长度排序：-01 … -99 之后才是 100（不是纯字典序）。"""
    value = item.get("id") or ""
    return (len(value), value)


def _device_sort_key(item):
    value = item.get("id") or ""
    return (len(value), value)


def _attach_source_health(snapshot, src_health):
    """把采集器自报的数据源健康状态挂到快照上，并据此生成风控提示。

    抽成独立函数是因为**单源 ingest 和多源合并两条路径都要用**：
    只在 ``aggregate_ingest`` 里生成的话，双源部署下 source_warning 会永远是
    None（合并快照是后一步才拼出来的），App 上「数据暂时停在某时某分」
    的黄色提示条就永远不会出现。
    """
    if not src_health:
        return
    snapshot["sources"] = src_health
    throttled = [s for s in src_health if s.get("throttled")]
    if not throttled:
        return
    names = "、".join((s.get("name") or s.get("id") or "某数据源") for s in throttled)
    # blocked_since 可能缺失（早期采集器没带这个字段），回退顺序：
    # 该源自己的 updated_at（就是它最后一次成功采集的时刻）→ 快照 data_at。
    # 注意不能直接用 data_at：那在多源合并里是「所有源里最新的那个」，
    # 源 A 每 15 秒刷新一次，data_at 永远是源 A 的时间，拿来当源 B 的
    # 「停在某时某分」会显示成一个刚更新的假时间。
    blocked_since = None
    for s in throttled:
        if s.get("blocked_since"):
            blocked_since = s["blocked_since"]
            break
    if not blocked_since:
        for s in throttled:
            if s.get("updated_at"):
                blocked_since = s["updated_at"]
                break
    if not blocked_since:
        blocked_since = snapshot.get("data_at")
    snapshot["source_warning"] = {
        "reason": "throttled",
        "text": "%s 被风控限流拦截，数据暂时停止刷新" % names,
        "sources": [s.get("id") for s in throttled],
        "blocked_since": blocked_since,
        "retry_after": throttled[0].get("retry_after"),
    }


def _source_block(collector, totals, demo=False, confidence=None):
    """契约 §2 的 ``source`` 块。

    ``confidence`` 优先采用采集器自报值（ingest 里的 ``confidence``）；
    没报时按**这次数据里能判定状态的桩占比**推导
    （``(total - unknown) / total``）——unknown 越多，这份快照越不可信。
    两种都不是随机数。
    """
    total = int((totals or {}).get("total") or 0)
    unknown = int((totals or {}).get("unknown") or 0)
    if confidence is None:
        confidence = (round((total - unknown) / total, 4) if total > 0 else 0.0)
    else:
        confidence = round(float(confidence), 4)
        confidence = max(0.0, min(1.0, confidence))
    return {
        "kind": "demo" if demo else "poll",
        "applet": APPLET_NAME,
        "collector": collector or "unknown",
        "confidence": confidence,
    }


def _assemble_snapshot(registry, campus_stations, generated_at, data_at,
                       source=None, demo=False):
    """把「校区 → 站点列表」装配成契约快照（六校区恒 6 项且顺序固定）。"""
    campuses = []
    for meta in registry.campus_list():
        campus_id = meta["id"]
        stations = campus_stations.get(campus_id) or []
        stations = sorted(stations, key=_station_sort_key)
        campus_totals = sum_totals([st["totals"] for st in stations])
        campuses.append({
            "id": campus_id,
            "name": meta["name"],
            "order": meta["order"],
            "totals": campus_totals,
            "stations": stations,
        })

    grand = sum_totals([c["totals"] for c in campuses])
    snapshot = {
        "schema": SNAPSHOT_SCHEMA,
        "generated_at": generated_at,
        "data_at": data_at,
        "stale": False,  # 最终由 server 按「当前时间」重算
        "totals": grand,
        "campuses": campuses,
    }
    if source is not None:
        snapshot["source"] = source
    if demo:
        snapshot["demo"] = True
    return snapshot


def aggregate_ingest(payload, registry, ids=None, generated_epoch=None):
    """ingest（已 validate）→ snapshot + 时序点 + 未归类站点。

    返回：
        {
          "snapshot": {...shzu.snapshot.v1...},
          "points": [{"campus_id","free","busy","offline","unknown","total"} × 6],
          "unassigned": [station, ...],   # campus_id = "_unassigned"，不进快照六校区
          "accepted": int,                # 接受的充电桩数量
          "data_at": "ISO8601",
        }
    """
    if not isinstance(payload, dict):
        raise IngestError("payload 必须是对象")
    registry = registry or CampusRegistry()
    ids = ids if ids is not None else IdRegistry()

    collected = parse_iso(payload.get("collected_at"))
    if collected is None:
        raise IngestError("collected_at 必须是 ISO8601 带时区的时间字符串")
    data_at = iso(collected)
    generated_at = iso_from_epoch(generated_epoch) if generated_epoch else now_iso()

    override_map = coerce_override_map(payload.get("status_map") or {})
    campus_stations = {cid: [] for cid in registry.ids}
    unassigned = []
    accepted = 0
    unassigned_seq = 0

    for raw_station in payload.get("stations") or []:
        raw_id = raw_station.get("raw_id") or ""
        raw_name = raw_station.get("raw_name") or ""
        raw_area = raw_station.get("raw_area")
        address = raw_station.get("address")

        matched = registry.match_station(raw_name=raw_name, raw_area=raw_area, address=address)
        station_key = IdRegistry.station_key(raw_id, matched, raw_name)
        # 已固化过的站保持原校区（id 里带着校区前缀，改了会破坏历史连续性）
        existing_campus = ids.station_campus(station_key)
        campus_id = existing_campus or matched
        if campus_id not in campus_stations:
            campus_id = None

        if campus_id is None:
            station_stable = ids.station_id(raw_id, None, raw_name)
            station_campus = UNASSIGNED_CAMPUS
        else:
            station_stable = ids.station_id(raw_id, campus_id, raw_name)
            station_campus = campus_id

        devices = []
        counts = {FREE: 0, BUSY: 0, OFFLINE: 0, UNKNOWN: 0}
        for dev_seq, raw_device in enumerate(raw_station.get("devices") or []):
            status = registry.translate(raw_device.get("raw_status"), override_map)
            counts[status] += 1
            device_stable = ids.device_id(
                station_key, station_stable,
                raw_device.get("raw_id"), raw_device.get("code"),
            )
            if not device_stable:  # pragma: no cover - 防御
                device_stable = "%s-%03d" % (station_stable, dev_seq + 1)
            devices.append({
                "id": device_stable,
                "code": raw_device.get("code"),
                "name": raw_device.get("name"),
                "status": status,
                "power_w": raw_device.get("power_w"),
                "busy_since": None,   # 契约允许 null：ingest 报文没有该信息
                "order_id": None,     # 同上
            })
        accepted += len(devices)

        station = {
            "id": station_stable,
            "name": raw_name or "未命名充电站",
            "campus_id": station_campus,
            "address": address,
            "lat": raw_station.get("lat"),
            "lng": raw_station.get("lng"),
            "totals": totals_from_counts(
                free=counts[FREE], busy=counts[BUSY],
                offline=counts[OFFLINE], unknown=counts[UNKNOWN],
            ),
            "updated_at": data_at,
            "devices": sorted(devices, key=_device_sort_key),
        }
        # 多源（源 A / 源 B）接入后新增：站点要能追溯自己是哪个源采的，
        # 否则 App 的端口表无法按数据源筛选。旧采集器报文不带 source_id，
        # 这里就**不加这个键**，老快照/老客户端读取行为完全不变。
        station_source = payload.get("source_id")
        if station_source:
            station["source_id"] = station_source
        if campus_id is None:
            unassigned.append(station)
        else:
            campus_stations[campus_id].append(station)

    snapshot = _assemble_snapshot(registry, campus_stations, generated_at, data_at)
    # ingest 契约里没有 confidence 字段（§3 只有 schema/collected_at/status_map/
    # collector/site/stations），所以这里按数据自身的可判定比例推导，不额外要字段。
    snapshot["source"] = _source_block(
        payload.get("collector"), snapshot["totals"], demo=False,
    )
    # 数据源健康状态透传：某个源被风控限流时，App 要能显示
    #「某数据源被风控拦截，数据暂时停在某时某分」，而不是默默显示 0 端口。
    src_health = [s for s in (payload.get("sources") or []) if isinstance(s, dict)]
    if src_health:
        _attach_source_health(snapshot, src_health)

    points = []
    for campus in snapshot["campuses"]:
        totals = campus["totals"]
        points.append({
            "campus_id": campus["id"],
            "free": totals["free"],
            "busy": totals["busy"],
            "offline": totals["offline"],
            "unknown": totals["unknown"],
            "total": totals["total"],
        })

    return {
        "snapshot": snapshot,
        "points": points,
        "unassigned": unassigned,
        "accepted": accepted,
        "data_at": data_at,
    }


# --------------------------------------------------------------------------- #
# 空快照 / 快照刷新
# --------------------------------------------------------------------------- #

def fill_campuses(campuses, registry):
    """把任意 campuses 数组补齐/裁剪成「六大校区、固定顺序」。"""
    by_id = {}
    for campus in campuses or []:
        if isinstance(campus, dict) and campus.get("id") in registry.ids:
            by_id[campus["id"]] = campus
    out = []
    for meta in registry.campus_list():
        campus = by_id.get(meta["id"])
        if campus is None:
            campus = {
                "id": meta["id"],
                "name": meta["name"],
                "order": meta["order"],
                "totals": zero_totals(),
                "stations": [],
            }
        else:
            # 复制一层，避免上游修改污染调用方持有的快照对象
            campus = {
                "id": meta["id"],
                "name": campus.get("name") or meta["name"],
                "order": meta["order"],
                "totals": dict(campus.get("totals") or zero_totals()),
                "stations": list(campus.get("stations") or []),
            }
        out.append(campus)
    return out


def recount_station_totals(stations):
    """按 devices 的实际 status 重算站点 totals（结构性保证契约 §2.3）。"""
    for station in stations or []:
        counts = {FREE: 0, BUSY: 0, OFFLINE: 0, UNKNOWN: 0}
        for device in station.get("devices") or []:
            status = device.get("status")
            counts[status if status in counts else UNKNOWN] += 1
        station["totals"] = totals_from_counts(
            free=counts[FREE], busy=counts[BUSY],
            offline=counts[OFFLINE], unknown=counts[UNKNOWN],
        )
    return stations


def empty_snapshot(registry=None, generated_epoch=None, demo=False):
    """还没收到任何 ingest 时的合法快照：六校区全 0、data_at=null、stale=true。

    ``source.collector`` 用 ``unknown``：这时候确实还不知道采集器是谁，
    不能凭空写一个采集器名字（契约 §7 禁止伪造）。
    """
    registry = registry or CampusRegistry()
    generated_at = iso_from_epoch(generated_epoch) if generated_epoch else now_iso()
    snapshot = _assemble_snapshot(registry, {}, generated_at, None,
                                  source=_source_block(
                                      None, zero_totals(), demo=demo))
    snapshot["stale"] = True
    if demo:
        snapshot["demo"] = True
    return snapshot


def refresh_snapshot(stored, registry=None, demo=False, now_epoch=None):
    """每次 GET /api/snapshot 时刷新信封字段并重算 totals 链。

    重算是为了**结构性保证**契约不变量（§2 硬性规则 1/3）：
    不管库里存的快照是哪一版写的，对外返回的一定是
    「六校区 6 项、顺序固定、校区 totals = 站点之和、全局 = 六校区之和」。
    """
    registry = registry or CampusRegistry()
    snapshot = dict(stored) if isinstance(stored, dict) else empty_snapshot(registry)
    snapshot["schema"] = SNAPSHOT_SCHEMA
    snapshot["generated_at"] = iso_from_epoch(now_epoch) if now_epoch else now_iso()
    snapshot["stale"] = is_stale(snapshot.get("data_at"), now_epoch)

    campuses = fill_campuses(snapshot.get("campuses"), registry)
    for campus in campuses:
        stations = campus.get("stations")
        if not isinstance(stations, list):
            stations = []
        # 深拷贝站点，避免改坏调用方（或库里缓存）持有的快照对象
        stations = [copy.deepcopy(st) if isinstance(st, dict) else st
                    for st in stations]
        campus["stations"] = recount_station_totals(stations)
        campus["totals"] = sum_totals([st.get("totals") or {} for st in stations])
    snapshot["campuses"] = campuses
    snapshot["totals"] = sum_totals([c["totals"] for c in campuses])

    # source 块：保留采集器身份，但置信度按**当前**数据重算（unknown 变了就变）
    old_source = snapshot.get("source") if isinstance(snapshot.get("source"), dict) else {}
    source = _source_block(
        old_source.get("collector"),
        snapshot["totals"],
        demo=demo,
    )
    if old_source.get("applet"):
        source["applet"] = old_source["applet"]
    snapshot["source"] = source

    if demo:
        snapshot["demo"] = True
    return snapshot


def source_campus_breakdown(payload, registry=None):
    """单个数据源的「分校区明细」，供 ``sources[].campuses`` 使用。

    只列出该源**真的有站点**的校区（没有数据的校区不占位：App 那边是
    「点开源 → 看它在哪些校区有端口」，列出一堆 0 端口的校区等于噪音）。
    顺序按 campus.json 的 order 升序。

    计数不从 payload 里现成的 totals 抄，而是重新遍历设备的 status 累加，
    这样即使上游写坏了 totals 字段，这里的口径也一定是
    total = free+busy+offline+unknown、free_ratio = free/(total-unknown)。
    """
    registry = registry or CampusRegistry()
    by_id = {}
    for campus in (payload or {}).get("campuses") or []:
        if not isinstance(campus, dict):
            continue
        campus_id = campus.get("id")
        if campus_id not in registry.ids:
            continue
        stations = [st for st in campus.get("stations") or [] if isinstance(st, dict)]
        if not stations:
            continue
        counts = {FREE: 0, BUSY: 0, OFFLINE: 0, UNKNOWN: 0}
        for station in stations:
            station_counts = _counts_of(station)
            for key in counts:
                counts[key] += station_counts[key]
        by_id[campus_id] = {
            "id": campus_id,
            "name": registry.name_of(campus_id),
            "order": registry.order_of(campus_id),
            "totals": totals_from_counts(
                free=counts[FREE], busy=counts[BUSY],
                offline=counts[OFFLINE], unknown=counts[UNKNOWN],
            ),
            "stations": len(stations),
        }
    return sorted(by_id.values(), key=lambda item: (item["order"], item["id"]))


def merge_source_snapshots(parts, registry=None, generated_epoch=None, demo=False):
    """把多个数据源各自的聚合结果合并成**一份**快照。

    背景：采集端是双源异速的——源 A 每 15 秒一轮、源 B 每 2~3 分钟一轮。
    如果 relay 对每次 ingest 都「整份快照替换」，只更新源 A 的那一轮会把源 B
    的站点整体挤掉（用户会看到南区 60 个端口突然消失又出现）。
    所以每个源单独存，合并在读的时候做。

    合并规则：
      - 站点：按 id 去重。同 id 出现两次时取 ``updated_at`` 更新/更新的那份
        （正常情况下不会冲突：源 B 的站名带后缀，IdRegistry 给的是不同 id）。
      - 校区：固定六项、顺序由 campus.json 决定（复用 fill_campuses）。
      - totals / free_ratio：**重算**，不合并任何对方的计数，分母仍是 total-unknown。
      - data_at：取所有源里**最新的**；stale 由 server 按这个值算。
      - sources：汇总每个源自己的健康状态，供 App 显示「源 A 15 秒前 / 源 B 3 分钟前」。

    ``parts`` 每项形如 ``{"source_id": str, "updated_epoch": int, "data_at": str|None,
    "payload": snapshot}``，payload 可以是 None（该源还没聚合成功，跳过）。
    """
    registry = registry or CampusRegistry()
    generated_at = iso_from_epoch(generated_epoch) if generated_epoch else now_iso()

    # ---- 丢掉僵尸 "default" 分区 ------------------------------------
    #
    # 背景：分区功能上线之前，采集端用 --source both 发的是**整份**数据、
    # 不带 source_id，落到 relay 就叫 "default"。切换到分区采集后，"default"
    # 里那份就成了旧的全量副本：它同时包含源 A 和源 B 的站点，而且时间戳
    # 停在切换那一刻，不会再更新。
    #
    # 为什么不直接删库里的行：一是删了就再也回不到"只有一份混合数据"的
    # 老形态，二是读侧过滤就够——只要存在任何一个**带真实数据**的专用
    # 分区，"default" 就必然是更旧的全量副本，直接忽略即可。它里面的站点
    # 与专用分区里的站点 id 相同，本来也会被下面的去重逻辑覆盖掉。
    #
    # 顺带挡住了 App 端的可见 bug：/api/sources 会把 default 列成第三个源，
    # 名字为 null，用户在"数据源"面板上看到一个既没有名字也没有 host 的条目。
    #
    # 如果专用分区全没了（比如采集脚本回退到旧版本），"default" 会被
    # 重新启用——这正是我们要的向后兼容行为。
    _has_real = any(
        isinstance((p or {}).get("payload"), dict)
        and ((p or {}).get("source_id") or "default") != "default"
        for p in (parts or [])
    )
    if _has_real:
        parts = [p for p in (parts or []) if (p or {}).get("source_id") != "default"]
    else:
        parts = list(parts or [])

    # 先按各源「上次成功采集的时间」升序排：同 id 冲突时让**更晚**的源覆盖更早的。
    # 不排的话冲突只能靠 station.updated_at 判，而同一次 merge 里两个源常常在
    # 同一秒内写入，updated_at 相同就只能靠遍历顺序，结果不可预期。
    ordered = sorted(
        enumerate(parts or []),
        key=lambda pair: (int((pair[1] or {}).get("updated_epoch") or 0), pair[0]),
    )

    stations_by_id = {}
    station_order = []
    source_states = []
    data_ats = []

    for seq, part in ordered:
        payload = part.get("payload")
        source_id = part.get("source_id") or "default"
        entry = {
            "id": source_id,
            "updated_at": part.get("data_at"),
            "updated_epoch": int(part.get("updated_epoch") or 0),
        }
        if not isinstance(payload, dict):
            source_states.append(entry)
            if part.get("data_at"):
                data_ats.append(part.get("data_at"))
            continue
        for campus in payload.get("campuses") or []:
            campus_id = campus.get("id")
            if campus_id not in registry.ids:
                continue
            for station in campus.get("stations") or []:
                if not isinstance(station, dict):
                    continue
                sid = station.get("id")
                if not sid:
                    continue
                existing = stations_by_id.get(sid)
                if existing is None:
                    stations_by_id[sid] = {
                        "station": copy.deepcopy(station),
                        "campus_id": campus_id,
                        "seq": seq,
                    }
                    station_order.append(sid)
                    continue
                # 同 id 冲突：station.updated_at 更新者胜；完全相同时按 part 顺序
                # 后者胜（上面已经按 updated_epoch 升序排过了）。
                old_at = existing["station"].get("updated_at") or ""
                new_at = station.get("updated_at") or ""
                if (new_at, seq) > (old_at, existing["seq"]):
                    existing["station"] = copy.deepcopy(station)
                    existing["campus_id"] = campus_id
                    existing["seq"] = seq
        # 采集器自报的健康状态（源 B 被风控时）优先于下面那条兜底 entry：
        # 所以先把 sources 里的条目收走，收走后 continue 跳过兜底。
        for src in payload.get("sources") or []:
            if isinstance(src, dict):
                merged_src = dict(src)
                if not merged_src.get("id"):
                    merged_src["id"] = source_id
                source_states.append(merged_src)
                continue
        src_block = payload.get("source")
        if isinstance(src_block, dict):
            entry["collector"] = src_block.get("collector")
            entry["kind"] = src_block.get("kind")
        entry["totals"] = payload.get("totals")
        # 分校区明细（task-7）：App 点开「数据源」后要看这个源在各校区的分布。
        # totals / stations 都从明细重新累加，保证三条不变量是算出来的、
        # 而不是抄 payload 里可能过期的字段：
        #   各校区 totals 之和 == 该源 totals
        #   各校区 stations 之和 == 该源 stations
        #   station.source_id 能追到这些校区
        entry["campuses"] = source_campus_breakdown(payload, registry)
        entry["totals"] = sum_totals([c["totals"] for c in entry["campuses"]])
        entry["stations"] = sum(c["stations"] for c in entry["campuses"])
        # part 级 data_at 是 store 记录的「这个源最后一次成功采集的时刻」，
        # 权威性高于 payload 内部的副本（合并快照里 payload 可能是更早缓存的）。
        part_at = part.get("data_at") or payload.get("data_at")
        if part_at:
            entry["data_at"] = part_at
            data_ats.append(part_at)
        source_states.append(entry)

    # 同一轮里 sources 数组可能已经把该源登记过一次（自报健康状态），
    # 而这里的兜底 entry 又带 updated_at/totals。两份要**合并**而不是二选一：
    # 直接按 updated_at 挑一份会把 throttled/blocked_since 这类字段丢掉。
    deduped_sources = {}
    for src in source_states:
        key = src.get("id") or "default"
        prev = deduped_sources.get(key)
        if prev is None:
            deduped_sources[key] = src
            continue
        merged = dict(prev)
        for field, value in src.items():
            if value is None or value == "" or value == {}:
                continue
            merged[field] = value
        # updated_at 取更晚的那个（ISO8601 同一时区可直接比字符串）
        if (src.get("updated_at") or "") > (prev.get("updated_at") or ""):
            merged["updated_at"] = src.get("updated_at")
        deduped_sources[key] = merged
    source_states = list(deduped_sources.values())

    campus_stations = {cid: [] for cid in registry.ids}
    for sid in station_order:
        item = stations_by_id[sid]
        station = item["station"]
        station["totals"] = totals_from_counts(**_counts_of(station))
        campus_stations[item["campus_id"]].append(station)

    data_at = max(data_ats) if data_ats else None
    campus_totals = {}
    for cid, stations in campus_stations.items():
        campus_totals[cid] = sum_totals([st.get("totals") or {} for st in stations])
    grand = sum_totals(list(campus_totals.values()))
    snapshot = _assemble_snapshot(
        registry, campus_stations, generated_at, data_at,
        source=_source_block(None, grand, demo=demo),
    )
    if source_states:
        # 走同一条健康状态出口，否则双源部署下 source_warning 会永远缺失。
        _attach_source_health(snapshot, source_states)
    return snapshot


def _counts_of(station):
    """按 devices 实际 status 统计站点四档计数（复用于合并路径）。"""
    counts = {FREE: 0, BUSY: 0, OFFLINE: 0, UNKNOWN: 0}
    for device in station.get("devices") or []:
        status = device.get("status")
        counts[status if status in counts else UNKNOWN] += 1
    return counts


def unassigned_payload(stations, generated_epoch=None, data_at=None, demo=False):
    """未归类站点（契约 §6.3）：不进六校区快照，单独一个入口给 App。"""
    payload = {
        "schema": UNASSIGNED_SCHEMA,
        "generated_at": iso_from_epoch(generated_epoch) if generated_epoch else now_iso(),
        "data_at": data_at,
        "campus_id": UNASSIGNED_CAMPUS,
        "name": "未归类",
        "stations": sorted(list(stations or []), key=_station_sort_key),
    }
    if demo:
        payload["demo"] = True
    return payload
