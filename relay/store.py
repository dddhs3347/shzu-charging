#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""relay/store.py — SQLite 持久层（纯标准库 sqlite3）。

存四样东西：
  1. ``snapshots`` — 最近若干份完整快照（JSON 文本），供 /api/snapshot 冷启动用
  2. ``points``    — 每个校区每个采样时刻的聚合计数，供 /api/history 出曲线
  3. ``meta``      — 键值对：稳定 id 固化表、未归类站点、计数器等
  4. ``ingest_log``— 每次 ingest 的成败记录（/api/health 与排障用）

设计约束（shared/contract.md §7、docs/架构设计.md）：
  - **只存聚合结果**，不存每根桩的每秒状态，SQLite 体积可控；
  - 时序保留 30 天（``--retain-days`` 可调），快照只保留最近几十份；
  - 所有写操作走同一个 RLock，ThreadingHTTPServer 多线程下也安全。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

DEFAULT_RETAIN_DAYS = 30
DEFAULT_KEEP_SNAPSHOTS = 48  # 快照每份几十 KB，只留最近 48 份（约 2 天）

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_epoch INTEGER NOT NULL,
    data_at       TEXT,
    demo          INTEGER NOT NULL DEFAULT 0,
    payload       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS points (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    campus_id TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    free      INTEGER NOT NULL,
    busy      INTEGER NOT NULL,
    offline   INTEGER NOT NULL,
    unknown   INTEGER NOT NULL,
    total     INTEGER NOT NULL,
    demo      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_points_campus_ts ON points (campus_id, ts);
CREATE INDEX IF NOT EXISTS idx_points_ts        ON points (ts);

CREATE TABLE IF NOT EXISTS ingest_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    ok        INTEGER NOT NULL,
    collector TEXT,
    accepted  INTEGER,
    error     TEXT,
    remote    TEXT
);

-- 按数据源分别保存最近一次聚合结果（source_state）。
-- 为什么不能「整份快照替换」：采集端现在是双源异速的（源 A 每 15 秒一轮，
-- 源 B 每 2~3 分钟一轮），整份替换会让只更新源 A 的那一轮把源 B 的站点整体挤没。
-- 合并在读的时候做，见 aggregate.merge_source_snapshots()。
CREATE TABLE IF NOT EXISTS source_state (
    source_id     TEXT PRIMARY KEY,
    updated_epoch INTEGER NOT NULL,
    data_at       TEXT,
    demo          INTEGER NOT NULL DEFAULT 0,
    payload       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_ts ON ingest_log (ts);
"""


class Store:
    """relay 的唯一持久化入口；所有方法线程安全。"""

    def __init__(self, data_dir, db_name="charging.db",
                 retain_days=DEFAULT_RETAIN_DAYS,
                 keep_snapshots=DEFAULT_KEEP_SNAPSHOTS):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self.path = os.path.join(self.data_dir, db_name)
        self.retain_days = int(retain_days)
        self.keep_snapshots = int(keep_snapshots)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=15.0)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(_SCHEMA)
            self._conn.commit()
        try:
            self.prune()
        except Exception:  # pragma: no cover - 清理失败不该阻止服务启动
            pass

    # ---------------------------------------------------------------- 基础
    def close(self):
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass

    def _exec(self, sql, params=()):
        with self._lock:
            cur = self._conn.execute(sql, params)
            self._conn.commit()
            return cur

    def _query(self, sql, params=()):
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    # ---------------------------------------------------------------- meta
    def meta_get(self, key, default=None):
        rows = self._query("SELECT value FROM meta WHERE key = ?", (key,))
        if not rows:
            return default
        try:
            return json.loads(rows[0]["value"])
        except (ValueError, TypeError):
            return default

    def meta_set(self, key, value):
        text = json.dumps(value, ensure_ascii=False)
        self._exec(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, text),
        )

    def bump_counter(self, key, delta=1):
        """整数计数器（失败次数等）；不存在则从 0 开始。"""
        current = self.meta_get(key, 0)
        if not isinstance(current, int):
            current = 0
        value = current + delta
        self.meta_set(key, value)
        return value

    # ------------------------------------------------------------ snapshots
    def save_snapshot(self, snapshot, demo=False):
        """写入最新快照并裁掉过旧的（只留最近 keep_snapshots 份）。"""
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        now = int(time.time())
        data_at = snapshot.get("data_at")
        with self._lock:
            self._conn.execute(
                "INSERT INTO snapshots (created_epoch, data_at, demo, payload) "
                "VALUES (?, ?, ?, ?)",
                (now, data_at, 1 if demo else 0, payload),
            )
            self._conn.execute(
                "DELETE FROM snapshots WHERE id NOT IN "
                "(SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)",
                (self.keep_snapshots,),
            )
            self._conn.commit()
        return now

    def latest_snapshot(self, demo=None):
        """取最近一份快照。

        ``demo=None`` 不限；``demo=True/False`` 只取对应模式的快照，
        避免 demo 模式与真实采集互相污染。
        """
        if demo is None:
            rows = self._query(
                "SELECT payload FROM snapshots ORDER BY id DESC LIMIT 1")
        else:
            rows = self._query(
                "SELECT payload FROM snapshots WHERE demo = ? ORDER BY id DESC LIMIT 1",
                (1 if demo else 0,))
        if not rows:
            return None
        try:
            return json.loads(rows[0]["payload"])
        except ValueError:
            return None

    def snapshot_count(self, demo=None):
        if demo is None:
            rows = self._query("SELECT COUNT(*) AS n FROM snapshots")
        else:
            rows = self._query("SELECT COUNT(*) AS n FROM snapshots WHERE demo = ?",
                               (1 if demo else 0,))
        return int(rows[0]["n"]) if rows else 0

    def clear_snapshots(self, demo_only=None):
        """清空快照；``demo_only=True/False`` 时只清对应模式。"""
        if demo_only is None:
            self._exec("DELETE FROM snapshots")
        else:
            self._exec("DELETE FROM snapshots WHERE demo = ?",
                       (1 if demo_only else 0,))

    # ------------------------------------------------------- source_state
    def save_source_state(self, source_id, snapshot, demo=False, epoch=None):
        """保存某个数据源最近一次聚合结果（upsert，按 source_id 覆盖）。"""
        sid = str(source_id or "default")
        payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
        stamp = int(epoch if epoch is not None else time.time())
        self._exec(
            "INSERT INTO source_state (source_id, updated_epoch, data_at, demo, payload) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(source_id) DO UPDATE SET "
            "updated_epoch = excluded.updated_epoch, data_at = excluded.data_at, "
            "demo = excluded.demo, payload = excluded.payload",
            (sid, stamp, snapshot.get("data_at"), 1 if demo else 0, payload),
        )
        return stamp

    def source_states(self, demo=None):
        """取全部数据源状态；``demo`` 为 None/True/False 分别表示不限/demo/真实。

        按 ``updated_epoch`` 升序返回：合并时以「最后更新的源」为准算 data_at/stale。
        """
        if demo is None:
            rows = self._query(
                "SELECT source_id, updated_epoch, data_at, demo, payload "
                "FROM source_state ORDER BY updated_epoch ASC")
        else:
            rows = self._query(
                "SELECT source_id, updated_epoch, data_at, demo, payload "
                "FROM source_state WHERE demo = ? ORDER BY updated_epoch ASC",
                (1 if demo else 0,))
        out = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
            except (ValueError, TypeError):
                continue
            out.append({
                "source_id": str(row["source_id"]),
                "updated_epoch": int(row["updated_epoch"]),
                "data_at": row["data_at"],
                "payload": payload,
            })
        return out

    def source_ids(self, demo=None):
        return [item["source_id"] for item in self.source_states(demo=demo)]

    # --------------------------------------------------------------- points
    def add_points(self, points, ts=None, demo=False):
        """批量写时序点。

        ``points`` 每项必须含 campus_id/free/busy/offline/unknown/total；
        ``ts`` 可统一指定（不指定则取每项的 ``ts`` 字段，再退回当前时间）。
        """
        if not points:
            return 0
        default_ts = int(ts if ts is not None else time.time())
        flag = 1 if demo else 0
        rows = []
        for point in points:
            try:
                stamp = int(point.get("ts", default_ts))
            except (TypeError, ValueError):
                stamp = default_ts
            rows.append((
                str(point.get("campus_id") or ""),
                stamp,
                int(point.get("free") or 0),
                int(point.get("busy") or 0),
                int(point.get("offline") or 0),
                int(point.get("unknown") or 0),
                int(point.get("total") or 0),
                flag,
            ))
        with self._lock:
            self._conn.executemany(
                "INSERT INTO points (campus_id, ts, free, busy, offline, unknown, total, demo) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            self._conn.commit()
        return len(rows)

    def history(self, campus_id, since_ts, bucket_seconds, until_ts=None, demo=None):
        """按桶取**桶内均值**（contract.md §5：不是末值）。

        ``campus_id=None`` 表示全校合计：先按 (桶, 校区) 求均值，再把各校区的
        均值相加——等价于「该桶内所有校区读数的合计」，不会因为某校区没有
        采样而拉低平均。

        ``demo=None`` 不限模式；``True/False`` 只看 demo / 只看真实数据。

        返回 ``[{"t","free","busy","offline","unknown","total","samples"}]``，
        数值为 float（由调用方四舍五入成整数）。
        """
        bucket = max(1, int(bucket_seconds))
        where = ["ts >= ?"]
        params = [int(since_ts)]
        if until_ts is not None:
            where.append("ts <= ?")
            params.append(int(until_ts))
        if demo is not None:
            where.append("demo = ?")
            params.append(1 if demo else 0)
        if campus_id is not None:
            where.append("campus_id = ?")
            params.append(campus_id)
        inner = (
            "SELECT (ts / ?) * ? AS bucket, campus_id, "
            "AVG(free) AS af, AVG(busy) AS ab, AVG(offline) AS ao, "
            "AVG(unknown) AS au, AVG(total) AS at, COUNT(*) AS samples "
            "FROM points WHERE " + " AND ".join(where) +
            " GROUP BY bucket, campus_id"
        )
        sql = (
            "SELECT bucket, SUM(af) AS af, SUM(ab) AS ab, SUM(ao) AS ao, "
            "SUM(au) AS au, SUM(at) AS at, SUM(samples) AS samples "
            "FROM (" + inner + ") GROUP BY bucket ORDER BY bucket ASC"
        )
        rows = self._query(sql, tuple([bucket, bucket] + params))
        out = []
        for row in rows:
            out.append({
                "t": int(row["bucket"]),
                "free": float(row["af"] or 0.0),
                "busy": float(row["ab"] or 0.0),
                "offline": float(row["ao"] or 0.0),
                "unknown": float(row["au"] or 0.0),
                "total": float(row["at"] or 0.0),
                "samples": int(row["samples"] or 0),
            })
        return out

    def point_count(self, demo=None):
        if demo is None:
            rows = self._query("SELECT COUNT(*) AS n FROM points")
        else:
            rows = self._query("SELECT COUNT(*) AS n FROM points WHERE demo = ?",
                               (1 if demo else 0,))
        return int(rows[0]["n"]) if rows else 0

    def oldest_point_ts(self):
        rows = self._query("SELECT MIN(ts) AS t FROM points")
        if not rows or rows[0]["t"] is None:
            return None
        return int(rows[0]["t"])

    def clear_points(self, demo_only=None):
        """清空时序点；``demo_only=True/False`` 时只清对应模式。"""
        if demo_only is None:
            self._exec("DELETE FROM points")
        else:
            self._exec("DELETE FROM points WHERE demo = ?",
                       (1 if demo_only else 0,))

    # ----------------------------------------------------------- ingest log
    def log_ingest(self, ok, collector=None, accepted=None, error=None,
                   remote=None, ts=None):
        stamp = int(ts if ts is not None else time.time())
        self._exec(
            "INSERT INTO ingest_log (ts, ok, collector, accepted, error, remote) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (stamp, 1 if ok else 0, collector, accepted, error, remote),
        )
        cutoff = stamp - self.retain_days * 86400
        with self._lock:
            self._conn.execute("DELETE FROM ingest_log WHERE ts < ?", (cutoff,))
            self._conn.commit()

    def recent_ingests(self, limit=10):
        rows = self._query(
            "SELECT ts, ok, collector, accepted, error FROM ingest_log "
            "ORDER BY id DESC LIMIT ?",
            (int(limit),),
        )
        return [
            {
                "ts": int(r["ts"]),
                "ok": bool(r["ok"]),
                "collector": r["collector"],
                "accepted": r["accepted"],
                "error": r["error"],
            }
            for r in rows
        ]

    # --------------------------------------------------------------- 清理
    def prune(self, now_ts=None):
        """删除超过保留期的时序点与采集日志；返回删除行数。"""
        now = int(now_ts if now_ts is not None else time.time())
        cutoff = now - self.retain_days * 86400
        with self._lock:
            cur1 = self._conn.execute("DELETE FROM points WHERE ts < ?", (cutoff,))
            cur2 = self._conn.execute("DELETE FROM ingest_log WHERE ts < ?", (cutoff,))
            self._conn.commit()
            removed = (cur1.rowcount or 0) + (cur2.rowcount or 0)
        if removed > 5000:
            try:
                with self._lock:
                    self._conn.execute("VACUUM")
            except Exception:  # pragma: no cover - VACUUM 失败不影响主流程
                pass
        return removed

    # --------------------------------------------------------------- 统计
    def stats(self):
        return {
            "db_path": self.path,
            "snapshots": self.snapshot_count(),
            "points": self.point_count(),
            "oldest_point": self.oldest_point_ts(),
            "retain_days": self.retain_days,
            "keep_snapshots": self.keep_snapshots,
        }
