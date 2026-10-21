# relay —— 石大充电桩查询 App 的后端

纯 Python 3 标准库实现的聚合 + 缓存 + 静态托管服务。**零第三方依赖**，Termux 里
`python server.py` 直接能跑。

```
抓包 sniffer ──profile.json──> 采集器 ──POST /api/ingest──> relay ──GET /api/snapshot──> App
                                                             │
                                                     SQLite（快照 + 时序点 + 失败计数）
```

数据契约以 `../shared/contract.md` 为唯一事实来源，本模块严格按它实现
（`shzu.snapshot.v1` / `shzu.ingest.v1` / `shzu.history.v1`），字段名一个不改。

---

## 快速开始

```bash
cd relay

# 演示模式：自带 demo 数据、每 20s 自我演进、预置 24h 历史曲线，不需要采集器
python server.py --demo --port 8080

# 生产模式：等采集器 POST /api/ingest
python server.py --port 8080 --data-dir ./data
```

打开 <http://127.0.0.1:8080/> 就是 App（relay 同时托管 `../app/` 静态文件）。
手机在同一 WiFi 下用 `http://<电脑或平板IP>:8080/` 访问。

演示模式的数据全部来自 `../demo/ingest_sample.json`（合成数据），
响应里恒带 `"demo": true`，UI 也会标「演示数据」——**不会**和真实数据混淆。

### 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `0.0.0.0` | 监听地址（默认让同 WiFi 的手机也能连） |
| `--port` | `8080` | 监听端口 |
| `--data-dir` | `relay/data` | SQLite 存放目录（不存在会自动创建） |
| `--db-name` | `charging.db` | 库文件名 |
| `--demo` | 关 | 演示模式：自动造数据 + 预置历史 |
| `--demo-interval` | `20` | 演示模式演进间隔（秒） |
| `--retain-days` | `30` | 时序点保留天数 |
| `--poll-interval` | `60` | 采集器预期轮询间隔，仅用于 `/api/health` 提示 |
| `--token` | 空 | 若设置，ingest 必须带 `X-Collector-Token`（默认不校验） |
| `--version` | — | 打印版本退出 |

---

## API

所有响应 `Content-Type: application/json; charset=utf-8`，时间一律 ISO8601 带
`+08:00` 偏移。`/api/*` 全部支持 CORS（同源托管时用不到，独立部署 App 时需要）。

### `GET /api/health`

```json
{"ok": true, "version": "relay-1.0.0", "mode": "poll",
 "devices": 236, "free": 175, "busy": 56, "offline": 5, "unknown": 0, "stations": 27,
 "consecutive_failures": 0, "demo": false,
 "data_at": "2026-10-20T00:42:42+08:00",
 "last_ingest_at": "2026-10-20T00:42:42+08:00",
 "last_error": null, "uptime_s": 44}
```

`consecutive_failures` 对应契约 §7「采集器某次请求失败 → 保留上次数值、relay 记录
连续失败次数」，成功后清零。

### `GET /api/snapshot`

契约 §2 的核心对象。**六校区永远 6 项、顺序固定**，某区没数据就是
`totals` 全 0 + `stations: []`，不允许缺项：

```json
{
  "schema": "shzu.snapshot.v1",
  "generated_at": "2026-10-20T00:42:44+08:00",
  "data_at": "2026-10-20T00:42:42+08:00",
  "stale": false,
  "source": {"kind": "poll", "applet": "石河子大学充电桩",
             "collector": "termux-poller@1.0.0", "confidence": 1.0},
  "totals": {"total": 236, "free": 175, "busy": 56, "offline": 5,
             "unknown": 0, "free_ratio": 0.7415},
  "campuses": [
    {"id": "zhongqu", "name": "中区", "order": 1,
     "totals": {"total": 48, "free": 30, "busy": 14, "offline": 4,
                "unknown": 0, "free_ratio": 0.625},
     "stations": [
       {"id": "zhongqu-01", "name": "中区1号充电站（1号宿舍楼旁）",
        "campus_id": "zhongqu", "address": "石河子市北四路 石河子大学中区",
        "lat": 44.3061, "lng": 86.0473,
        "totals": {"total": 12, "free": 8, "busy": 4, "offline": 0,
                   "unknown": 0, "free_ratio": 0.6667},
        "updated_at": "2026-10-20T00:42:42+08:00",
        "devices": [
          {"id": "zhongqu-01-001", "code": "001", "name": "1号桩",
           "status": "free", "power_w": 300,
           "busy_since": null, "order_id": null}
        ]}
     ]}
  ]
}
```

- `free_ratio = free / (total - unknown)`，分母 0 取 `0.0`，保留 4 位小数。
- `totals.total = free + busy + offline + unknown`（每一级都成立：桩 → 站 → 校区 → 全局）。
- `stale = now - data_at > 15 分钟`；还没采集过时 `data_at: null`、`stale: true`。
- `source.confidence` = 这次数据里能判定状态的桩占比 `(total-unknown)/total`，
  表示可信度——**不是随机数**。
- 每次 GET 都会在出口处**结构性重算** totals 链（`refresh_snapshot()`），
  保证即使库里有脏数据，对外也一定是契约合法形态。

#### 多源字段（源 A + 源 B）

两个采集器各自 `POST /api/ingest` 并带 `source_id`（`"shzu"` / `"lvcc"`，缺省
`"default"`）后，relay 按源分区保存，`/api/snapshot` 在**合并后**的六校区视图上
额外给出两个可选字段：

- 站点级 `station.source_id`：这根站/桩是哪个源采的。**旧采集器不带 `source_id`
  时这个键根本不会出现**，老快照形态不变。
- 顶部 `sources[]`：每个源一条，含 `totals` 与 `campuses`：

```json
"sources": [
  {"id": "shzu", "updated_at": "2026-10-20T14:40:31+08:00", "collector": "real_collect.py/1.0",
   "kind": "poll", "stations": 3,
   "totals": {"total": 11, "free": 6, "busy": 3, "offline": 1, "unknown": 1, "free_ratio": 0.6},
   "campuses": [
     {"id": "zhongqu", "name": "中区", "order": 1, "stations": 2,
      "totals": {"total": 7, "free": 3, "busy": 3, "offline": 1, "unknown": 0, "free_ratio": 0.4286}},
     {"id": "beiqu", "name": "北区", "order": 2, "stations": 1,
      "totals": {"total": 4, "free": 3, "busy": 0, "offline": 0, "unknown": 1, "free_ratio": 1.0}}
   ]}
]
```

`campuses` 只列**该源真的采到站点**的校区（没数据的校区不占位，避免前端列出一堆
0 端口），按 `order` 升序；`free_ratio` 一律 `free/(total-unknown)`。两条不变量由
`source_campus_breakdown()` 现算保证：**各校区 totals 之和 == 该源 totals**、
**各校区 stations 之和 == 该源 stations**。

被风控的源（`sources[].throttled`）在合并时**与分校区明细是合并、不是二选一**：
按 `updated_at` 挑最新一份会把正在限流的那个源的提示抹掉，所以两者分开写。

### `POST /api/ingest`

采集器上报**原始设备列表**（不聚合，聚合只在 relay 做一份实现）。请求体见契约 §3。

成功：`{"ok": true, "accepted": 236, "snapshot_at": "...", "data_at": "..."}`
（`accepted` = 收到的桩数量；未归类站点的桩也算 accepted，但不进六校区快照。）

失败一律 4xx + `{"ok": false, "error": "..."}`，**不会 5xx**：
空 body / 非 JSON / 非 UTF-8 / 缺 `schema` / schema 不对 / `stations` 不是数组 /
缺 `collected_at` / 时间格式错 / `Content-Type` 不是 JSON / 超过 8MB。

`raw_status` 按 `shared/campus.json` 的兜底 `status_map` 翻译，ingest 自带的
`status_map` 优先；**翻译不了的落 `unknown`，绝不猜**。

### `GET /api/history?campus=&hours=&bucket=`

契约 §5。`campus` 省略或 `all` = 全校合计；`bucket` 允许
`1m`/`5m`/`10m`/`30m`/`1h`（默认 `10m`），**每桶取桶内均值**（不是末值）：

```json
{"schema": "shzu.history.v1", "campus": "all", "hours": 24, "bucket_seconds": 600,
 "points": [{"t": "2026-10-20T00:40:00+08:00", "free": 171,
             "total": 236, "free_ratio": 0.7246}]}
```

`t` 是桶**起点**，严格升序；`free_ratio = free/total`（history 点不暴露 unknown，
这样 App 用 `free/total` 复算能和 `free_ratio` 完全对上）。
`campus`/`bucket` 非法、`hours` 不在 1~720 → 400。

### `GET /api/config`

给 App 的配置：六校区 `id`/`name`/`order`/`aliases`、`status_map`、`bucket` 列表、
`retain_days`、`poll_interval`、`mode`、`demo`。App 用自己的常量时可以不看它。

### `GET /api/unassigned`

契约 §6.3 的「未归类」虚拟区：站名/地址/`raw_area` 都没命中任何校区 alias 的站点，
单独一个入口给 App 显示，**不混进六校区的图表**：

```json
{"schema": "shzu.unassigned.v1", "campus_id": "_unassigned", "name": "未归类",
 "generated_at": "...", "data_at": "...", "stations": [...]}
```

### `GET /api/sources`

每个数据源最近一次上报的健康状态（多源场景）。`campuses` 与 `/api/snapshot` 的
`sources[].campuses` 用同一个函数生成，两个接口对同一个源给出的数字必然一致：

```json
{"ok": true, "schema": "shzu.sources.v1", "generated_at": "...", "demo": false,
 "sources": [{"source_id": "lvcc", "name": "充充充充电桩-铭创电子",
              "collector": "real_collect.py/1.0", "updated_at": "...", "age_s": 12,
              "stations": 3, "devices": 8, "free": 3, "busy": 4, "offline": 0, "unknown": 1,
              "throttled": true, "blocked_since": "...", "campuses": [ ... ]}]}
```

### `GET /api/events`（SSE，可选）

有新快照时推一条 `event: snapshot`，App 收到就重取 `/api/snapshot`。
连不上也没关系——App 的 60s 定时轮询是主路径，这只是加速。

---

## 稳定 ID（契约 §6）

| 对象 | 格式 | 例子 |
|---|---|---|
| 校区 | `campus.json` 的 `id` | `zhongqu` |
| 站 | `<campus_id>-<两位序号>` | `zhongqu-01` |
| 桩 | `<station_id>-<三位序号>` | `zhongqu-01-003` |

`raw_id → 稳定 id` 的映射固化在 SQLite 的 `meta.id_registry` 里，**重启不重排**
（否则历史曲线断裂）。已固化过的站即使之后归区变化也保持原校区前缀。

归区规则：站名/地址/`raw_area` 命中校区 alias → 该区；跨区命中多个时取
**alias 最长者**（更具体优先）；都没命中 → `_unassigned`。匹配忽略空格/大小写/括号内容。

---

## 数据目录

```
relay/data/                     由 --data-dir 决定
├── charging.db                 SQLite（WAL 模式）
│   ├── meta                    键值：id_registry / unassigned / 失败计数 / 上次采集
│   ├── snapshots               最近 48 份快照（含 demo 标记）
│   ├── points                  时序点（每校区每分钟一行，保留 --retain-days）
│   └── ingest_log              最近 500 次 ingest（成功/失败、来源 IP）
```

`data/` 已在 `.gitignore` 里忽略。删掉整个 `data/` 等于重置（历史曲线和稳定 id 都会重来）。

---

## 运维

```bash
# 后台常驻（Termux / Linux）
nohup python server.py --port 8080 --data-dir ./data > relay.log 2>&1 &

# 探活
curl -s http://127.0.0.1:8080/api/health

# 模拟一次采集器上报（demo fixture 的 collected_at 改成现在）
python -c "import json,time; d=json.load(open('../demo/ingest_sample.json',encoding='utf-8')); d['collected_at']=time.strftime('%Y-%m-%dT%H:%M:%S+08:00'); json.dump(d,open('_p.json','w',encoding='utf-8'),ensure_ascii=False)"
curl -s -X POST http://127.0.0.1:8080/api/ingest \
     -H 'Content-Type: application/json' --data-binary @_p.json
```

降级行为（契约 §7）：relay 挂了 → App 用上次缓存 + `stale` 红条；采集器失败 →
relay 保留上次数值（`data_at` 不变），`/api/health.consecutive_failures` 累加；
缺整个校区 → 该区全 0 不伪造；状态翻译不了 → `unknown` 不猜。

---

## 测试

```bash
cd relay
python -m unittest discover -s tests -v
```

122 个用例，覆盖：六校区顺序/缺区补 0、totals 四级链自洽、`free_ratio` 四位小数与
零分母、六校区 alias 最长优先与未归类、稳定 id 格式与重启不重排、`raw_status`
不猜测、ingest 校验的各种非法形态、history 桶内均值/升序/过滤、SQLite
存取/清理/日志、健康度计数、demo 与 live 快照隔离、HTTP 层（健康/配置/快照/
历史/异常输入/静态托管/路径穿越/CORS/preflight）；多源部分（`source_id` 分区、
合并快照、`/api/sources`、限流提示保留、站点 `source_id`、每源分校区明细）。

契约级验收（项目根的验证器，会自己起 relay 子进程跑全链路）：

```bash
cd ..        # 到项目根
python integration/verify_contract.py --spawn
```

---

## 与契约的出入

实现过程中发现的、契约没写死但必须做个决定的地方，都在代码注释里标了：

1. **ingest 不强制 `Content-Type` 的 charset**：只检查含 `json`，`application/json;
   charset=utf-8` 和 `application/json` 都接受；完全不给 `Content-Type` 也接受
   （有些简陋客户端不给）。给了且明确不是 JSON 才 415。
2. **`accepted` 包含未归类站点的桩**：它表示「这次收到并解析成功多少根桩」，
   而未归类站点只是不进六校区统计。区别在 `/api/unassigned` 和快照 `totals`。
3. **history 的 `free_ratio` 用 `free/total`**：契约 §5 的点结构里没有 `unknown`，
   按 `free/(total-unknown)` 算会让 App 复算对不上。快照仍严格按 §2 的
   `free/(total-unknown)`。
4. **`data_at` 为 `null` 时 `stale=true`**：契约只说「now - data_at > 15 分钟」，
   没采到数据显然应视为过期。
5. **`source.confidence` 的取值**：契约示例给了 `0.95` 但没定义算法。我用
   `(total-unknown)/total`（能判定状态的桩占比），因为这是数据自己携带的真实信息，
   符合「禁止随机数伪造」。
6. **`/api/config` 和 `/api/unassigned` 是契约之外的增量接口**：契约没禁止
   额外接口，两个都是只读、不改契约字段，App 可以不用。
