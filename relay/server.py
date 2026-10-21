#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""relay/server.py — 石河子大学充电桩中继服务（纯 Python 3 标准库）。

用法（Termux / Windows / Linux 通用）::

    python server.py                            # 默认 0.0.0.0:8080，数据在 relay/data/
    python server.py --port 8080 --data-dir ./data
    python server.py --demo --port 8080         # 演示模式（无需采集器，响应带 demo:true）

对外接口（严格按 shared/contract.md）::

    POST /api/ingest      shzu.ingest.v1       采集器上报原始设备列表
    GET  /api/snapshot    shzu.snapshot.v1     六校区恒定 6 项的核心快照
    GET  /api/history     shzu.history.v1      按桶均值的时序曲线
    GET  /api/health                           存活 / 上次采集 / 连续失败次数
    GET  /api/config                           给 App 的配置（校区列表等）
    GET  /api/events      text/event-stream    SSE：有新快照时通知 App 重取
    GET  /api/unassigned                       未归类站点（契约 §6.3，可选入口）
    GET  /*                                    静态托管 ../app/

只用标准库：http.server / sqlite3 / threading / json / gzip，
Termux 里 `python server.py` 直接跑，无需 pip 安装任何东西。
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import random
import sys
import threading
import time
import traceback
import urllib.parse
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 允许「从任意目录运行 python .../relay/server.py」
_RELAY_DIR = os.path.dirname(os.path.abspath(__file__))
if _RELAY_DIR not in sys.path:
    sys.path.insert(0, _RELAY_DIR)

import aggregate  # noqa: E402  (必须先补 sys.path)
import store as store_mod  # noqa: E402

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #

VERSION = "1.0.0"
RELAY_AGENT = "relay-" + VERSION
DEFAULT_PORT = 8080
DEFAULT_HOST = "0.0.0.0"          # 手机在同一 WiFi 下要能访问
DEFAULT_DATA_DIR = os.path.join(_RELAY_DIR, "data")
DEFAULT_POLL_INTERVAL = 60        # 采集器轮询间隔（秒），仅用于健康提示
DEFAULT_DEMO_INTERVAL = 20        # demo 模式演进间隔（秒）
DEFAULT_RETAIN_DAYS = store_mod.DEFAULT_RETAIN_DAYS
MAX_BODY_BYTES = 8 * 1024 * 1024  # 单次 ingest 上限 8MB
SSE_MAX_SECONDS = 300             # SSE 单连接最长存活，避免线程泄漏

APP_DIR = os.path.join(aggregate.PROJECT_ROOT, "app")

#: 静态文件 MIME 表（不用 mimetypes，避免 Windows 注册表干扰）
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".gif": "image/gif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

#: 值得 gzip 的类型后缀
GZIP_EXTS = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".map",
             ".txt", ".webmanifest", ".xml"}


# --------------------------------------------------------------------------- #
# 控制台 / 日志
# --------------------------------------------------------------------------- #

def _setup_console():
    """Windows 的 GBK 控制台打印中文会 UnicodeEncodeError，这里统一兜底。

    - 输出到终端（isatty）：保留终端编码，用 errors="replace"，中文变 ? 但不崩；
    - 输出到管道（被 verify_contract.py / nohup 捕获）：强制 UTF-8，
      和父进程 `encoding="utf-8"` 对齐，中文日志不乱码。
    """
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        try:
            if stream.isatty():
                stream.reconfigure(errors="replace")
            else:
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def log(message, *args):
    """带时间戳的单行日志；任何情况下都不能因为编码问题把服务打挂。"""
    text = message % args if args else message
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    try:
        print("[%s] %s" % (stamp, text))
        sys.stdout.flush()
    except Exception:  # pragma: no cover - 极端环境下 stdout 已关闭
        pass


# --------------------------------------------------------------------------- #
# 异常
# --------------------------------------------------------------------------- #

class HttpError(Exception):
    """约定好的 HTTP 错误（handler 捕获后返回 JSON）。"""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------- #
# 业务状态：把 store + aggregate 粘起来
# --------------------------------------------------------------------------- #

class RelayState:
    """relay 的全部运行时状态；所有写操作走 self.lock。"""

    def __init__(self, data_dir, demo=False, demo_interval=DEFAULT_DEMO_INTERVAL,
                 retain_days=DEFAULT_RETAIN_DAYS, token=None,
                 poll_interval=DEFAULT_POLL_INTERVAL, db_name="charging.db"):
        self.lock = threading.RLock()
        self.demo = bool(demo)
        self.demo_interval = max(1.0, float(demo_interval))
        self.token = token or None
        self.poll_interval = int(poll_interval)
        self.registry = aggregate.CampusRegistry()
        self.store = store_mod.Store(data_dir, db_name=db_name, retain_days=retain_days)
        self.started_at = time.time()
        self.started_iso = aggregate.now_iso()
        self.generation = 0
        self.demo_thread = None
        self._demo_fixture = None
        self._demo_tick = 0
        self._last_snapshot = None
        # 每个数据源上一次写进时序表的计数指纹（多源异速刷新防锯齿用）
        self._last_point_signature = {}

        # 稳定 id 映射表（契约 §6：重启不重排）与未归类站点
        self.ids = aggregate.IdRegistry.from_state(
            self.store.meta_get("id_registry") or {}
        )
        unassigned = self.store.meta_get("unassigned")
        self.unassigned = unassigned if isinstance(unassigned, list) else []

        # 只恢复同模式的快照：live 模式绝不能把上次 --demo 的数据当成真实数据返回
        stored = self.store.latest_snapshot(demo=True if self.demo else False)
        if isinstance(stored, dict):
            self._last_snapshot = stored
        else:
            self._last_snapshot = aggregate.empty_snapshot(self.registry, demo=self.demo)

    # ------------------------------------------------------------- 生命周期
    def close(self):
        try:
            self.store.close()
        except Exception:
            pass

    # ---------------------------------------------------------------- 快照
    def snapshot(self):
        """对外返回的快照：多源合并 + 每次重算 generated_at / stale / totals 链。

        合并而不是「整份替换」的原因：采集端双源异速（源 A 15 秒一轮、
        源 B 2~3 分钟一轮），整份替换会让慢的那个源的站点周期性消失。
        """
        with self.lock:
            base = self._merged_base()
        return aggregate.refresh_snapshot(base, self.registry, demo=self.demo)

    def _merged_base(self):
        """合并后的「基础快照」；无任何数据源时退回库里最后一份快照。"""
        parts = self.store.source_states(demo=self.demo)
        if not parts:
            return self._last_snapshot
        try:
            return aggregate.merge_source_snapshots(parts, self.registry)
        except Exception:  # pragma: no cover - 合并失败不该让接口 500
            log("多源合并失败，回退到最近一份快照：\n%s", traceback.format_exc())
            return self._last_snapshot

    # ------------------------------------------------------------ 数据源状态
    def sources(self):
        """GET /api/sources：每个数据源最后一次成功采集的状态。

        App 用它显示「源 A 15 秒前更新 / 源 B 3 分钟前更新」，以及源被风控时
        那部分数据停在什么时候。只列**真的**存在于 source_state 里的源——
        还没有数据源的部署（旧的单源 relay）这里返回空数组，前端整块隐藏。
        """
        now = time.time()
        with self.lock:
            parts = self.store.source_states(demo=self.demo)
            fallback = self._last_snapshot if not parts else None
        # 僵尸 "default" 分区过滤：分区功能上线前的老采集器发的是不带
        # source_id 的整份混合数据，落到 relay 就叫 "default"。切到分区采集后
        # 那份就是冻结的旧全量副本——既不会更新，又会在"数据源"面板上显示成
        # 一个没有名字的第三个源。判断规则与 merge_source_snapshots 一致：
        # 只要还有任何**带真实数据**的专用分区，default 就必然是旧副本。
        # 两边必须同步改，否则 App 显示的源数会比快照实际合并的源多一个。
        if any(
            isinstance((p or {}).get("payload"), dict)
            and (p or {}).get("source_id") not in (None, "", "default")
            for p in (parts or [])
        ):
            parts = [p for p in (parts or []) if p.get("source_id") != "default"]
        # 只有库里**真有数据**时才用兜底：启动时 _last_snapshot 是空快照，
        # 直接兜底会凭空造出一个 0 端口的「default」源，前端就以为接了一个源。
        if fallback is not None and not (fallback.get("totals") or {}).get("total"):
            fallback = None
        out = []
        for part in parts:
            payload = part.get("payload") or {}
            totals = payload.get("totals") or {}
            # 分校区明细：App 点开某个数据源时要看它在各校区各有多少端口。
            # 与 /api/snapshot 里 sources[].campuses 用同一个函数生成，
            # 免得两个接口对同一个源给出不一致的数字。
            breakdown = aggregate.source_campus_breakdown(payload, self.registry)
            entry = {
                "source_id": part["source_id"],
                "updated_at": part.get("data_at"),
                "age_s": self._age_s(part.get("updated_epoch"), now),
                # stations 也从明细累加：明细里只算 dict 形态的站点，
                # 这样它的和必然等于 campuses[].stations 之和，前端拿哪边都对得上。
                "stations": sum(c["stations"] for c in breakdown),
                "devices": int(totals.get("total") or 0),
                "free": int(totals.get("free") or 0),
                "busy": int(totals.get("busy") or 0),
                "offline": int(totals.get("offline") or 0),
                "unknown": int(totals.get("unknown") or 0),
                "throttled": False,
                "blocked_since": None,
                "campuses": breakdown,
            }
            for src in payload.get("sources") or []:
                if isinstance(src, dict) and (src.get("id") or "default") == part["source_id"]:
                    entry["name"] = src.get("name")
                    entry["host"] = src.get("host")
                    entry["throttled"] = bool(src.get("throttled"))
                    entry["blocked_since"] = src.get("blocked_since")
                    entry["retry_after"] = src.get("retry_after")
                    entry["message"] = src.get("message")
                    entry["collector"] = (payload.get("source") or {}).get("collector")
                    break
            if "name" not in entry:
                entry["name"] = None
                entry["collector"] = (payload.get("source") or {}).get("collector")
            out.append(entry)

        result = {
            "schema": "shzu.sources.v1",
            "generated_at": aggregate.now_iso(),
            "sources": out,
        }
        if self.demo:
            result["demo"] = True
        if not out and fallback is not None:
            # 旧部署（还没启用分区保存）也返回一份，好让前端有东西可显示。
            totals = fallback.get("totals") or {}
            # 旧部署回退路径也要带分校区明细，否则前端在「点开源」时会
            # 因为字段缺失而退化——这条路径的数据本身就是单源全量。
            fallback_breakdown = aggregate.source_campus_breakdown(
                fallback, self.registry)
            result["sources"] = [{
                "source_id": "default",
                "name": None,
                "collector": (fallback.get("source") or {}).get("collector"),
                "updated_at": fallback.get("data_at"),
                "age_s": self._age_s(
                    aggregate.epoch_of(aggregate.parse_iso(fallback.get("data_at")))
                    if fallback.get("data_at") else None, now),
                "stations": sum(c["stations"] for c in fallback_breakdown),
                "devices": int(totals.get("total") or 0),
                "free": int(totals.get("free") or 0),
                "busy": int(totals.get("busy") or 0),
                "offline": int(totals.get("offline") or 0),
                "unknown": int(totals.get("unknown") or 0),
                "throttled": False,
                "blocked_since": None,
                "campuses": fallback_breakdown,
            }]
        return result

    @staticmethod
    def _age_s(epoch, now):
        try:
            stamp = float(epoch)
        except (TypeError, ValueError):
            return None
        if stamp <= 0:
            return None
        return max(0, int(now - stamp))

    # ---------------------------------------------------------------- ingest
    def ingest(self, payload, remote=None, source_id=None):
        """校验 + 聚合 + 落库；不合法抛 aggregate.IngestError（→ 400）。

        ``source_id`` 缺省时从报文的 ``source_id`` 字段取，再缺省为 ``default``
        （旧采集器不带这个字段时行为完全不变）。
        """
        normalized = aggregate.validate_ingest(payload)  # 可能抛 IngestError
        source_id = (source_id or normalized.get("source_id") or "default")
        source_id = str(source_id).strip() or "default"
        collected = aggregate.parse_iso(normalized["collected_at"])
        ts = aggregate.epoch_of(collected)
        received_at = int(time.time())

        with self.lock:
            result = aggregate.aggregate_ingest(
                normalized, self.registry, self.ids
            )
            snapshot = result["snapshot"]
            if self.demo:
                snapshot["demo"] = True
                source = dict(snapshot.get("source") or {})
                source["kind"] = "demo"
                snapshot["source"] = source
            points = []
            for point in result["points"]:
                item = dict(point)
                item["ts"] = ts
                points.append(item)
            # 时序点只在「这个源真的变了」时写：两个源异速刷新时，
            # 如果每次 ingest 都写一遍六校区点，历史曲线会出现台阶锯齿
            # （同一秒内先 A 后 B，桶内均值会被两条样本拉出假跳变）。
            # 用 (campus_id, totals) 与该源上一份比对，没变就不写。
            signature = self._point_signature(source_id, snapshot, result["points"])
            if signature != self._last_point_signature.get(source_id):
                self.store.add_points(points, ts=ts, demo=self.demo)
                self._last_point_signature[source_id] = signature
            self.store.save_source_state(source_id, snapshot, demo=self.demo,
                                         epoch=received_at)
            self.store.save_snapshot(snapshot, demo=self.demo)
            self.store.meta_set("id_registry", self.ids.export())
            self.store.meta_set("unassigned", result["unassigned"])
            self.store.meta_set("last_ingest_epoch", received_at)
            self.store.meta_set("last_ingest_at", aggregate.iso_from_epoch(received_at))
            self.store.meta_set("last_collect_at", snapshot.get("data_at"))
            self.store.meta_set("last_collect_epoch", ts)
            self.store.meta_set("last_ingest_collector", normalized.get("collector"))
            self.store.meta_set("consecutive_failures", 0)
            self.unassigned = result["unassigned"]
            self._last_snapshot = snapshot
            merged = self._merged_base()
            self.generation += 1

        log("ingest ok  source=%s  accepted=%d  stations=%d  collector=%s  data_at=%s  from=%s",
            source_id, result["accepted"], len(normalized["stations"]),
            normalized.get("collector") or "-", snapshot.get("data_at"), remote or "-")
        result["snapshot"] = merged
        result["source_id"] = source_id
        return result

    @staticmethod
    def _point_signature(source_id, snapshot, points):
        """该源这次聚合出来的六校区计数指纹；用来判断「值变了才写时序点」。"""
        items = []
        for point in points or []:
            items.append("%s:%s/%s/%s/%s/%s" % (
                point.get("campus_id"), point.get("free"), point.get("busy"),
                point.get("offline"), point.get("unknown"), point.get("total"),
            ))
        return "|".join(items)

    def record_failure(self, message, remote=None):
        """记录一次失败的 ingest（契约 §7：连续失败次数由 /api/health 暴露）。"""
        try:
            count = self.store.bump_counter("consecutive_failures", 1)
            self.store.meta_set("last_error", str(message)[:500])
            self.store.meta_set("last_error_at", aggregate.now_iso())
            self.store.log_ingest(False, error=str(message)[:500], remote=remote)
        except Exception:  # pragma: no cover - 记录失败本身不能影响响应
            count = 0
        log("ingest 失败 from=%s：%s（连续失败 %d 次）", remote or "-", message, count)
        return count

    # ---------------------------------------------------------------- history
    def history(self, campus, hours, bucket):
        """按校区 / 小时数 / 桶粒度取时序曲线（契约 §5）。"""
        if campus not in (None, "", "all") and campus not in self.registry.ids:
            raise HttpError(
                400, "campus 非法：%r（可选 all 或 %s）"
                     % (campus, "/".join(self.registry.ids)))
        if bucket not in aggregate.BUCKETS:
            raise HttpError(
                400, "bucket 非法：%r（可选 %s）"
                     % (bucket, "/".join(aggregate.BUCKETS.keys())))
        bucket_seconds = aggregate.BUCKETS[bucket]
        now = time.time()
        since = int(now - hours * 3600)
        campus_id = None if campus in (None, "", "all") else campus
        rows = self.store.history(
            campus_id, since, bucket_seconds, demo=self.demo,
        )
        points = []
        for row in rows:
            free_mean = float(row["free"] or 0.0)
            total_mean = float(row["total"] or 0.0)
            # 契约 §5 的 history 点只有 t/free/total/free_ratio，不暴露 unknown，
            # 所以这里按 free/total 计算（= 快照的 free/(total-unknown) 在 unknown=0 时）。
            # 用四舍五入后的整数算，保证 App 用 free/total 复算时完全一致。
            free_int = int(round(free_mean))
            total_int = int(round(total_mean))
            ratio = 0.0 if total_int <= 0 else round(free_int / total_int, 4)
            points.append({
                "t": aggregate.iso_from_epoch(row["t"]),
                "free": free_int,
                "total": total_int,
                "free_ratio": ratio,
            })
        result = {
            "schema": aggregate.HISTORY_SCHEMA,
            "campus": campus or "all",
            "hours": hours,
            "bucket_seconds": bucket_seconds,
            "points": points,
        }
        if self.demo:
            result["demo"] = True
        return result

    # ----------------------------------------------------------------- config
    def config(self):
        campuses = []
        for meta in self.registry.campus_list():
            campuses.append({
                "id": meta["id"],
                "name": meta["name"],
                "order": meta["order"],
            })
        return {
            "schema": "shzu.config.v1",
            "version": RELAY_AGENT,
            "demo": self.demo,
            "mode": "demo" if self.demo else "live",
            "poll_interval_s": self.poll_interval,
            "stale_minutes": aggregate.STALE_MINUTES,
            "statuses": list(aggregate.STATUSES),
            "buckets": list(aggregate.BUCKETS.keys()),
            "campuses": campuses,
        }

    # ----------------------------------------------------------------- health
    def health(self):
        snapshot = self.snapshot()
        campuses = snapshot.get("campuses") or []
        stations = 0
        for campus in campuses:
            stations += len(campus.get("stations") or [])
        totals = snapshot.get("totals") or {}
        last_ingest_epoch = self.store.meta_get("last_ingest_epoch")
        last_collect_epoch = self.store.meta_get("last_collect_epoch")
        failures = self.store.meta_get("consecutive_failures", 0)
        if not isinstance(failures, int):
            failures = 0
        now = time.time()
        return {
            "ok": True,
            "version": RELAY_AGENT,
            "schema": "shzu.health.v1",
            "mode": "demo" if self.demo else "live",
            "demo": self.demo,
            "now": aggregate.now_iso(),
            "started_at": self.started_iso,
            "uptime_s": int(now - self.started_at),
            "last_ingest_at": (aggregate.iso_from_epoch(last_ingest_epoch)
                               if last_ingest_epoch else None),
            "last_collect_at": self.store.meta_get("last_collect_at"),
            "last_ingest_collector": self.store.meta_get("last_ingest_collector"),
            "consecutive_failures": failures,
            "last_error": self.store.meta_get("last_error"),
            "last_error_at": self.store.meta_get("last_error_at"),
            "seconds_since_ingest": (int(now - last_ingest_epoch)
                                     if last_ingest_epoch else None),
            "data_at": snapshot.get("data_at"),
            "stale": bool(snapshot.get("stale")),
            "stations": stations,
            "devices": int(totals.get("total") or 0),
            "free": int(totals.get("free") or 0),
            "busy": int(totals.get("busy") or 0),
            "offline": int(totals.get("offline") or 0),
            "unknown": int(totals.get("unknown") or 0),
            "points": self.store.point_count(),
            "db": self.store.path,
            "retain_days": self.store.retain_days,
        }

    # ------------------------------------------------------------- unassigned
    def unassigned_payload(self):
        snapshot = self.snapshot()
        return aggregate.unassigned_payload(
            self.unassigned, data_at=snapshot.get("data_at"), demo=self.demo,
        )

    # -------------------------------------------------------------------- demo
    def start_demo(self):
        """--demo：清掉旧的 demo 数据，播 24h 历史曲线，然后周期性演进。"""
        fixture = _load_demo_fixture()
        if fixture is None:
            log("demo：demo/ingest_sample.json 不可用，改用内置最小演示数据")
            fixture = _fallback_fixture(self.registry)
        self._demo_fixture = fixture
        try:
            with self.lock:
                self.store.clear_points(demo_only=True)
                self.store.clear_snapshots(demo_only=True)
                self._last_snapshot = aggregate.empty_snapshot(self.registry, demo=True)
            _demo_seed_history(self, fixture)
        except Exception:
            log("demo 历史曲线生成失败（不影响实时演进）：\n%s", traceback.format_exc())
        self.demo_thread = threading.Thread(
            target=self._demo_loop, name="relay-demo", daemon=True,
        )
        self.demo_thread.start()

    def _demo_loop(self):
        while True:
            try:
                payload = _demo_payload(self, self._demo_tick)
                self.ingest(payload, remote="demo")
            except Exception:
                log("demo 演进失败：\n%s", traceback.format_exc())
            self._demo_tick += 1
            time.sleep(self.demo_interval)


# --------------------------------------------------------------------------- #
# demo 数据（只在 --demo 下使用；契约 §7 允许，且响应恒带 demo:true）
# --------------------------------------------------------------------------- #

_DEMO_CAMPUS_OFFSET = {
    "zhongqu": -0.04,
    "beiqu": 0.03,
    "dongqu": 0.0,
    "beiyuan": 0.05,
    "nanqu": -0.02,
    "jiangjunshan": 0.06,
}


def _demo_free_ratio(campus_id, epoch):
    """演示用的日周期曲线：早晚空、中午和夜里忙。纯展示，非真实数据。"""
    local = time.localtime(epoch)
    minutes = local.tm_hour * 60 + local.tm_min
    wave = math.sin((minutes / 1440.0) * 2.0 * math.pi - 1.2)
    base = 0.52 - 0.22 * wave
    return max(0.12, min(0.85, base + _DEMO_CAMPUS_OFFSET.get(campus_id or "", 0.0)))


def _load_demo_fixture():
    path = os.path.join(aggregate.DEMO_DIR, "ingest_sample.json")
    if not os.path.isfile(path):
        return None
    try:
        data = aggregate.load_json(path)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("stations"), list):
        return None
    return data


def _fallback_fixture(registry):
    """仓库里没有 demo fixture 时的兜底：6 区 × 2 站 × 4 桩 的最小演示报文。"""
    stations = []
    for campus_meta in registry.campus_list():
        cid = campus_meta["id"]
        for seq in range(1, 3):
            sid = "demo-%s-%02d" % (cid, seq)
            stations.append({
                "raw_id": sid,
                "raw_name": "%s%d号充电站" % (campus_meta["name"], seq),
                "raw_area": campus_meta["name"],
                "address": "演示地址 · %s" % campus_meta["name"],
                "lat": 44.30,
                "lng": 86.05,
                "devices": [
                    {
                        "raw_id": "%s-d%03d" % (sid, i + 1),
                        "code": "%03d" % (i + 1),
                        "name": "%d号桩" % (i + 1),
                        "raw_status": "0",
                        "power_w": 300,
                    }
                    for i in range(4)
                ],
            })
    return {
        "schema": aggregate.INGEST_SCHEMA,
        "collected_at": aggregate.now_iso(),
        "collector": "demo-generator@1.0.0",
        "site": "石河子大学",
        "status_map": {"free": ["0"], "busy": ["1"], "offline": ["-1", "2"]},
        "stations": stations,
    }


def _demo_payload(state, tick):
    """产出一份「当前时刻」的演示 ingest 报文（状态按日周期曲线抖动）。"""
    fixture = state._demo_fixture or _fallback_fixture(state.registry)
    rnd = random.Random(1000 + tick)
    now_epoch = time.time()
    now_iso = aggregate.now_iso()
    stations = []
    for raw_station in fixture.get("stations") or []:
        campus = state.registry.match_station(
            raw_name=raw_station.get("raw_name"),
            raw_area=raw_station.get("raw_area"),
            address=raw_station.get("address"),
        )
        ratio = _demo_free_ratio(campus, now_epoch)
        devices = []
        for raw_device in raw_station.get("devices") or []:
            roll = rnd.random()
            if roll < ratio:
                token = "0"      # free
            elif roll < ratio + 0.03:
                token = "-1"     # offline（少量）
            else:
                token = "1"      # busy
            devices.append({
                "raw_id": raw_device.get("raw_id"),
                "code": raw_device.get("code"),
                "name": raw_device.get("name"),
                "raw_status": token,
                "power_w": raw_device.get("power_w"),
            })
        stations.append({
            "raw_id": raw_station.get("raw_id"),
            "raw_name": raw_station.get("raw_name"),
            "raw_area": raw_station.get("raw_area"),
            "address": raw_station.get("address"),
            "lat": raw_station.get("lat"),
            "lng": raw_station.get("lng"),
            "devices": devices,
        })
    return {
        "schema": aggregate.INGEST_SCHEMA,
        "collected_at": now_iso,
        "collector": "demo-generator@1.0.0",
        "site": "石河子大学",
        "status_map": fixture.get("status_map") or {
            "free": ["0"], "busy": ["1"], "offline": ["-1", "2"],
        },
        "stations": stations,
    }


def _demo_seed_history(state, fixture, hours=24, step=600):
    """预置 24h 的演示历史曲线，让 App 的历史页一打开就有图。"""
    now = int(time.time())
    step = int(step)
    start = now - hours * 3600
    start = (start // step) * step

    # 每个校区的桩数（来自 fixture 的原始站列表，用同一套归区逻辑）
    device_counts = {}
    for raw_station in fixture.get("stations") or []:
        campus = state.registry.match_station(
            raw_name=raw_station.get("raw_name"),
            raw_area=raw_station.get("raw_area"),
            address=raw_station.get("address"),
        )
        if campus is None:
            continue
        device_counts[campus] = device_counts.get(campus, 0) + len(
            raw_station.get("devices") or [])

    points = []
    index = 0
    stamp = start
    while stamp <= now - step:
        bucket_index = index
        for campus_meta in state.registry.campus_list():
            cid = campus_meta["id"]
            total = int(device_counts.get(cid, 0))
            if total <= 0:
                continue
            ratio = _demo_free_ratio(cid, stamp)
            ratio += 0.03 * math.sin((bucket_index + 3 * campus_meta["order"]) / 5.0)
            ratio = max(0.08, min(0.9, ratio))
            offline = int(round(total * 0.02))
            free = max(0, min(total - offline, int(round(total * ratio))))
            busy = total - free - offline
            points.append({
                "campus_id": cid,
                "ts": stamp,
                "free": free,
                "busy": busy,
                "offline": offline,
                "unknown": 0,
                "total": total,
            })
        index += 1
        stamp += step
    if points:
        state.store.add_points(points, demo=True)
    log("demo：预置 %d 个历史点（%d 小时 / %d 秒粒度）", len(points), hours, step)


# --------------------------------------------------------------------------- #
# HTTP Handler
# --------------------------------------------------------------------------- #

class RelayHandler(BaseHTTPRequestHandler):
    """单文件路由：/api/* 走 JSON，其余走 ../app/ 静态文件。"""

    server_version = "shzu-relay/" + VERSION
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- 基础工具
    def log_message(self, fmt, *args):  # 静默：轮询会刷屏，重要事件由 log() 打
        pass

    def log_request(self, code="-", size="-"):
        try:
            if int(code) >= 400:
                log("HTTP %s %s → %s", getattr(self, "command", "?"),
                    getattr(self, "path", "?"), code)
        except Exception:
            pass

    @property
    def state(self):
        return self.server.state  # type: ignore[attr-defined]

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, X-Collector-Token, Accept")
        self.send_header("Access-Control-Max-Age", "600")
        # 浏览器跨域时只放行「简单响应头」+ 这里显式 expose 的头。App 用这两个头
        # 判断「这份数据来自 Service Worker 缓存」，没放行的话浏览器会把头屏蔽成
        # null，页面就会把离线缓存数据当成实时数据说 —— 宁可少说也不能说错。
        self.send_header("Access-Control-Expose-Headers",
                         "X-Shzu-Source, X-Shzu-Cache-Age")

    def _send_json(self, data, status=200, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors_headers()
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
                self.close_connection = True

    def _send_error_json(self, status, message):
        self._send_json({"ok": False, "error": message}, status=status)

    def _send_text(self, status, text):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
                self.close_connection = True

    def _parse_query(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        return parsed.path, {k: v[-1] for k, v in query.items()}

    def _read_body(self):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            return b""
        try:
            length = int(raw_length)
        except (TypeError, ValueError):
            raise HttpError(400, "Content-Length 不是合法整数")
        if length < 0:
            raise HttpError(400, "Content-Length 不能为负数")
        if length > MAX_BODY_BYTES:
            raise HttpError(413, "请求体过大（上限 %d 字节）" % MAX_BODY_BYTES)
        if length == 0:
            return b""
        chunks = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    # ------------------------------------------------------------- HTTP 方法
    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def do_GET(self):  # noqa: N802
        try:
            path, query = self._parse_query()
        except Exception:
            self._send_error_json(400, "请求路径非法")
            return

        try:
            if path == "/api/health":
                self._send_json(self.state.health())
            elif path == "/api/config":
                self._send_json(self.state.config())
            elif path == "/api/snapshot":
                self._send_json(self.state.snapshot())
            elif path == "/api/sources":
                self._send_json(self.state.sources())
            elif path == "/api/history":
                self._handle_history(query)
            elif path == "/api/unassigned":
                self._send_json(self.state.unassigned_payload())
            elif path == "/api/events":
                self._handle_events()
            elif path.startswith("/api/"):
                self._send_error_json(404, "未知接口：%s" % path)
            else:
                self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
            self.close_connection = True
        except Exception:
            log("GET %s 处理异常：\n%s", path, traceback.format_exc())
            try:
                self._send_error_json(500, "relay 内部错误")
            except Exception:
                pass

    def do_POST(self):  # noqa: N802
        try:
            path, _query = self._parse_query()
        except Exception:
            self._send_error_json(400, "请求路径非法")
            return
        if path != "/api/ingest":
            self._send_error_json(404, "未知接口：%s" % path)
            return
        self._handle_ingest()

    # ---------------------------------------------------------------- ingest
    def _handle_ingest(self):
        remote = self.client_address[0] if self.client_address else "-"
        token_required = self.state.token
        if token_required:
            provided = self.headers.get("X-Collector-Token") or ""
            if provided != token_required:
                self._send_error_json(401, "X-Collector-Token 不匹配")
                return

        try:
            body = self._read_body()
        except HttpError as exc:
            self.state.record_failure(exc.message, remote)
            self._send_error_json(exc.status, exc.message)
            return

        content_type = (self.headers.get("Content-Type") or "").lower()
        if content_type and "json" not in content_type:
            self.state.record_failure("Content-Type 必须是 application/json", remote)
            self._send_error_json(415, "Content-Type 必须是 application/json")
            return

        if not body:
            self.state.record_failure("请求体为空", remote)
            self._send_error_json(400, "请求体为空，应为 shzu.ingest.v1 JSON")
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except UnicodeDecodeError:
            self.state.record_failure("请求体不是 UTF-8 编码", remote)
            self._send_error_json(400, "请求体必须是 UTF-8 编码的 JSON")
            return
        except ValueError as exc:
            self.state.record_failure("请求体不是合法 JSON: %s" % exc, remote)
            self._send_error_json(400, "请求体不是合法 JSON：%s" % exc)
            return

        try:
            result = self.state.ingest(payload, remote=remote)
        except aggregate.IngestError as exc:
            self.state.record_failure(str(exc), remote)
            self._send_error_json(400, str(exc))
            return
        except Exception:
            log("ingest 处理异常：\n%s", traceback.format_exc())
            self.state.record_failure("relay 内部错误", remote)
            self._send_error_json(500, "relay 内部错误")
            return

        snapshot = result["snapshot"]
        self._send_json({
            "ok": True,
            "accepted": int(result["accepted"]),
            "source_id": result.get("source_id"),
            "snapshot_at": snapshot.get("generated_at"),
            "data_at": snapshot.get("data_at"),
        })

    # --------------------------------------------------------------- history
    def _handle_history(self, query):
        raw_campus = (query.get("campus") or "all").strip() or "all"
        if raw_campus not in ("all",) and raw_campus not in self.state.registry.ids:
            self._send_error_json(
                400, "campus 非法：%r（可选 all 或 %s）"
                     % (raw_campus, "/".join(self.state.registry.ids)))
            return

        raw_hours = query.get("hours", "24")
        try:
            hours = int(float(raw_hours))
        except (TypeError, ValueError):
            self._send_error_json(400, "hours 必须是数字（单位：小时）")
            return
        if hours < 1 or hours > 720:
            self._send_error_json(400, "hours 必须在 1~720 之间")
            return

        raw_bucket = (query.get("bucket") or "10m").strip()
        if raw_bucket not in aggregate.BUCKETS:
            self._send_error_json(
                400, "bucket 非法：%r（可选 %s）"
                     % (raw_bucket, "/".join(aggregate.BUCKETS.keys())))
            return

        self._send_json(self.state.history(raw_campus, hours, raw_bucket))

    # ------------------------------------------------------------------ SSE
    def _handle_events(self):
        """SSE：有新快照时推一条 `snapshot` 事件，App 收到即重取 /api/snapshot。"""
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self._cors_headers()
        self.end_headers()

        def write(text):
            self.wfile.write(text.encode("utf-8"))
            self.wfile.flush()

        deadline = time.time() + SSE_MAX_SECONDS
        last_generation = -1
        last_ping = time.time()
        try:
            write(": relay %s\nretry: 5000\n\n" % RELAY_AGENT)
            while time.time() < deadline:
                generation = self.state.generation
                if generation != last_generation:
                    last_generation = generation
                    snapshot = self.state.snapshot()
                    data = json.dumps({
                        "seq": generation,
                        "generated_at": snapshot.get("generated_at"),
                        "data_at": snapshot.get("data_at"),
                        "stale": snapshot.get("stale"),
                    }, ensure_ascii=False, separators=(",", ":"))
                    write("event: snapshot\ndata: %s\n\n" % data)
                    last_ping = time.time()
                if time.time() - last_ping > 15:
                    write(": ping\n\n")
                    last_ping = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # ---------------------------------------------------------------- 静态
    def _serve_static(self, path):
        app_dir = os.path.realpath(getattr(self.server, "app_dir", APP_DIR))  # type: ignore[attr-defined]
        relative = urllib.parse.unquote(path).lstrip("/")
        if relative in ("", "/"):
            relative = "index.html"
        candidate = os.path.realpath(os.path.join(app_dir, relative))
        if candidate != app_dir and not candidate.startswith(app_dir + os.sep):
            self._send_text(403, "403 Forbidden")
            return
        if os.path.isdir(candidate):
            candidate = os.path.join(candidate, "index.html")
        if not os.path.isfile(candidate):
            if relative == "index.html":
                self._send_fallback_index(app_dir)
            else:
                self._send_text(404, "404 Not Found：%s" % path)
            return
        try:
            stat = os.stat(candidate)
        except OSError:
            self._send_text(404, "404 Not Found：%s" % path)
            return

        etag = '"%x-%x"' % (int(stat.st_mtime_ns), stat.st_size)
        if (self.headers.get("If-None-Match") or "").strip() == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", _cache_control(candidate))
            self.end_headers()
            return

        try:
            with open(candidate, "rb") as handle:
                body = handle.read()
        except OSError:
            self._send_text(404, "404 Not Found：%s" % path)
            return

        ext = os.path.splitext(candidate)[1].lower()
        content_type = MIME_TYPES.get(ext, "application/octet-stream")
        encoding = None
        accept_encoding = (self.headers.get("Accept-Encoding") or "").lower()
        if len(body) >= 1024 and ext in GZIP_EXTS and "gzip" in accept_encoding:
            body = gzip.compress(body, 6)
            encoding = "gzip"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Cache-Control", _cache_control(candidate))
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
                self.close_connection = True

    def _send_fallback_index(self, app_dir):
        """app/ 还没交付时给一个能用的占位页（不能让 / 直接 500/404）。"""
        import html as html_mod

        body = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>石河子大学充电桩 · relay 已启动</title>
<style>
  body {{ margin: 0; padding: 32px 20px; background: #0d1520; color: #e7eef8;
         font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }}
  main {{ max-width: 720px; margin: 0 auto; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .muted {{ color: #8fa3bb; font-size: 13px; }}
  .box {{ margin: 18px 0; padding: 14px 16px; border-radius: 10px;
          background: #14202e; border: 1px solid #1f3046; }}
  a {{ color: #4f9cff; }}
  code {{ background: #0a1218; padding: 1px 6px; border-radius: 5px; font-size: 13px; }}
  ul {{ margin: 8px 0 0; padding-left: 20px; }}
</style>
</head>
<body>
<main>
  <h1>石河子大学充电桩 · relay 已启动</h1>
  <div class="muted">静态目录：{app_dir}</div>
  <div class="box">
    <strong>前端还没放进来。</strong>
    <p class="muted">relay 服务本身正常，API 可以直接访问：</p>
    <ul>
      <li><a href="/api/health">/api/health</a> — 存活、上次采集、连续失败次数</li>
      <li><a href="/api/config">/api/config</a> — 六校区配置</li>
      <li><a href="/api/snapshot">/api/snapshot</a> — 当前快照（shzu.snapshot.v1）</li>
      <li><a href="/api/history?hours=24">/api/history?hours=24</a> — 时序曲线</li>
    </ul>
    <p class="muted">把前端文件放进 <code>{app_dir}</code> 后刷新本页即可。</p>
  </div>
</main>
</body>
</html>
""".format(app_dir=html_mod.escape(app_dir))
        payload = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self._cors_headers()
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):  # pragma: no cover
                self.close_connection = True


def _cache_control(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    if ext in (".html", ".htm", ".webmanifest"):
        return "no-cache, must-revalidate"
    if ext in (".js", ".mjs", ".css"):
        return "no-cache, must-revalidate"
    return "public, max-age=86400"


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #

def build_parser():
    parser = argparse.ArgumentParser(
        description="石河子大学充电桩 · relay 中继服务（纯标准库，Termux 可直接跑）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python server.py --port 8080\n"
               "  python server.py --demo --port 8080\n"
               "  python server.py --port 8080 --data-dir ./data\n",
    )
    parser.add_argument("--host", default=DEFAULT_HOST,
                        help="监听地址，默认 %s（局域网可访问；仅本机用 127.0.0.1）" % DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="监听端口，默认 %d" % DEFAULT_PORT)
    parser.add_argument("--data-dir", default=DEFAULT_DATA_DIR,
                        help="SQLite 存放目录，默认 %s" % DEFAULT_DATA_DIR)
    parser.add_argument("--db-name", default="charging.db",
                        help="数据库文件名，默认 charging.db（测试可换成独立文件）")
    parser.add_argument("--demo", action="store_true",
                        help="演示模式：从 demo/ingest_sample.json 造演进数据，响应带 demo:true")
    parser.add_argument("--demo-interval", type=float, default=DEFAULT_DEMO_INTERVAL,
                        help="演示数据演进间隔秒数，默认 %d" % DEFAULT_DEMO_INTERVAL)
    parser.add_argument("--retain-days", type=int, default=DEFAULT_RETAIN_DAYS,
                        help="时序保留天数，默认 %d" % DEFAULT_RETAIN_DAYS)
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL,
                        help="采集器预期轮询间隔秒数（仅用于 /api/health 提示），默认 %d"
                             % DEFAULT_POLL_INTERVAL)
    parser.add_argument("--token", default=os.environ.get("RELAY_TOKEN") or None,
                        help="可选：设置后 ingest 必须带 X-Collector-Token 头（默认不校验）")
    parser.add_argument("--version", action="version", version=RELAY_AGENT)
    return parser


def main(argv=None):
    _setup_console()
    args = build_parser().parse_args(argv)

    try:
        state = RelayState(
            data_dir=args.data_dir,
            demo=args.demo,
            demo_interval=args.demo_interval,
            retain_days=args.retain_days,
            token=args.token,
            poll_interval=args.poll_interval,
            db_name=args.db_name,
        )
    except Exception:
        log("初始化失败（数据库/校区配置读不出来）：\n%s", traceback.format_exc())
        return 1

    app_dir = os.path.realpath(APP_DIR)
    app_ready = os.path.isfile(os.path.join(app_dir, "index.html"))

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), RelayHandler)
    except OSError as exc:
        log("端口 %d 绑定失败：%s（换一个 --port 试试）", args.port, exc)
        state.close()
        return 1
    httpd.daemon_threads = True
    httpd.state = state          # type: ignore[attr-defined]
    httpd.app_dir = app_dir      # type: ignore[attr-defined]

    shown_host = args.host if args.host not in ("0.0.0.0", "") else "127.0.0.1"
    log("石河子大学充电桩 · relay %s", VERSION)
    log("  监听      http://%s:%d/", shown_host, args.port)
    if args.host in ("0.0.0.0", ""):
        log("  局域网    手机用 http://<平板IP>:%d/ 访问（同一 WiFi）", args.port)
    log("  静态目录  %s（%s）", app_dir, "已就绪" if app_ready else "尚未交付，/ 返回占位页")
    log("  数据库    %s", state.store.path)
    log("  模式      %s%s", "demo（演示数据）" if args.demo else "live（真实采集）",
        "" if not args.demo else "，每 %.0fs 演进一次" % state.demo_interval)
    log("  校区      %d 个：%s", len(state.registry.ids), " / ".join(state.registry.ids))
    log("按 Ctrl-C 停止。")

    if args.demo:
        state.start_demo()

    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        log("收到 Ctrl-C，正在退出 …")
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        try:
            httpd.server_close()
        except Exception:
            pass
        state.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
