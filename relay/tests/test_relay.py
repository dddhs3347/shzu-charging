#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""relay/tests/test_relay.py — relay 的单元 + 集成测试（纯标准库 unittest）。

跑法（在 relay/ 目录下）::

    python -m unittest discover -s tests -v
    python -m unittest discover -s tests      # 静默模式

覆盖：
  * 六校区恒 6 项、顺序 / order 固定（契约 §2 硬性规则 1）
  * totals 链：total=四态和、free_ratio 规则、全局=六校区、校区=站点、站点=桩数
  * 状态映射：campus.json 兜底、ingest status_map 覆盖、未知值 → unknown（不猜）
  * alias 归区：最长 alias 优先、无匹配 → _unassigned 且不进六校区
  * 稳定 id：格式、重启后不重排、跨 ingest 保持
  * stale：>15 分钟判定、data_at=null
  * history：桶内均值（不是末值）、校区分组、时间升序、非法参数
  * ingest 校验：非法请求必须 4xx 不是 5xx
  * HTTP 全链路：真实起服务，ingest → snapshot → history → static
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

RELAY_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT_ROOT = os.path.dirname(RELAY_DIR)
if RELAY_DIR not in sys.path:
    sys.path.insert(0, RELAY_DIR)

import aggregate  # noqa: E402
import server as relay_server  # noqa: E402
import store as store_mod  # noqa: E402

# 测试里不需要 server 的启动/请求日志，静音后 -v 输出才看得清
relay_server.log = lambda message, *args: None

DEMO_DIR = os.path.join(PROJECT_ROOT, "demo")
CAMPUS_ORDER = ["zhongqu", "beiqu", "dongqu", "beiyuan", "nanqu", "jiangjunshan"]


# --------------------------------------------------------------------------- #
# 测试夹具
# --------------------------------------------------------------------------- #

def load_demo_ingest():
    path = os.path.join(DEMO_DIR, "ingest_sample.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data


def make_ingest(stations, collected_at=None, status_map=None, collector="test@1.0.0"):
    payload = {
        "schema": aggregate.INGEST_SCHEMA,
        "collected_at": collected_at or aggregate.now_iso(),
        "collector": collector,
        "site": "石河子大学",
        "stations": stations,
    }
    if status_map is not None:
        payload["status_map"] = status_map
    return payload


def make_station(raw_id, name, area, devices):
    return {
        "raw_id": raw_id,
        "raw_name": name,
        "raw_area": area,
        "address": None,
        "lat": None,
        "lng": None,
        "devices": devices,
    }


def make_device(raw_id, status, code=None, power_w=300, name=None):
    return {
        "raw_id": raw_id,
        "code": code,
        "name": name,
        "raw_status": status,
        "power_w": power_w,
    }


class TempDataDirMixin:
    """每个用例一个独立的数据目录，避免互相污染。"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="relay_test_")
        self.addCleanup(shutil.rmtree, self.tmpdir, True)

    def make_store(self, **kwargs):
        return store_mod.Store(self.tmpdir, **kwargs)


# --------------------------------------------------------------------------- #
# 1. 纯逻辑：校区与状态翻译
# --------------------------------------------------------------------------- #

class CampusRegistryTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.registry = aggregate.CampusRegistry()

    def test_six_campuses_in_order(self):
        self.assertEqual(self.registry.ids, CAMPUS_ORDER)
        self.assertEqual([c["order"] for c in self.registry.campus_list()], [1, 2, 3, 4, 5, 6])

    def test_names_match_campus_json(self):
        names = [c["name"] for c in self.registry.campus_list()]
        self.assertEqual(names, ["中区", "北区", "东区", "北苑新区", "南区", "将军山校区"])

    def test_alias_match_basic(self):
        self.assertEqual(self.registry.match("中区1号充电站"), "zhongqu")
        self.assertEqual(self.registry.match("", "北区", ""), "beiqu")
        self.assertEqual(self.registry.match(None, None, "石河子市北四路 东区宿舍"), "dongqu")

    def test_alias_ignores_space_case_parens(self):
        self.assertEqual(self.registry.match("中 区（1号宿舍楼旁）"), "zhongqu")
        self.assertEqual(self.registry.match("ZHONGQU"), "zhongqu")
        self.assertEqual(self.registry.match("北苑（新）新区"), "beiyuan")

    def test_longest_alias_wins(self):
        # 「北苑新区」比「北区」更具体 → 应归北苑新区，不是北区
        self.assertEqual(self.registry.match("北苑新区3号站"), "beiyuan")
        self.assertEqual(self.registry.match("北区1号站"), "beiqu")
        # 「将军山校区」比「南区」无冲突，但「将军山」必须命中 jiangjunshan
        self.assertEqual(self.registry.match("将军山校区充电站"), "jiangjunshan")

    def test_no_match_returns_none(self):
        self.assertIsNone(self.registry.match("某某大学城充电站"))
        self.assertIsNone(self.registry.match(""))
        self.assertIsNone(self.registry.match(None, None))

    def test_status_fallback_map(self):
        translate = self.registry.translate
        for token in ("0", "空闲", "free", "idle", "可用"):
            self.assertEqual(translate(token), "free", token)
        # 注意 campus.json 的兜底 busy 列表里是 "2" 而不是 "1"
        # （厂商数字码不稳定，真实映射由 ingest 的 status_map 覆盖）
        for token in ("2", "使用中", "busy", "charging", "占用"):
            self.assertEqual(translate(token), "busy", token)
        for token in ("-1", "离线", "offline", "故障", "维护"):
            self.assertEqual(translate(token), "offline", token)
        for token in ("99", "随便什么", "", None):
            self.assertEqual(translate(token), "unknown", token)

    def test_unmapped_numeric_status_is_unknown(self):
        """campus.json 兜底里没有 "1"：靠兜底时必须落到 unknown，不能猜。"""
        self.assertEqual(self.registry.translate("1"), "unknown")
        # 但 ingest 带 status_map 时优先，可以把它映射成 busy
        override = aggregate.normalize_status_map({"busy": ["1"]})
        self.assertEqual(self.registry.translate("1", override), "busy")

    def test_status_override_wins(self):
        override = aggregate.normalize_status_map({"free": ["1"], "busy": ["0"]})
        self.assertEqual(self.registry.translate("1", override), "free")
        self.assertEqual(self.registry.translate("0", override), "busy")
        # 覆盖表里没有的仍走兜底
        self.assertEqual(self.registry.translate("-1", override), "offline")

    def test_status_does_not_guess(self):
        """契约 §7：字段解析失败 → unknown，绝不猜测成 free/busy。"""
        self.assertEqual(self.registry.translate("FREE?"), "unknown")
        self.assertEqual(self.registry.translate({"a": 1}), "unknown")
        self.assertEqual(self.registry.translate(True), "unknown")


# --------------------------------------------------------------------------- #
# 2. totals / free_ratio / 时间
# --------------------------------------------------------------------------- #

class TotalsTest(unittest.TestCase):

    def test_totals_from_counts(self):
        totals = aggregate.totals_from_counts(free=3, busy=2, offline=1, unknown=4)
        self.assertEqual(totals["total"], 10)
        self.assertEqual(totals["free"], 3)
        self.assertEqual(totals["busy"], 2)
        self.assertEqual(totals["offline"], 1)
        self.assertEqual(totals["unknown"], 4)
        # free_ratio = free / (total - unknown) = 3 / 6
        self.assertAlmostEqual(totals["free_ratio"], 0.5, places=6)

    def test_free_ratio_four_decimals(self):
        totals = aggregate.totals_from_counts(free=41, busy=74, offline=5, unknown=0)
        self.assertEqual(totals["free_ratio"], 0.3417)

    def test_free_ratio_zero_denominator(self):
        self.assertEqual(aggregate.totals_from_counts(0, 0, 0, 0)["free_ratio"], 0.0)
        # 全是 unknown → 分母 0 → 0.0（不是除零异常）
        self.assertEqual(aggregate.totals_from_counts(0, 0, 0, 5)["free_ratio"], 0.0)

    def test_free_ratio_ignores_unknown_in_denominator(self):
        totals = aggregate.totals_from_counts(free=1, busy=1, offline=0, unknown=8)
        self.assertEqual(totals["total"], 10)
        self.assertEqual(totals["free_ratio"], 0.5)

    def test_sum_totals(self):
        merged = aggregate.sum_totals([
            aggregate.totals_from_counts(1, 2, 3, 4),
            aggregate.totals_from_counts(10, 20, 30, 40),
        ])
        self.assertEqual(merged["total"], 110)
        self.assertEqual(merged["free"], 11)
        self.assertEqual(merged["unknown"], 44)

    def test_iso_has_timezone(self):
        text = aggregate.now_iso()
        self.assertRegex(text, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$")
        self.assertFalse(text.endswith("Z"))

    def test_parse_iso_variants(self):
        self.assertIsNotNone(aggregate.parse_iso("2026-10-20T00:30:00+08:00"))
        self.assertIsNotNone(aggregate.parse_iso("2026-10-20T00:30:00Z"))
        self.assertIsNotNone(aggregate.parse_iso("2026-10-20T00:30:00"))  # 无时区按 +08
        self.assertIsNotNone(aggregate.parse_iso("2026-10-20 00:30:00"))
        self.assertIsNone(aggregate.parse_iso("昨天"))
        self.assertIsNone(aggregate.parse_iso(""))
        self.assertIsNone(aggregate.parse_iso(None))

    def test_is_stale_threshold(self):
        now = time.time()
        fresh = aggregate.iso_from_epoch(now - 60)
        old = aggregate.iso_from_epoch(now - 16 * 60)
        edge = aggregate.iso_from_epoch(now - 15 * 60 + 30)
        self.assertFalse(aggregate.is_stale(fresh, now))
        self.assertTrue(aggregate.is_stale(old, now))
        self.assertFalse(aggregate.is_stale(edge, now))
        self.assertTrue(aggregate.is_stale(None, now), "data_at 缺失必须视为 stale")


# --------------------------------------------------------------------------- #
# 3. 聚合：六校区、归区、稳定 id
# --------------------------------------------------------------------------- #

class AggregateTest(TempDataDirMixin, unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.registry = aggregate.CampusRegistry()

    def _payload(self):
        return make_ingest([
            make_station("raw-a", "中区1号充电站", "中区", [
                make_device("raw-a-1", "0", "001"),
                make_device("raw-a-2", "1", "002"),
                make_device("raw-a-3", "-1", "003"),
                make_device("raw-a-4", "???", "004"),
            ]),
            make_station("raw-b", "北苑新区2号站", "北苑新区", [
                make_device("raw-b-1", "0", "001"),
                make_device("raw-b-2", "0", "002"),
            ]),
            make_station("raw-c", "神秘停车场", "不知道哪", [
                make_device("raw-c-1", "1", "001"),
            ]),
        ])

    def test_campuses_always_six(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        snapshot = result["snapshot"]
        self.assertEqual(len(snapshot["campuses"]), 6)
        self.assertEqual([c["id"] for c in snapshot["campuses"]], CAMPUS_ORDER)
        self.assertEqual([c["order"] for c in snapshot["campuses"]], [1, 2, 3, 4, 5, 6])

    def test_missing_campus_is_zero_not_absent(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        by_id = {c["id"]: c for c in result["snapshot"]["campuses"]}
        for cid in ("dongqu", "nanqu", "jiangjunshan"):
            self.assertIn(cid, by_id, "缺数据的校区也必须存在")
            self.assertEqual(by_id[cid]["totals"]["total"], 0)
            self.assertEqual(by_id[cid]["stations"], [])
            self.assertEqual(by_id[cid]["totals"]["free_ratio"], 0.0)

    def test_totals_chain_consistent(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        snapshot = result["snapshot"]
        grand = snapshot["totals"]
        keys = ("total", "free", "busy", "offline", "unknown")
        self.assertEqual(grand["total"], sum(grand[k] for k in keys[1:]))
        for key in keys:
            self.assertEqual(grand[key], sum(c["totals"][key] for c in snapshot["campuses"]))
        for campus in snapshot["campuses"]:
            for key in keys:
                self.assertEqual(
                    campus["totals"][key],
                    sum(st["totals"][key] for st in campus["stations"]),
                )
            for station in campus["stations"]:
                self.assertEqual(station["totals"]["total"], len(station["devices"]))
                self.assertEqual(station["campus_id"], campus["id"])
                counts = {}
                for device in station["devices"]:
                    counts[device["status"]] = counts.get(device["status"], 0) + 1
                for status in aggregate.STATUSES:
                    self.assertEqual(station["totals"][status], counts.get(status, 0))

    def test_free_ratio_roundtrip(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        totals = result["snapshot"]["totals"]
        denom = totals["total"] - totals["unknown"]
        want = 0.0 if denom <= 0 else round(totals["free"] / denom, 4)
        self.assertAlmostEqual(totals["free_ratio"], want, places=9)

    def test_alias_routing(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        by_id = {c["id"]: c for c in result["snapshot"]["campuses"]}
        self.assertEqual(len(by_id["zhongqu"]["stations"]), 1)
        self.assertEqual(len(by_id["beiyuan"]["stations"]), 1)
        self.assertEqual(by_id["zhongqu"]["stations"][0]["id"], "zhongqu-01")
        self.assertEqual(by_id["beiyuan"]["stations"][0]["id"], "beiyuan-01")

    def test_unassigned_excluded_from_six(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        self.assertEqual(len(result["unassigned"]), 1)
        self.assertEqual(result["unassigned"][0]["campus_id"], "_unassigned")
        for campus in result["snapshot"]["campuses"]:
            for station in campus["stations"]:
                self.assertNotEqual(station["campus_id"], "_unassigned")
        # 快照只统计六校区内 4+2=6 根桩，未归类的 1 根不进快照
        self.assertEqual(result["snapshot"]["totals"]["total"], 6)
        self.assertEqual(result["accepted"], 7, "accepted 统计的是收到的全部桩")

    def test_accepted_counts_devices(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        self.assertEqual(result["accepted"], 7)

    def test_stable_ids_format(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        pattern_station = __import__("re").compile(r"^(%s)-\d{2}$" % "|".join(CAMPUS_ORDER))
        pattern_device = __import__("re").compile(r"^.+-\d{2}-\d{3}$")
        for campus in result["snapshot"]["campuses"]:
            for station in campus["stations"]:
                self.assertRegex(station["id"], pattern_station)
                for device in station["devices"]:
                    self.assertRegex(device["id"], pattern_device)
                    self.assertTrue(device["id"].startswith(station["id"] + "-"))

    def test_stable_ids_survive_new_ingest(self):
        ids = aggregate.IdRegistry()
        first = aggregate.aggregate_ingest(self._payload(), self.registry, ids)
        order_first = {
            st["id"]: [d["id"] for d in st["devices"]]
            for c in first["snapshot"]["campuses"] for st in c["stations"]
        }
        ids2 = aggregate.IdRegistry.from_state(json.loads(json.dumps(ids.export())))
        second = aggregate.aggregate_ingest(self._payload(), self.registry, ids2)
        order_second = {
            st["id"]: [d["id"] for d in st["devices"]]
            for c in second["snapshot"]["campuses"] for st in c["stations"]
        }
        self.assertEqual(order_first, order_second)

    def test_stable_ids_deterministic_order(self):
        ids = aggregate.IdRegistry()
        result = aggregate.aggregate_ingest(self._payload(), self.registry, ids)
        by_id = {c["id"]: c for c in result["snapshot"]["campuses"]}
        station = by_id["zhongqu"]["stations"][0]
        self.assertEqual(station["id"], "zhongqu-01")
        self.assertEqual(
            [d["id"] for d in station["devices"]],
            ["zhongqu-01-001", "zhongqu-01-002", "zhongqu-01-003", "zhongqu-01-004"],
        )

    def test_data_at_from_collected_at(self):
        collected = "2026-10-20T00:29:41+08:00"
        payload = self._payload()
        payload["collected_at"] = collected
        result = aggregate.aggregate_ingest(payload, self.registry)
        self.assertEqual(result["snapshot"]["data_at"], collected)
        for campus in result["snapshot"]["campuses"]:
            for station in campus["stations"]:
                self.assertEqual(station["updated_at"], collected)

    def test_points_cover_six_campuses(self):
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        self.assertEqual(len(result["points"]), 6)
        self.assertEqual([p["campus_id"] for p in result["points"]], CAMPUS_ORDER)

    def test_ingest_status_map_override(self):
        """ingest 自带的 status_map 必须优先于 campus.json 兜底。"""
        payload = make_ingest(
            [make_station("raw-x", "中区X站", "中区", [
                make_device("raw-x-1", "7"),
                make_device("raw-x-2", "8"),
            ])],
            status_map={"free": ["7"], "busy": ["8"], "offline": []},
        )
        result = aggregate.aggregate_ingest(payload, self.registry)
        station = result["snapshot"]["campuses"][0]["stations"][0]
        self.assertEqual(station["totals"]["free"], 1)
        self.assertEqual(station["totals"]["busy"], 1)
        self.assertEqual(station["totals"]["unknown"], 0)

    def test_empty_snapshot_is_legal(self):
        snapshot = aggregate.empty_snapshot(self.registry)
        self.assertEqual(snapshot["schema"], "shzu.snapshot.v1")
        self.assertIsNone(snapshot["data_at"])
        self.assertTrue(snapshot["stale"])
        self.assertEqual(len(snapshot["campuses"]), 6)
        self.assertEqual(snapshot["totals"]["total"], 0)
        self.assertEqual(snapshot["totals"]["free_ratio"], 0.0)
        # 还没采集过，不能凭空编一个采集器名字
        self.assertEqual(snapshot["source"]["collector"], "unknown")
        self.assertEqual(snapshot["source"]["confidence"], 0.0)

    def test_source_block_matches_contract_example(self):
        """契约 §2 的 source 块：kind=poll / applet / collector / confidence。"""
        result = aggregate.aggregate_ingest(self._payload(), self.registry)
        source = result["snapshot"]["source"]
        self.assertEqual(source["kind"], "poll")
        self.assertEqual(source["applet"], "石河子大学充电桩")
        self.assertEqual(source["collector"], "test@1.0.0")
        self.assertGreaterEqual(source["confidence"], 0.0)
        self.assertLessEqual(source["confidence"], 1.0)

    def test_source_confidence_reflects_unknown_ratio(self):
        """confidence = (total - unknown)/total，unknown 越多越不可信（不是随机数）。"""
        payload = make_ingest([
            make_station("raw-1", "中区1号充电站", "中区", [
                make_device("raw-1-1", "0"),
                make_device("raw-1-2", "0"),
                make_device("raw-1-3", "看不懂的状态"),  # → unknown
                make_device("raw-1-4", "看不懂的状态"),  # → unknown
            ]),
        ])
        result = aggregate.aggregate_ingest(payload, self.registry)
        totals = result["snapshot"]["totals"]
        self.assertEqual(totals["total"], 4)
        self.assertEqual(totals["unknown"], 2)
        self.assertEqual(result["snapshot"]["source"]["confidence"], 0.5)

    def test_refresh_snapshot_repairs_totals(self):
        """库里存了脏数据也要在出口处修成契约合法形态。"""
        broken = {
            "schema": "shzu.snapshot.v1",
            "generated_at": "2026-01-01T00:00:00+08:00",
            "data_at": None,
            "stale": False,
            "totals": {"total": 999, "free": 1, "busy": 0, "offline": 0,
                       "unknown": 0, "free_ratio": 0.9},
            "campuses": [{"id": "zhongqu", "name": "中区", "order": 9,
                          "totals": {"total": 5, "free": 5, "busy": 0, "offline": 0,
                                     "unknown": 0, "free_ratio": 1.0},
                          "stations": []}],
        }
        fixed = aggregate.refresh_snapshot(broken, self.registry)
        self.assertEqual(len(fixed["campuses"]), 6)
        self.assertEqual([c["order"] for c in fixed["campuses"]], [1, 2, 3, 4, 5, 6])
        self.assertEqual(fixed["totals"]["total"], 0)
        self.assertTrue(fixed["stale"])


# --------------------------------------------------------------------------- #
# 4. ingest 校验：非法一律 IngestError（→ 400）
# --------------------------------------------------------------------------- #

class ValidateIngestTest(unittest.TestCase):

    def test_ok(self):
        payload = make_ingest([make_station("r1", "中区1号", "中区",
                                            [make_device("d1", "0")])])
        normalized = aggregate.validate_ingest(payload)
        self.assertEqual(normalized["schema"], "shzu.ingest.v1")
        self.assertEqual(len(normalized["stations"]), 1)

    def test_rejects_non_object(self):
        for payload in ([], "x", 3, None, True):
            with self.assertRaises(aggregate.IngestError):
                aggregate.validate_ingest(payload)

    def test_rejects_missing_schema(self):
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest({"collected_at": aggregate.now_iso(), "stations": []})

    def test_rejects_wrong_schema(self):
        payload = make_ingest([])
        payload["schema"] = "shzu.snapshot.v1"
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_bad_collected_at(self):
        payload = make_ingest([])
        payload["collected_at"] = "不是时间"
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_missing_collected_at(self):
        payload = make_ingest([])
        del payload["collected_at"]
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_stations_not_list(self):
        payload = make_ingest([])
        payload["stations"] = "oops"
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_station_without_raw_id(self):
        payload = make_ingest([{"devices": []}])
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_station_devices_not_list(self):
        payload = make_ingest([{"raw_id": "x", "devices": "nope"}])
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_device_without_status(self):
        payload = make_ingest([make_station("x", "n", "中区", [{"raw_id": "d"}])])
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_rejects_project_status_map(self):
        payload = make_ingest([])
        payload["status_map"] = ["free"]
        with self.assertRaises(aggregate.IngestError):
            aggregate.validate_ingest(payload)

    def test_accepts_numeric_raw_status(self):
        payload = make_ingest([make_station("x", "n", "中区",
                                            [{"raw_id": "d", "raw_status": 0}])])
        normalized = aggregate.validate_ingest(payload)
        self.assertEqual(normalized["stations"][0]["devices"][0]["raw_status"], "0")

    def test_empty_stations_is_valid(self):
        normalized = aggregate.validate_ingest(make_ingest([]))
        self.assertEqual(normalized["stations"], [])


# --------------------------------------------------------------------------- #
# 5. store：时序、桶均值、清理
# --------------------------------------------------------------------------- #

class StoreTest(TempDataDirMixin, unittest.TestCase):

    def _points(self, ts, free, total, campus="zhongqu", busy=None, offline=0, unknown=0):
        return {
            "campus_id": campus, "ts": ts, "free": free,
            "busy": total - free - offline - unknown if busy is None else busy,
            "offline": offline, "unknown": unknown, "total": total,
        }

    def test_add_and_read_points(self):
        store = self.make_store()
        self.addCleanup(store.close)
        self.assertEqual(store.point_count(), 0)
        store.add_points([self._points(1000, 5, 10)], ts=1000)
        self.assertEqual(store.point_count(), 1)

    def test_history_bucket_average_not_last(self):
        """契约 §5：桶内取均值，不是末值。"""
        store = self.make_store()
        self.addCleanup(store.close)
        bucket = 600
        base = 1_700_000_000 // bucket * bucket
        store.add_points([
            self._points(base + 10, 2, 10),
            self._points(base + 200, 4, 10),
            self._points(base + 590, 6, 10),
        ])
        rows = store.history("zhongqu", base - 1, bucket)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["free"], 4.0, places=6)   # (2+4+6)/3
        self.assertAlmostEqual(rows[0]["total"], 10.0, places=6)
        self.assertEqual(rows[0]["samples"], 3)

    def test_history_ascending_and_grouped(self):
        store = self.make_store()
        self.addCleanup(store.close)
        bucket = 600
        base = 1_700_000_000 // bucket * bucket
        store.add_points([
            self._points(base, 1, 10),
            self._points(base + bucket, 2, 10),
            self._points(base + 2 * bucket, 3, 10),
        ])
        rows = store.history("zhongqu", base - 1, bucket)
        self.assertEqual([r["t"] for r in rows], [base, base + bucket, base + 2 * bucket])
        self.assertEqual([r["free"] for r in rows], [1.0, 2.0, 3.0])

    def test_history_all_campuses_sums_means(self):
        store = self.make_store()
        self.addCleanup(store.close)
        base = 1_700_000_000
        store.add_points([
            self._points(base, 3, 10, campus="zhongqu"),
            self._points(base, 5, 20, campus="beiqu"),
        ], ts=base)
        rows = store.history(None, base - 1, 600)
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(rows[0]["free"], 8.0)
        self.assertAlmostEqual(rows[0]["total"], 30.0)

    def test_history_campus_filter(self):
        store = self.make_store()
        self.addCleanup(store.close)
        base = 1_700_000_000
        store.add_points([
            self._points(base, 3, 10, campus="zhongqu"),
            self._points(base, 5, 20, campus="beiqu"),
        ], ts=base)
        self.assertEqual(len(store.history("zhongqu", base - 1, 600)), 1)
        self.assertEqual(len(store.history("nanqu", base - 1, 600)), 0)

    def test_history_since_filter(self):
        store = self.make_store()
        self.addCleanup(store.close)
        base = 1_700_000_000
        store.add_points([
            self._points(base, 1, 10),
            self._points(base + 7200, 5, 10),
        ])
        rows = store.history("zhongqu", base + 3600, 600)
        self.assertEqual(len(rows), 1)

    def test_history_demo_filter(self):
        store = self.make_store()
        self.addCleanup(store.close)
        base = 1_700_000_000
        store.add_points([self._points(base, 1, 10)], demo=True)
        store.add_points([self._points(base, 9, 10)], demo=False)
        self.assertEqual(len(store.history("zhongqu", base - 1, 600, demo=True)), 1)
        self.assertEqual(store.history("zhongqu", base - 1, 600, demo=True)[0]["free"], 1.0)
        self.assertEqual(store.history("zhongqu", base - 1, 600, demo=False)[0]["free"], 9.0)

    def test_snapshot_save_and_load(self):
        store = self.make_store()
        self.addCleanup(store.close)
        self.assertIsNone(store.latest_snapshot())
        store.save_snapshot({"schema": "shzu.snapshot.v1", "data_at": "x"}, demo=False)
        loaded = store.latest_snapshot()
        self.assertEqual(loaded["schema"], "shzu.snapshot.v1")
        self.assertIsNone(store.latest_snapshot(demo=True))

    def test_snapshot_keep_limit(self):
        store = self.make_store(keep_snapshots=3)
        self.addCleanup(store.close)
        for index in range(8):
            store.save_snapshot({"schema": "shzu.snapshot.v1", "n": index})
        self.assertEqual(store.snapshot_count(), 3)
        self.assertEqual(store.latest_snapshot()["n"], 7)

    def test_meta_roundtrip(self):
        store = self.make_store()
        self.addCleanup(store.close)
        self.assertIsNone(store.meta_get("missing"))
        self.assertEqual(store.meta_get("missing", 5), 5)
        store.meta_set("obj", {"a": [1, 2, 3], "中": "文"})
        self.assertEqual(store.meta_get("obj"), {"a": [1, 2, 3], "中": "文"})

    def test_bump_counter(self):
        store = self.make_store()
        self.addCleanup(store.close)
        self.assertEqual(store.bump_counter("fails", 1), 1)
        self.assertEqual(store.bump_counter("fails", 1), 2)
        self.assertEqual(store.bump_counter("fails", -2), 0)

    def test_prune_removes_old_points(self):
        store = self.make_store(retain_days=30)
        self.addCleanup(store.close)
        now = int(time.time())
        old = now - 31 * 86400
        store.add_points([self._points(old, 1, 10), self._points(now, 2, 10)])
        self.assertEqual(store.point_count(), 2)
        removed = store.prune(now)
        self.assertEqual(removed, 1)
        self.assertEqual(store.point_count(), 1)

    def test_ingest_log(self):
        store = self.make_store()
        self.addCleanup(store.close)
        store.log_ingest(True, collector="c1", accepted=12)
        store.log_ingest(False, error="bad")
        logs = store.recent_ingests()
        self.assertEqual(len(logs), 2)
        self.assertTrue(logs[0]["ok"] is False)
        self.assertEqual(logs[1]["accepted"], 12)


# --------------------------------------------------------------------------- #
# 6. RelayState：ingest → snapshot → history 业务链路
# --------------------------------------------------------------------------- #

class RelayStateTest(TempDataDirMixin, unittest.TestCase):

    def make_state(self, **kwargs):
        state = relay_server.RelayState(data_dir=self.tmpdir, db_name="state.db", **kwargs)
        self.addCleanup(state.close)
        return state

    def _payload(self, statuses=("0", "0", "1", "-1")):
        return make_ingest([
            make_station("raw-1", "中区1号充电站", "中区", [
                make_device("raw-1-%d" % (i + 1), status, code="%03d" % (i + 1))
                for i, status in enumerate(statuses)
            ]),
        ], status_map={"free": ["0"], "busy": ["1"], "offline": ["-1"]})

    def test_initial_snapshot_is_empty_but_legal(self):
        state = self.make_state()
        snapshot = state.snapshot()
        self.assertEqual(len(snapshot["campuses"]), 6)
        self.assertIsNone(snapshot["data_at"])
        self.assertTrue(snapshot["stale"])
        self.assertNotIn("demo", snapshot)

    def test_ingest_updates_snapshot(self):
        state = self.make_state()
        state.ingest(self._payload())
        snapshot = state.snapshot()
        self.assertFalse(snapshot["stale"])
        self.assertEqual(snapshot["totals"]["total"], 4)
        self.assertEqual(snapshot["totals"]["free"], 2)
        self.assertEqual(snapshot["totals"]["busy"], 1)
        self.assertEqual(snapshot["totals"]["offline"], 1)
        self.assertEqual(snapshot["campuses"][0]["stations"][0]["id"], "zhongqu-01")

    def test_ingest_writes_points(self):
        state = self.make_state()
        state.ingest(self._payload())
        self.assertEqual(state.store.point_count(), 6)
        history = state.history("all", 24, "10m")
        self.assertEqual(history["schema"], "shzu.history.v1")
        self.assertEqual(history["bucket_seconds"], 600)
        self.assertEqual(len(history["points"]), 1)
        point = history["points"][0]
        self.assertEqual(point["total"], 4)
        self.assertEqual(point["free"], 2)
        # history 点只有 t/free/total/free_ratio，ratio 按 free/total 算
        self.assertEqual(point["free_ratio"], 0.5)
        self.assertRegex(point["t"], r"Z$|[+-]\d{2}:\d{2}$")

    def test_history_unknown_campus_raises_http_error(self):
        state = self.make_state()
        with self.assertRaises(relay_server.HttpError):
            state.history("nope", 24, "10m")

    def test_health_after_ingest(self):
        state = self.make_state()
        state.ingest(self._payload())
        health = state.health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["devices"], 4)
        self.assertEqual(health["consecutive_failures"], 0)
        self.assertIsNotNone(health["last_ingest_at"])
        self.assertEqual(health["mode"], "live")
        self.assertFalse(health["demo"])

    def test_consecutive_failures_counter(self):
        state = self.make_state()
        self.assertEqual(state.record_failure("bad 1"), 1)
        self.assertEqual(state.record_failure("bad 2"), 2)
        self.assertEqual(state.health()["consecutive_failures"], 2)
        state.ingest(self._payload())
        self.assertEqual(state.health()["consecutive_failures"], 0)

    def test_stable_ids_survive_restart(self):
        state = self.make_state()
        state.ingest(self._payload())
        first = state.snapshot()

        state2 = relay_server.RelayState(data_dir=self.tmpdir, db_name="state.db")
        self.addCleanup(state2.close)
        # 重启后即便 ingest 顺序变了，id 也不能重排
        reordered = make_ingest([
            make_station("raw-1", "中区1号充电站", "中区", [
                make_device("raw-1-4", "-1", code="004"),
                make_device("raw-1-1", "0", code="001"),
                make_device("raw-1-2", "0", code="002"),
                make_device("raw-1-3", "1", code="003"),
            ]),
        ])
        state2.ingest(reordered)
        second = state2.snapshot()
        self.assertEqual(
            [(st["id"], [d["id"] for d in st["devices"]])
             for c in first["campuses"] for st in c["stations"]],
            [(st["id"], [d["id"] for d in st["devices"]])
             for c in second["campuses"] for st in c["stations"]],
        )

    def test_restart_restores_snapshot(self):
        state = self.make_state()
        state.ingest(self._payload())
        state.close()
        state2 = relay_server.RelayState(data_dir=self.tmpdir, db_name="state.db")
        self.addCleanup(state2.close)
        snapshot = state2.snapshot()
        self.assertEqual(snapshot["totals"]["total"], 4)
        self.assertFalse(snapshot["stale"])

    def test_demo_flag_marks_everything(self):
        state = self.make_state(demo=True)
        snapshot = state.snapshot()
        self.assertTrue(snapshot["demo"])
        self.assertEqual(snapshot["source"]["kind"], "demo")
        state.ingest(self._payload())
        self.assertTrue(state.snapshot()["demo"])
        self.assertTrue(state.history("all", 24, "10m")["demo"])
        self.assertTrue(state.health()["demo"])

    def test_live_mode_never_reports_demo_snapshot(self):
        """--demo 跑过之后再以 live 启动，绝不能把演示数据当成真实数据返回。"""
        demo_state = relay_server.RelayState(data_dir=self.tmpdir, db_name="state.db",
                                             demo=True)
        try:
            demo_state.ingest(self._payload())
        finally:
            demo_state.close()
        live_state = relay_server.RelayState(data_dir=self.tmpdir, db_name="state.db")
        self.addCleanup(live_state.close)
        snapshot = live_state.snapshot()
        self.assertNotIn("demo", snapshot)
        self.assertEqual(snapshot["totals"]["total"], 0, "live 模式不得继承 demo 数据")

    def test_history_buckets(self):
        state = self.make_state()
        state.ingest(self._payload())
        for bucket, seconds in aggregate.BUCKETS.items():
            history = state.history("zhongqu", 24, bucket)
            self.assertEqual(history["bucket_seconds"], seconds)
            self.assertEqual(history["campus"], "zhongqu")
            self.assertEqual(history["hours"], 24)

    def test_config(self):
        state = self.make_state()
        config = state.config()
        self.assertEqual(len(config["campuses"]), 6)
        self.assertEqual([c["id"] for c in config["campuses"]], CAMPUS_ORDER)
        self.assertEqual([c["order"] for c in config["campuses"]], [1, 2, 3, 4, 5, 6])
        self.assertEqual(config["statuses"], ["free", "busy", "offline", "unknown"])

    def test_unassigned_payload(self):
        state = self.make_state()
        state.ingest(make_ingest([
            make_station("raw-x", "神秘站", "未知区域", [make_device("d1", "0")]),
        ]))
        payload = state.unassigned_payload()
        self.assertEqual(payload["campus_id"], "_unassigned")
        self.assertEqual(len(payload["stations"]), 1)
        self.assertEqual(state.snapshot()["totals"]["total"], 0)


# --------------------------------------------------------------------------- #
# 6.5 多数据源分区保存与合并（双源异速刷新）
# --------------------------------------------------------------------------- #
# 背景：采集端现在是「源 A 每 15 秒一轮、源 B 每 2~3 分钟一轮」。
# 如果 relay 每次 ingest 都整份替换快照，只更新源 A 的那一轮会把源 B 的
# 站点整体挤掉——用户在 App 上会看到南区那 60 个端口每隔几十秒消失一次。
# 所以这里测「按 source_id 分区保存 + 读时合并」。

class MultiSourceTest(TempDataDirMixin, unittest.TestCase):
    """按 source_id 分区保存 + merge_source_snapshots 的行为契约。"""

    def make_state(self, **kwargs):
        state = relay_server.RelayState(data_dir=self.tmpdir, db_name="multi.db", **kwargs)
        self.addCleanup(state.close)
        return state

    def _payload_a(self, statuses=("0", "0", "1")):
        """源 A：中区 3 个端口。"""
        return make_ingest([
            make_station("a:1", "中区1号充电站", "中区", [
                make_device("a-%d" % (i + 1), status, code="%03d" % (i + 1))
                for i, status in enumerate(statuses)
            ]),
        ], status_map={"free": ["0"], "busy": ["1"], "offline": ["-1"]},
           collector="real_collect.py/1.0")

    def _payload_b(self, unknown=0):
        """源 B：南区 4 个端口（真实数据里南区只有源 B 有）。

        默认 4 个端口 = 1 空闲 + 3 占用；``unknown`` 个端口改成 UNKNOWN
        来模拟「被风控限流、状态冻结」。
        """
        statuses = ["UNKNOWN"] * unknown + ["0", "1", "1", "1"]
        return make_ingest([
            make_station("lvcc-149141", "新北北区1号机（充充充充电桩-铭创电子）", "南区", [
                make_device("b-%d" % (i + 1), s, code="%03d" % (i + 1))
                for i, s in enumerate(statuses)
            ]),
        ], status_map={"free": ["0"], "busy": ["1"], "unknown": ["UNKNOWN"]},
           collector="real_collect.py/1.0")

    # ---------------------------------------------------------------- 合并
    def test_merge_keeps_both_sources(self):
        registry = aggregate.CampusRegistry()
        a = aggregate.aggregate_ingest(aggregate.validate_ingest(self._payload_a()), registry)
        b = aggregate.aggregate_ingest(aggregate.validate_ingest(self._payload_b()), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "shzu", "data_at": a["data_at"], "payload": a["snapshot"]},
            {"source_id": "lvcc", "data_at": b["data_at"], "payload": b["snapshot"]},
        ], registry)
        self.assertEqual(merged["totals"]["total"], 7, "两个源的端口应相加")
        self.assertEqual(merged["totals"]["free"], 2 + 1)
        self.assertEqual(merged["totals"]["busy"], 1 + 3)
        # 南区只有源 B 有；中区只有源 A 有
        by_id = {c["id"]: c for c in merged["campuses"]}
        self.assertEqual(by_id["zhongqu"]["totals"]["total"], 3)
        self.assertEqual(by_id["nanqu"]["totals"]["total"], 4)
        self.assertEqual([c["id"] for c in merged["campuses"]], CAMPUS_ORDER)

    def test_merge_rerecomputes_free_ratio(self):
        """合并后 free_ratio 分母仍是 total-unknown，不能用两边的 ratio 平均。"""
        registry = aggregate.CampusRegistry()
        b = aggregate.aggregate_ingest(
            aggregate.validate_ingest(self._payload_b(unknown=2)), registry)
        a = aggregate.aggregate_ingest(aggregate.validate_ingest(self._payload_a()), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "shzu", "payload": a["snapshot"]},
            {"source_id": "lvcc", "payload": b["snapshot"]},
        ], registry)
        totals = merged["totals"]
        self.assertEqual(totals["total"], 9)
        self.assertEqual(totals["unknown"], 2)
        self.assertEqual(totals["free"], 2 + 1)   # 源 A 2 空闲 + 源 B 1 空闲
        self.assertEqual(totals["free_ratio"], round(3 / 7, 4),
                         "分母应排除 unknown（7 而不是 9）")

    def test_merge_data_at_takes_latest_source(self):
        registry = aggregate.CampusRegistry()
        a = aggregate.aggregate_ingest(
            aggregate.validate_ingest(self._payload_a()), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "lvcc", "data_at": "2026-10-20T01:00:00+08:00",
             "payload": a["snapshot"]},
            {"source_id": "shzu", "data_at": "2026-10-20T05:00:00+08:00",
             "payload": a["snapshot"]},
        ], registry)
        self.assertEqual(merged["data_at"], "2026-10-20T05:00:00+08:00")

    def test_merge_dedupes_same_station_id_newest_wins(self):
        registry = aggregate.CampusRegistry()
        a1 = aggregate.aggregate_ingest(
            aggregate.validate_ingest(self._payload_a(("0", "0", "0"))), registry)
        a2 = aggregate.aggregate_ingest(
            aggregate.validate_ingest(self._payload_a(("0", "1", "1"))), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "shzu", "data_at": a1["data_at"], "payload": a1["snapshot"]},
            {"source_id": "shzu", "data_at": a2["data_at"], "payload": a2["snapshot"]},
        ], registry)
        stations = [st for c in merged["campuses"] for st in c["stations"]]
        self.assertEqual(len(stations), 1, "同源重复上报不应产生重复站点")
        self.assertEqual(merged["totals"]["free"], 1)
        self.assertEqual(merged["totals"]["busy"], 2)

    def test_merge_tolerates_none_payload(self):
        registry = aggregate.CampusRegistry()
        a = aggregate.aggregate_ingest(aggregate.validate_ingest(self._payload_a()), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "shzu", "payload": a["snapshot"]},
            {"source_id": "lvcc", "payload": None},   # 该源还没成功过一次
        ], registry)
        self.assertEqual(merged["totals"]["total"], 3)
        self.assertIsNotNone(merged["data_at"])

    # ------------------------------------------------------- 分区持久化
    def test_ingest_source_id_routes_to_own_partition(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa)
        state.ingest(pb)
        self.assertEqual(sorted(state.store.source_ids()), ["lvcc", "shzu"])
        # 两次 ingest 后合并快照仍是 7 个端口
        self.assertEqual(state.snapshot()["totals"]["total"], 7)

    def test_reingesting_source_a_keeps_source_b(self):
        """核心回归：只更新源 A，源 B 的南区 4 个端口不能被挤掉。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa)
        state.ingest(pb)
        before = state.snapshot()
        self.assertEqual(before["totals"]["total"], 7)

        # 源 A 单独再刷一轮（状态变了）
        pa2 = self._payload_a(("0", "1", "1")); pa2["source_id"] = "shzu"
        state.ingest(pa2)
        after = state.snapshot()
        self.assertEqual(after["totals"]["total"], 7, "源 B 的端口被覆盖了！")
        nanqu = {c["id"]: c for c in after["campuses"]}["nanqu"]
        self.assertEqual(nanqu["totals"]["total"], 4)
        self.assertEqual(len(nanqu["stations"]), 1)
        zhongqu = {c["id"]: c for c in after["campuses"]}["zhongqu"]
        self.assertEqual(zhongqu["totals"]["free"], 1, "源 A 的新状态应生效")

    def test_default_source_id_when_absent(self):
        state = self.make_state()
        state.ingest(self._payload_a())   # 报文不带 source_id
        self.assertEqual(state.store.source_ids(), ["default"])
        self.assertEqual(state.snapshot()["totals"]["total"], 3)

    def test_ingest_response_reports_source_id(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        result = state.ingest(pa)
        self.assertEqual(result["source_id"], "shzu")

    # ------------------------------------------------------- 时序点防锯齿
    def test_points_written_once_per_distinct_source_state(self):
        """同源重复上报相同计数时，不应该重复写时序点（否则历史曲线锯齿）。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        state.ingest(pa)
        self.assertEqual(state.store.point_count(), 6)
        state.ingest(pa)          # 完全一样的数据
        self.assertEqual(state.store.point_count(), 6, "重复 ingest 不应再写点")
        pa2 = self._payload_a(("0", "1", "1")); pa2["source_id"] = "shzu"
        state.ingest(pa2)         # 状态变了
        self.assertEqual(state.store.point_count(), 12, "状态变化应再写一轮点")

    def test_each_source_writes_its_own_points(self):
        """两个源各自都该写点（否则历史曲线缺一个源的数据）。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa)
        state.ingest(pb)
        self.assertEqual(state.store.point_count(), 12)

    # ------------------------------------------------------------ /api/sources
    def test_sources_endpoint_shape(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        result = state.sources()
        self.assertEqual(result["schema"], "shzu.sources.v1")
        ids = [s["source_id"] for s in result["sources"]]
        self.assertEqual(sorted(ids), ["lvcc", "shzu"])
        shzu = [s for s in result["sources"] if s["source_id"] == "shzu"][0]
        for field in ("source_id", "updated_at", "age_s", "stations", "devices",
                      "free", "busy", "offline", "unknown", "throttled", "blocked_since"):
            self.assertIn(field, shzu)
        self.assertEqual(shzu["devices"], 3)
        self.assertEqual(shzu["free"], 2)
        self.assertEqual(shzu["stations"], 1)
        self.assertFalse(shzu["throttled"])
        self.assertIsNotNone(shzu["updated_at"])
        self.assertIsInstance(shzu["age_s"], int)

    def test_sources_marks_throttled_source(self):
        state = self.make_state()
        pb = self._payload_b(unknown=4)   # 全 UNKNOWN = 被风控时冻结
        pb["source_id"] = "lvcc"
        pb["sources"] = [{
            "id": "lvcc", "name": "充充充充电桩-铭创电子",
            "host": "appapi.lvcchong.com", "ok": False,
            "throttled": True, "blocked_since": "2026-10-20T04:00:00+08:00",
            "retry_after": 3600,
        }]
        state.ingest(pb)
        result = state.sources()
        lvcc = [s for s in result["sources"] if s["source_id"] == "lvcc"][0]
        self.assertTrue(lvcc["throttled"])
        self.assertEqual(lvcc["blocked_since"], "2026-10-20T04:00:00+08:00")
        self.assertEqual(lvcc["name"], "充充充充电桩-铭创电子")
        self.assertEqual(lvcc["unknown"], 4)

    def test_sources_empty_before_any_ingest(self):
        """还没有任何数据时必须返回空数组，App 才会把数据源区域整块隐藏。"""
        state = self.make_state()
        self.assertEqual(state.sources()["sources"], [])

    # -------------------------------------------------- 合并路径的风控提示
    # 回归：source_warning 原来只在单源 aggregate_ingest 里生成。
    # 双源部署时 /api/snapshot 返回的是 merge_source_snapshots 拼的快照，
    # 于是 App 上的黄色提示条永远不出现 —— 源 B 被风控冻结成 384 个
    # UNKNOWN，用户却只看到一串「未知」，没有任何解释。
    def test_merged_snapshot_carries_source_warning(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(unknown=4)          # 源 B 全 UNKNOWN = 被冻结
        pb["source_id"] = "lvcc"
        pb["sources"] = [{
            "id": "lvcc", "name": "充充充充电桩-铭创电子", "ok": False,
            "throttled": True, "blocked_since": "2026-10-20T04:00:00+08:00",
            "retry_after": "2026-10-20T07:00:00+08:00",
        }]
        state.ingest(pa); state.ingest(pb)

        snap = state.snapshot()
        warn = snap.get("source_warning")
        self.assertIsNotNone(warn, "合并快照必须带 source_warning")
        self.assertEqual(warn["reason"], "throttled")
        self.assertEqual(warn["sources"], ["lvcc"])
        self.assertIn("充充充充电桩-铭创电子", warn["text"])
        self.assertIn("数据暂时停止刷新", warn["text"])
        # 「停在某时某分」取的是源 B 自己的被拦时刻，不是全局 data_at
        self.assertEqual(warn["blocked_since"], "2026-10-20T04:00:00+08:00")
        self.assertEqual(sorted(s["id"] for s in snap["sources"]), ["lvcc", "shzu"])

    def test_merged_snapshot_without_throttling_has_no_warning(self):
        """两源都正常时不该挂提示条（否则会一直误导用户说数据被限流）。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        pb["sources"] = [{"id": "lvcc", "name": "充充充充电桩-铭创电子", "ok": True}]
        state.ingest(pa); state.ingest(pb)
        snap = state.snapshot()
        self.assertIsNone(snap.get("source_warning"))
        self.assertEqual(snap["totals"]["unknown"], 0)

    # -------------------------------------------------- 僵尸 default 分区
    # 分区功能上线前，采集端 --source both 发的是整份混合数据、不带 source_id，
    # 落到 relay 就是 "default"。切到分区采集后那份数据被冻结在切换那一刻，
    # 既不再更新，又会在"数据源"面板上显示成一个没有名字的第三个源。
    # 只要还有任何带真实数据的专用分区，default 就该被忽略。
    def test_zombie_default_partition_is_ignored_by_merge(self):
        state = self.make_state()
        # 1) 先来一份老格式的整份混合数据（= 未来的僵尸分区）
        state.ingest(self._payload_a())            # 不带 source_id → default
        # 2) 再来两个真正分区的新数据
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)

        snap = state.snapshot()
        self.assertEqual(snap["totals"]["total"], 7)   # 3 + 4，没有多算
        ids = sorted(s["id"] for s in snap.get("sources") or [])
        self.assertNotIn("default", ids)
        self.assertEqual(ids, ["lvcc", "shzu"])

    def test_zombie_default_partition_hidden_from_sources_endpoint(self):
        """App 看到的源数必须等于实际合并的源数，否则面板会多出一个无名条目。"""
        state = self.make_state()
        state.ingest(self._payload_a())             # default
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        ids = sorted(s["source_id"] for s in state.sources()["sources"])
        self.assertEqual(ids, ["lvcc", "shzu"])

    def test_default_partition_still_works_when_alone(self):
        """没有专用分区时（老部署）default 必须继续生效，不能被过滤掉。

        注意老形态本身就是「整份替换」：第二次 ingest 写的是同一个 default
        分区，所以后来的那份会覆盖掉前面的——这正是分区功能要解决的痛点，
        这里只是确认过滤逻辑没有把 default 一起干掉。
        """
        state = self.make_state()
        state.ingest(self._payload_a())             # 只有 default
        snap = state.snapshot()
        self.assertEqual(snap["totals"]["total"], 3)
        self.assertEqual(
            [s["source_id"] for s in state.sources()["sources"]], ["default"])

    # ------------------------------------------ 站点 source_id（task-7）
    # 用户需求：主页「数据源」区域能点开，像「全部端口表」那样看某个源
    # 在各校区的数据。没有 station.source_id 的话前端没法把端口归到源名下。
    def test_station_carries_source_id(self):
        registry = aggregate.CampusRegistry()
        payload = self._payload_a()
        payload["source_id"] = "shzu"
        result = aggregate.aggregate_ingest(
            aggregate.validate_ingest(payload), registry)
        stations = [st for c in result["snapshot"]["campuses"] for st in c["stations"]]
        self.assertTrue(stations)
        for station in stations:
            self.assertEqual(station.get("source_id"), "shzu")

    def test_station_without_source_id_stays_backward_compatible(self):
        """旧采集器不带 source_id 时，站点里不能凭空多出这个键。"""
        registry = aggregate.CampusRegistry()
        result = aggregate.aggregate_ingest(
            aggregate.validate_ingest(self._payload_a()), registry)
        stations = [st for c in result["snapshot"]["campuses"] for st in c["stations"]]
        self.assertTrue(stations)
        for station in stations:
            self.assertNotIn("source_id", station)

    def test_merged_stations_keep_source_id(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        snap = state.snapshot()
        by_campus = {c["id"]: c for c in snap["campuses"]}
        for station in by_campus["zhongqu"]["stations"]:
            self.assertEqual(station.get("source_id"), "shzu")
        for station in by_campus["nanqu"]["stations"]:
            self.assertEqual(station.get("source_id"), "lvcc")

    # -------------------------------------- 每源分校区明细（task-7）
    def test_sources_have_campus_breakdown(self):
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        snap = state.snapshot()
        by_id = {s["id"]: s for s in snap["sources"]}
        self.assertIn("campuses", by_id["shzu"])
        self.assertIn("campuses", by_id["lvcc"])
        # 源 A 只有中区，源 B 只有南区：各自只列出自己有数据的校区
        self.assertEqual([c["id"] for c in by_id["shzu"]["campuses"]], ["zhongqu"])
        self.assertEqual([c["id"] for c in by_id["lvcc"]["campuses"]], ["nanqu"])
        for src in (by_id["shzu"], by_id["lvcc"]):
            campus = src["campuses"][0]
            for key in ("id", "name", "order", "totals", "stations"):
                self.assertIn(key, campus)
            for key in ("total", "free", "busy", "offline", "unknown", "free_ratio"):
                self.assertIn(key, campus["totals"])

    def test_sources_campus_totals_sum_to_source_totals(self):
        """分校区 totals 之和必须等于该源自己的 totals（契约不变量）。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        for src in state.snapshot()["sources"]:
            summed = aggregate.sum_totals([c["totals"] for c in src["campuses"]])
            for key in ("total", "free", "busy", "offline", "unknown"):
                self.assertEqual(summed[key], src["totals"][key],
                                 "%s.%s 不相等" % (src["id"], key))
            self.assertAlmostEqual(summed["free_ratio"], src["totals"]["free_ratio"],
                                   places=9)

    def test_sources_campus_breakdown_sorted_by_order(self):
        registry = aggregate.CampusRegistry()
        payload = make_ingest([
            make_station("s-1", "中区1号充电站", "中区",
                         [make_device("d-1", "0", "001")]),
            make_station("s-2", "南区1号充电站", "南区",
                         [make_device("d-2", "1", "001")]),
            make_station("s-3", "北区1号充电站", "北区",
                         [make_device("d-3", "0", "001")]),
        ], status_map={"free": ["0"], "busy": ["1"]})
        payload["source_id"] = "shzu"
        result = aggregate.aggregate_ingest(aggregate.validate_ingest(payload), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "shzu", "data_at": result["data_at"],
             "payload": result["snapshot"]},
        ], registry)
        src = merged["sources"][0]
        ids = [c["id"] for c in src["campuses"]]
        self.assertEqual(ids, ["zhongqu", "beiqu", "nanqu"], "必须按 order 升序")
        self.assertEqual([c["order"] for c in src["campuses"]], [1, 2, 5])

    def test_sources_campus_breakdown_free_ratio_uses_total_minus_unknown(self):
        registry = aggregate.CampusRegistry()
        payload = make_ingest([
            make_station("s-1", "南区1号充电站", "南区", [
                make_device("d-1", "0", "001"),
                make_device("d-2", "UNKNOWN", "002"),
                make_device("d-3", "UNKNOWN", "003"),
            ]),
        ], status_map={"free": ["0"], "unknown": ["UNKNOWN"]})
        payload["source_id"] = "lvcc"
        result = aggregate.aggregate_ingest(aggregate.validate_ingest(payload), registry)
        merged = aggregate.merge_source_snapshots([
            {"source_id": "lvcc", "data_at": result["data_at"],
             "payload": result["snapshot"]},
        ], registry)
        campus_totals = merged["sources"][0]["campuses"][0]["totals"]
        self.assertEqual(campus_totals["total"], 3)
        self.assertEqual(campus_totals["unknown"], 2)
        self.assertEqual(campus_totals["free_ratio"], 1.0,
                         "分母应是 total-unknown = 1，不是 3")

    def test_sources_endpoint_has_campus_breakdown(self):
        """/api/sources 也要带 campuses，且与快照里同一个源的数字一致。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(); pb["source_id"] = "lvcc"
        state.ingest(pa); state.ingest(pb)
        from_endpoint = {s["source_id"]: s for s in state.sources()["sources"]}
        from_snapshot = {s["id"]: s for s in state.snapshot()["sources"]}
        for source_id in ("shzu", "lvcc"):
            self.assertIn("campuses", from_endpoint[source_id])
            self.assertEqual(
                from_endpoint[source_id]["campuses"],
                from_snapshot[source_id]["campuses"],
                "%s 在两个接口里的分校区明细必须一致" % source_id)

    def test_source_campus_breakdown_skips_empty_campuses(self):
        """没有站点的校区不出现在明细里（否则前端会列出一堆 0 端口）。"""
        registry = aggregate.CampusRegistry()
        payload = self._payload_a()
        payload["source_id"] = "shzu"
        result = aggregate.aggregate_ingest(aggregate.validate_ingest(payload), registry)
        breakdown = aggregate.source_campus_breakdown(result["snapshot"], registry)
        self.assertEqual([c["id"] for c in breakdown], ["zhongqu"])

    def test_source_with_no_stations_has_empty_breakdown(self):
        """某个源这一轮没采到任何站点：campuses 是空数组而不是缺字段。"""
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        empty = make_ingest([], status_map={"free": ["0"]})
        empty["source_id"] = "lvcc"
        state.ingest(pa)
        state.ingest(empty)
        srcs = {s["id"]: s for s in state.snapshot()["sources"]}
        self.assertEqual(srcs["lvcc"]["campuses"], [])
        self.assertEqual(srcs["lvcc"]["totals"]["total"], 0)
        self.assertEqual(srcs["shzu"]["campuses"][0]["id"], "zhongqu")

    def test_throttled_source_keeps_campus_breakdown(self):
        """被风控的源必须同时保留「限流标记」和「分校区明细」。

        合并时每个源有两份数据：采集器自报的健康状态（throttled 等）和
        relay 自己算的分校区明细。两份是**合并**不是二选一——按 updated_at
        挑一份会把 throttled 或 campuses 丢掉（Lead 特别提醒过的坑）。
        """
        state = self.make_state()
        pa = self._payload_a(); pa["source_id"] = "shzu"
        pb = self._payload_b(unknown=4)
        pb["source_id"] = "lvcc"
        pb["sources"] = [{
            "id": "lvcc", "name": "充充充充电桩-铭创电子", "ok": False,
            "throttled": True, "blocked_since": "2026-10-20T04:00:00+08:00",
        }]
        state.ingest(pa); state.ingest(pb)
        lvcc = [s for s in state.snapshot()["sources"] if s["id"] == "lvcc"][0]
        self.assertTrue(lvcc["throttled"], "限流标记被分校区明细覆盖掉了")
        self.assertEqual(lvcc["blocked_since"], "2026-10-20T04:00:00+08:00")
        self.assertEqual([c["id"] for c in lvcc["campuses"]], ["nanqu"])
        self.assertEqual(lvcc["campuses"][0]["totals"]["unknown"], 4)


# --------------------------------------------------------------------------- #
# 7. HTTP 全链路（真起一个 ThreadingHTTPServer）
# --------------------------------------------------------------------------- #

class HttpTest(TempDataDirMixin, unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls._fixture = load_demo_ingest()

    def setUp(self):
        super().setUp()
        self.state = relay_server.RelayState(
            data_dir=self.tmpdir, db_name="http.db",
        )
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), relay_server.RelayHandler)
        self.httpd.daemon_threads = True
        self.httpd.state = self.state
        self.httpd.app_dir = os.path.join(PROJECT_ROOT, "app")
        self.port = self.httpd.server_address[1]
        self.base = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(
            target=self.httpd.serve_forever,
            kwargs={"poll_interval": 0.05},
            daemon=True,
        )
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self):
        try:
            self.httpd.shutdown()
        except Exception:
            pass
        try:
            self.httpd.server_close()
        except Exception:
            pass
        self.state.close()

    # -- 工具 -------------------------------------------------------------
    def request(self, method, path, body=None, headers=None):
        data = None
        merged = dict(headers or {})
        if body is not None:
            if isinstance(body, (dict, list)):
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                merged.setdefault("Content-Type", "application/json")
            elif isinstance(body, str):
                data = body.encode("utf-8")
            else:
                data = body
        req = urllib.request.Request(self.base + path, data=data,
                                     headers=merged, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, exc.read().decode("utf-8", "replace")
            finally:
                exc.close()

    def get_json(self, path):
        status, raw = self.request("GET", path)
        self.assertEqual(status, 200, "GET %s → %s %s" % (path, status, raw[:300]))
        return json.loads(raw)

    def post_json(self, path, payload):
        status, raw = self.request("POST", path, payload)
        return status, raw

    def sample_payload(self):
        if self._fixture is None:
            return make_ingest([
                make_station("raw-1", "中区1号充电站", "中区", [
                    make_device("raw-1-1", "0", "001"),
                    make_device("raw-1-2", "1", "002"),
                ]),
            ])
        payload = json.loads(json.dumps(self._fixture))
        payload["collected_at"] = aggregate.now_iso()
        return payload

    # -- 用例 -------------------------------------------------------------
    def test_health_endpoint(self):
        data = self.get_json("/api/health")
        self.assertTrue(data["ok"])
        for key in ("version", "uptime_s", "last_ingest_at",
                    "consecutive_failures", "mode"):
            self.assertIn(key, data)

    def test_config_endpoint_six_campuses(self):
        data = self.get_json("/api/config")
        self.assertEqual(len(data["campuses"]), 6)
        self.assertEqual([c["id"] for c in data["campuses"]], CAMPUS_ORDER)

    def test_snapshot_before_any_ingest(self):
        data = self.get_json("/api/snapshot")
        self.assertEqual(data["schema"], "shzu.snapshot.v1")
        self.assertEqual(len(data["campuses"]), 6)
        self.assertIsNone(data["data_at"])
        self.assertTrue(data["stale"])

    def test_ingest_then_snapshot(self):
        status, raw = self.post_json("/api/ingest", self.sample_payload())
        self.assertEqual(status, 200, raw[:300])
        result = json.loads(raw)
        self.assertTrue(result["ok"])
        self.assertIsInstance(result["accepted"], int)
        self.assertGreater(result["accepted"], 0)
        self.assertIn("snapshot_at", result)

        snapshot = self.get_json("/api/snapshot")
        self.assertEqual(snapshot["schema"], "shzu.snapshot.v1")
        self.assertFalse(snapshot["stale"])
        self.assertEqual([c["id"] for c in snapshot["campuses"]], CAMPUS_ORDER)
        self.assertEqual([c["order"] for c in snapshot["campuses"]], [1, 2, 3, 4, 5, 6])

        totals = snapshot["totals"]
        self.assertEqual(
            totals["total"],
            totals["free"] + totals["busy"] + totals["offline"] + totals["unknown"],
        )
        denom = totals["total"] - totals["unknown"]
        want = 0.0 if denom <= 0 else round(totals["free"] / denom, 4)
        self.assertAlmostEqual(totals["free_ratio"], want, places=9)
        for key in ("total", "free", "busy", "offline", "unknown"):
            self.assertEqual(
                totals[key], sum(c["totals"][key] for c in snapshot["campuses"]))
            self.assertIsInstance(totals[key], int)

    def test_snapshot_matches_schema_shape(self):
        self.post_json("/api/ingest", self.sample_payload())
        snapshot = self.get_json("/api/snapshot")
        self.assertIn("source", snapshot)
        for campus in snapshot["campuses"]:
            self.assertIn(campus["id"], CAMPUS_ORDER)
            for station in campus["stations"]:
                for key in ("id", "name", "campus_id", "totals", "devices"):
                    self.assertIn(key, station)
                self.assertEqual(station["campus_id"], campus["id"])
                for device in station["devices"]:
                    self.assertIn("id", device)
                    self.assertIn(device["status"], aggregate.STATUSES)

    def test_history_endpoints(self):
        self.post_json("/api/ingest", self.sample_payload())
        for query in ("?hours=24", "?campus=zhongqu&hours=24&bucket=10m",
                      "?campus=all&hours=6&bucket=1h"):
            data = self.get_json("/api/history" + query)
            self.assertEqual(data["schema"], "shzu.history.v1")
            self.assertIsInstance(data["points"], list)
            self.assertIn("bucket_seconds", data)
            times = [aggregate.parse_iso(p["t"]) for p in data["points"]]
            self.assertEqual(times, sorted(times), "history 必须按时间升序")

    def test_history_ratio_matches_point(self):
        self.post_json("/api/ingest", self.sample_payload())
        data = self.get_json("/api/history?hours=24&bucket=10m")
        self.assertTrue(data["points"])
        for point in data["points"]:
            if point["total"] > 0:
                want = round(point["free"] / point["total"], 4)
                self.assertLessEqual(abs(point["free_ratio"] - want), 2e-4)

    def test_invalid_ingest_returns_4xx(self):
        cases = [
            ("空 body", "", {}),
            ("非 JSON", "not-json-at-all", {"Content-Type": "application/json"}),
            ("缺 schema", json.dumps({"collected_at": "x", "stations": []}),
             {"Content-Type": "application/json"}),
            ("schema 错", json.dumps({"schema": "wrong", "collected_at": "x",
                                      "stations": []}),
             {"Content-Type": "application/json"}),
            ("stations 非数组", json.dumps({"schema": "shzu.ingest.v1",
                                            "collected_at": "x", "stations": "oops"}),
             {"Content-Type": "application/json"}),
            ("非 UTC-8 时间", json.dumps({"schema": "shzu.ingest.v1",
                                          "collected_at": "昨天", "stations": []}),
             {"Content-Type": "application/json"}),
        ]
        for name, body, headers in cases:
            status, raw = self.request("POST", "/api/ingest", body, headers)
            self.assertGreaterEqual(status, 400, "%s 应 4xx，实际 %s" % (name, status))
            self.assertLess(status, 500, "%s 不能 5xx：%s" % (name, raw[:200]))
            payload = json.loads(raw)
            self.assertFalse(payload["ok"])
            self.assertIn("error", payload)

    def test_invalid_query_returns_400(self):
        for query in ("?campus=nope", "?bucket=99m", "?hours=abc", "?hours=0",
                      "?hours=9999"):
            status, raw = self.request("GET", "/api/history" + query)
            self.assertEqual(status, 400, "%s → %s %s" % (query, status, raw[:160]))

    def test_unknown_api_returns_404(self):
        status, _ = self.request("GET", "/api/does-not-exist")
        self.assertEqual(status, 404)

    def test_root_serves_html(self):
        status, raw = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("<html", raw.lower())

    def test_static_placeholder_when_app_missing(self):
        """app/ 还没交付时必须能容错（返回占位页而不是 500）。"""
        self.httpd.app_dir = os.path.join(self.tmpdir, "no-such-app")
        status, raw = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("<!doctype", raw.lower())
        status, _ = self.request("GET", "/app.js")
        self.assertEqual(status, 404)

    def test_static_path_traversal_blocked(self):
        status, _ = self.request("GET", "/../shared/contract.md")
        self.assertIn(status, (403, 404))

    def test_cors_header_present(self):
        req = urllib.request.Request(self.base + "/api/snapshot", method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "*")

    def test_options_preflight(self):
        status, _ = self.request("OPTIONS", "/api/ingest")
        self.assertEqual(status, 204)

    def test_full_chain_with_demo_fixture(self):
        """demo fixture 走完整链路：ingest → snapshot → history，逐项验契约。"""
        if self._fixture is None:
            self.skipTest("demo/ingest_sample.json 不存在")
        payload = self.sample_payload()
        status, raw = self.post_json("/api/ingest", payload)
        self.assertEqual(status, 200, raw[:300])
        accepted = json.loads(raw)["accepted"]

        snapshot = self.get_json("/api/snapshot")
        self.assertEqual(snapshot["totals"]["total"], accepted)
        self.assertEqual(len(snapshot["campuses"]), 6)
        station_count = sum(len(c["stations"]) for c in snapshot["campuses"])
        self.assertGreater(station_count, 0)

        # 每个站点 campus_id 必须与所属校区一致（含未归类被排除）
        for campus in snapshot["campuses"]:
            for station in campus["stations"]:
                self.assertEqual(station["campus_id"], campus["id"])

        history = self.get_json("/api/history?campus=all&hours=24&bucket=10m")
        self.assertTrue(history["points"])
        self.assertEqual(history["campus"], "all")

        health = self.get_json("/api/health")
        self.assertEqual(health["devices"], accepted)
        self.assertEqual(health["consecutive_failures"], 0)


# --------------------------------------------------------------------------- #
# 8. 契约 fixture 自查（demo/ 下的文件必须符合 schema 约定的必需字段）
# --------------------------------------------------------------------------- #

class FixtureShapeTest(unittest.TestCase):

    def test_demo_ingest_fixture_shape(self):
        fixture = load_demo_ingest()
        if fixture is None:
            self.skipTest("demo/ingest_sample.json 不存在")
        self.assertEqual(fixture.get("schema"), "shzu.ingest.v1")
        self.assertIn("collected_at", fixture)
        self.assertIsInstance(fixture["stations"], list)
        for station in fixture["stations"]:
            self.assertIn("raw_id", station)
            self.assertIsInstance(station["devices"], list)
            for device in station["devices"]:
                self.assertIn("raw_id", device)
                self.assertIn("raw_status", device)

    def test_demo_ingest_roundtrip_is_clean(self):
        """demo fixture 喂进 relay 后，所有桩状态都应是已知四态之一。"""
        fixture = load_demo_ingest()
        if fixture is None:
            self.skipTest("demo/ingest_sample.json 不存在")
        registry = aggregate.CampusRegistry()
        payload = aggregate.validate_ingest(fixture)
        result = aggregate.aggregate_ingest(payload, registry)
        self.assertEqual(result["snapshot"]["totals"]["unknown"], 0,
                         "demo fixture 的 raw_status 应该都能映射到已知状态")
        self.assertEqual(len(result["snapshot"]["campuses"]), 6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
