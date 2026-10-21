# 数据契约 v1（唯一事实来源）

所有模块（sniffer / relay / app / android）**只能**按本文件定义的 JSON 结构交换数据。
改动契约必须同时改 `shared/schema/*.json` 并通知所有模块，禁止单方面扩展字段名。

---

## 0. 链路

```
[一次性] 抓包(MITM) ──> profile.json ──> 轮询采集器(平板常驻) ──POST /api/ingest──> relay ──GET /api/snapshot──> App
                              │                                                                 ▲
                              └── HAR/JSON 导入 ────────────────────────────────────────────────┘
```

- **抓包只做一次**，目的是拿到 `profile.json`（接口地址/方法/请求头/请求体/响应字段路径）。
- 之后平板只跑 **轮询采集器**，不发 MITM、不装代理，微信小程序也不受影响。
- relay 内部保留时序，App 只消费 `/api/snapshot` 与 `/api/history`。

---

## 1. 充电桩状态枚举（唯一写法，全链路小写）

| 值 | 含义 |
|---|---|
| `free` | 空闲，可充电 |
| `busy` | 占用，正在充电 |
| `offline` | 离线 / 故障 / 维护 |
| `unknown` | 数据缺失，无法判断（**不计入 free，也不计入 busy**） |

---

## 2. Snapshot（核心对象）

App 与 relay 之间的主载体，`GET /api/snapshot` 返回。

```json
{
  "schema": "shzu.snapshot.v1",
  "generated_at": "2026-10-20T00:30:00+08:00",
  "data_at": "2026-10-20T00:29:41+08:00",
  "stale": false,
  "source": {
    "kind": "poll",
    "applet": "石河子大学充电桩",
    "collector": "termux-poller@1.0.0",
    "confidence": 0.95
  },
  "totals": {
    "total": 612,
    "free": 187,
    "busy": 402,
    "offline": 23,
    "unknown": 0,
    "free_ratio": 0.3056
  },
  "campuses": [
    {
      "id": "zhongqu",
      "name": "中区",
      "order": 1,
      "totals": { "total": 120, "free": 41, "busy": 74, "offline": 5, "unknown": 0, "free_ratio": 0.3417 },
      "stations": [
        {
          "id": "zhongqu-01",
          "name": "中区1号充电站（1号宿舍楼旁）",
          "campus_id": "zhongqu",
          "address": "石河子市北四路 中区1号宿舍楼东侧",
          "lat": 44.3061,
          "lng": 86.0473,
          "totals": { "total": 12, "free": 5, "busy": 6, "offline": 1, "unknown": 0, "free_ratio": 0.4167 },
          "updated_at": "2026-10-20T00:29:41+08:00",
          "devices": [
            {
              "id": "zhongqu-01-03",
              "code": "003",
              "name": "3号桩",
              "status": "free",
              "power_w": 300,
              "busy_since": null,
              "order_id": null
            }
          ]
        }
      ]
    }
  ]
}
```

### 硬性规则
1. `campuses` **永远**是六大校区全部 6 项，顺序按 `campus.json` 的 `order`；某区没数据则 `totals` 全 0、`stations` 为空数组，**不允许缺项**。
2. `free_ratio` = `free / (total - unknown)`，分母为 0 时取 `0.0`，保留 4 位小数。
3. `totals.total` = `free + busy + offline + unknown`。
4. 时间一律 **ISO8601 带时区偏移**（`+08:00`），不用 Unix 时间戳。
5. `stale`：`now - data_at > 15 分钟` 即 `true`。
6. 所有 `id` 为字符串，稳定不随时间变化（由采集器生成并本地持久化，见 §6）。

---

## 3. Ingest（采集器 → relay）

`POST /api/ingest`，`Content-Type: application/json`，可选头 `X-Collector-Token: <token>`。

请求体 = **原始设备列表**（未按校区聚合，聚合由 relay 做，保证唯一聚合实现）：

```json
{
  "schema": "shzu.ingest.v1",
  "collected_at": "2026-10-20T00:29:41+08:00",
  "collector": "termux-poller@1.0.0",
  "site": "石河子大学",
  "stations": [
    {
      "raw_id": "厂商侧的站ID",
      "raw_name": "中区1号充电站",
      "raw_area": "中区",
      "address": "可选",
      "lat": 44.3061,
      "lng": 86.0473,
      "devices": [
        { "raw_id": "厂商侧的桩ID", "code": "003", "name": "3号桩", "raw_status": "0", "power_w": 300 }
      ]
    }
  ]
}
```

- `raw_status` 是厂商原值，**字符串原样**保留；relay 依据 `campus.json.status_map` + `profile.status_map`（若 ingest 带 `status_map` 字段则优先）翻译成 `free/busy/offline/unknown`。
- 允许带可选字段 `status_map: {"free": [...], "busy": [...], "offline": [...]}` 覆盖默认映射。
- 响应：`{"ok": true, "accepted": 12, "snapshot_at": "..."}`；失败 `{"ok": false, "error": "..."}` + 非 2xx。

---

## 4. Profile（抓包产物，喂给采集器）

`sniffer/profiles/<vendor>.json`，采集器读它就知道怎么轮询。

```json
{
  "schema": "shzu.profile.v1",
  "vendor": "laidiandian",
  "applet_name": "石河子大学充电桩",
  "learned_at": "2026-10-20T00:10:00+08:00",
  "base_url": "https://api.example.com",
  "requests": [
    {
      "name": "station-list",
      "method": "GET",
      "url": "https://api.example.com/api/v1/station/list?orgId=123",
      "headers": { "token": "xxx", "user-agent": "MicroMessenger/8.0.50" },
      "body": null,
      "content_type": null
    }
  ],
  "field_paths": {
    "list": "data.records",
    "station_id": "id",
    "station_name": "name",
    "area": "areaName",
    "device_list": "devices",
    "device_id": "id",
    "device_code": "code",
    "device_status": "status",
    "lat": "latitude",
    "lng": "longitude"
  },
  "status_map": { "free": ["0"], "busy": ["1"], "offline": ["-1", "2"] },
  "notes": "人肉核对过的映射写在这里"
}
```

- `field_paths` 支持点号路径；数组项路径也允许（如 `data.records`）。
- 缺失字段用 `null`，采集器须容错。
- **不允许**在 profile 里写死充电桩数据；数据必须来自实时请求。

---

## 5. History（`GET /api/history`）

```
GET /api/history?campus=zhongqu&hours=24&bucket=10m
```

```json
{
  "schema": "shzu.history.v1",
  "campus": "zhongqu",
  "hours": 24,
  "bucket_seconds": 600,
  "points": [
    { "t": "2026-10-20T00:00:00+08:00", "free": 40, "total": 120, "free_ratio": 0.3333 }
  ]
}
```

- `campus=all` 或省略 = 全校合计。
- `bucket` 允许 `1m`/`5m`/`10m`/`30m`/`1h`，默认 `10m`；每个桶取**桶内均值**（不是末值）。

### 5.1 公网部署（Cloudflare Worker）上的 `/history`

Worker 没有数据库，它有两条路径，**返回结构和上面完全一致**，App 不需要区分：

| 部署 | 路径 | `source` | 点位粒度 |
|---|---|---|---|
| 平板局域网 relay | `GET /api/history`（以及 `/history`） | `sqlite` | 1 分钟（采集节奏） |
| 公网域名（有 relay） | 同上，实时读 SQLite | `sqlite` | 1 分钟 |
| 公网域名（**没有** relay，纯 Worker） | `GET /history`（以及 `/api/history`） | `kv-ring` | 10 分钟 |

- `kv-ring` 的点来自 Worker 自己维护的**历史环形缓冲**：每次 KV 落盘（`KV_PERSIST_SEC`，
  默认 600 秒）把当前快照汇总成一个点（`[at, free, total, [[campusId, free, total], …]]`）
  跟着**同一个 key、同一次 PUT** 存进 `latest` 的 `hist` 字段 —— 所以历史曲线**不增加任何
  KV 写入**（写额度只剩几百次机动，这条是硬约束）。
- 最多保留 1008 个点（10 分钟 × 168 小时 = 7 天）。
- 曲线还没攒够点时返回 `"points": []`（**不是 404**），App 显示「暂无历史数据」并把
  「当前空闲率」用最新快照补上 —— 这就是网页端也能看到当前值的原因。
- `/health` 的 `granularity_seconds` 就是这层冷存的间隔。

---

## 6. 各类 ID 与稳定聚合规则

1. 采集器首次运行生成 `sniffer/state/device_map.json`，把 `raw_id → 稳定 id` 固化，**之后永不改变**（否则历史曲线断裂）。
2. 稳定 id 格式：
   - 校区：`campus.json` 里的 `id`
   - 站：`<campus_id>-<两位序号>`，如 `zhongqu-01`
   - 桩：`<station_id>-<三位序号>`，如 `zhongqu-01-003`
3. 站点归区顺序：
   a. 站名/地址/`raw_area` 命中某校区 alias → 该区
   b. 都没有 → `_unassigned` 虚拟区（App 单独显示"未归类"，不混入六校区图表）
4. 一个站若跨区命中多个，取**最先匹配的 alias 长度最长者**（更具体优先）。

---

## 7. 错误与降级

| 场景 | 行为 |
|---|---|
| relay 挂了 | App 显示上次快照 + `stale` 徽标 + 顶部红条"数据可能过期" |
| 采集器某次请求失败 | 保留上次数值，`data_at` 不变，relay 记录连续失败次数，`/api/health` 暴露 |
| 缺整个校区 | 该区 `totals` 全 0，UI 显示"—"，不得伪造数字 |
| 字段解析失败 | 该桩 `unknown`，不猜测 |

**任何模块都禁止用随机数/插值伪造充电桩数据。** 唯一的例外是显式演示模式（`demo=true` / `--demo`），且必须在 UI 或响应里带 `"demo": true` 标记。
