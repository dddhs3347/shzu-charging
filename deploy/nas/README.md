# 在 NAS 上部署采集端

把「平板一直在跑的那套采集」搬到 NAS 常驻：**NAS 采数据 + 往你自己的域名推**，
手机上的 App / 网页照旧什么都不用配。

```
        ┌──────────────────── NAS（本目录）──────────────────────────┐
        │  relay/server.py  ←  real_collect.py（源A 15s / 源B 300s）  │
        │      │  SQLite 存档 + 局域网网页                            │
        │      └→ publish.py 每 120s 推聚合快照 ──→ api.shzucharge.xyz│
        └────────────────────────────────────────────────────────────┘
                                                  ↓ Cloudflare Worker / KV
                                       手机 App、网页版读同一份数据
```

采集器**只用 Python 标准库 + curl**，没有 pip 依赖，x86 与 ARM 都能跑；
内存约 60 MB，平时 CPU 接近 0，只在每轮采集的几秒里跳一下。

---

## 一、飞牛 OS（fnOS）——按这个走

fnOS 底层是 Debian，Docker 是官方应用，最省事的路线就是 **Docker Compose**。

### 1. 准备

| 要做的事 | 在哪做 |
|---|---|
| 装 Docker | fnOS「应用中心」搜 **Docker** 安装（大多数版本自带） |
| 开 SSH（可选，但强烈建议） | 「设置 → 远程访问 → SSH」打开 |
| 确认能上外网 | fnOS 里能正常访问网页/更新即可；采集要连 `charge.shzu.edu.cn`、`appapi.lvcchong.com` |
| 采集口令 | 32 位，仓库里 `cloudflare/out/collector_token.txt`，或找部署方要 |

### 2. 把代码放到 NAS

**推荐：SSH 直接 clone**（fnOS 的 Git 一般能连 GitHub）

```bash
# 从电脑 SSH 进 NAS（用户名 root，密码是你 fnOS 管理员密码）
ssh root@<NAS 的 IP>

# 选一个数据盘上的目录（fnOS 的存储一般在 /vol1、/vol2…）
mkdir -p /vol1/docker && cd /vol1/docker
git clone https://github.com/dddhs3347/shzu-charging.git
cd shzu-charging
```

> 不确定路径就 `ls /vol1` 看一眼；fnOS 每个存储池一个 `/volN`，
> 也可以先在「文件」应用里建好 `docker/shzu-charging` 文件夹，再 SSH 里找它。

**连不上 GitHub 的话**：在电脑上把仓库打包成 zip → fnOS「文件」应用上传 →
用「压缩包解压」解到 `/vol1/docker/shzu-charging`。

### 3. 填口令

```bash
cd /vol1/docker/shzu-charging
cp .env.nas.example .env.nas
vi .env.nas        # 把 SHZU_CLOUD_TOKEN 改成你的 32 位口令
```

### 4. 启动

**方式 A：命令行（最稳，推荐）**

```bash
cd /vol1/docker/shzu-charging
docker compose -f docker-compose.nas.yml up -d --build
docker compose -f docker-compose.nas.yml logs -f
```

看到下面三行就成了：

```
[nas] relay 就绪：http://<NAS IP>:8080
[nas] 云发布：https://api.shzucharge.xyz 每 120s 一次
[..] ✓ 发布循环已在后台启动（pid=…，每 120s 一拍）
```

**方式 B：fnOS 图形界面**

1. 打开 **Docker → 项目 → 新建项目**；
2. 项目名称 `shzu-charging`，**项目路径选仓库根目录**（`/vol1/docker/shzu-charging`）；
3. 编排文件填 `docker-compose.nas.yml`（这个文件就在仓库根，专为图形界面准备的）；
4. 先在「文件」应用里把 `.env.nas` 建好（内容同第 3 步），再点「创建/构建」；
5. 之后在「项目 → shzu-charging」里能看状态，点日志图标看实时输出，也能一键重启。

> fnOS 拉 `python:3.12-slim` 慢的话，先去「Docker → 镜像」搜 `python` 拉 `3.12-slim`，
> 再回来构建就会走本地缓存。

### 5. 验证（三步，从近到远）

```bash
# ① NAS 本机 relay 活着（有端口数、有采集时间）
curl -s http://127.0.0.1:8080/api/health

# ② 云端数据是新的（age_seconds < 150，last_push_at 一直在前进）
curl -s https://api.shzucharge.xyz/health

# ③ 手机 App / 网页刷新一次，底部「采集 xx:xx」应该是几分钟内
```

`/api/health` 里重点看 `total` / `free`（端口数）、`last_ingest`；
云端 `/health` 里重点看 `age_seconds`、`kv_budget`（当天 KV 写次数，别贴着 930）。

---

## 二、其他 NAS（步骤同理）

- **群晖 DSM 7.x**：Container Manager → 项目 → 新增 → 路径选仓库根 → 使用已有的
  `docker-compose.yml`（把仓库根的 `docker-compose.nas.yml` 改名为 `docker-compose.yml` 即可）。
- **威联通 QTS**：Container Station → 应用程序 → 创建 → Docker Compose，粘贴
  `deploy/nas/docker-compose.yml`（注意 `context` 与卷路径按实际目录改）。
- **绿联 / 极空间 / TrueNAS**：Compose 项目指向仓库根 + `docker-compose.nas.yml`。
- **任何 Linux（含 fnOS 不用 Docker）**：见下面第三节。

---

## 三、不用 Docker（Debian 系 / fnOS 裸机）

要求：`python3`（3.9+）、`curl`、`bash`。

```bash
cd /vol1/docker/shzu-charging

# fnOS / Debian / Ubuntu
apt install -y python3 curl

# 前台试跑一次（看到「发布循环已在后台启动」后 Ctrl+C）
SHZU_CLOUD=https://api.shzucharge.xyz \
SHZU_CLOUD_TOKEN=你的口令 \
SHZU_CLOUD_MIN_INTERVAL=120 \
bash deploy/nas/run.sh

# 交给 systemd 常驻（fnOS 是 Debian，systemd 可用）
echo 'SHZU_CLOUD_TOKEN=你的口令' > /etc/shzu-charging.env && chmod 600 /etc/shzu-charging.env
cp deploy/nas/systemd/shzu-charging.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now shzu-charging
journalctl -u shzu-charging -f
```

> service 文件里的 `User=shzu`、`WorkingDirectory=/opt/shzu-charging` 要改成你的实际用户和路径
> （fnOS 上直接用 `User=root` + `/vol1/docker/shzu-charging` 也行）。

---

## 四、从平板迁移过来（重要）

1. **先停平板上的发布**，否则两边交替覆盖云端快照，`last_push_at` 会来回跳，看起来像「数据时新时旧」：
   ```bash
   adb -s <平板序列号> shell "su -c 'bash /data/data/com.termux/files/home/charging/deploy/stop_all.sh'"
   ```
2. NAS 起来、`age_seconds` 正常前进后，平板就可以长期关机了。
3. 想保留历史曲线：把平板的 `~/charging/relay/data/charging.db` 拷到 NAS 的
   `deploy/nas/data/charging.db`（SQLite 单文件直接覆盖，属主改成容器用户即可）。

---

## 五、参数速查

改远端 compose 的 `environment:`（或 `.env.nas` 里取消注释）：

| 变量 | 默认 | 含义 |
|---|---|---|
| `SHZU_CLOUD` | `https://api.shzucharge.xyz` | 云中转地址；留空则退回 ntfy 公共频道（有每日配额） |
| `SHZU_CLOUD_TOKEN` | 无 | 32 位采集口令，**必填** |
| `SHZU_CLOUD_MIN_INTERVAL` | `120` | 往云端推一次的间隔（秒）；App 里「x 分钟前」就是它 |
| `SHZU_INTERVAL` | `15` | 源 A（官方小程序）采集间隔 |
| `SHZU_WORKERS` | `16` | 源 A 并发数；ARM 双核这种弱 NAS 建议 `6` |
| `LVCC_INTERVAL` | `300` | 源 B（充充充/铭创）采集间隔，被官方风控，别小于 180 |
| `COLLECT_SOURCE` | `both` | `shzu` / `lvcc` / `both`；只要官方源就填 `shzu` |
| `RELAY_PORT` | `8080` | 局域网 relay 端口（被占用就改，同时改 ports 映射） |
| `RELAY_RETAIN_DAYS` | `30` | SQLite 历史保留天数 |

节奏别乱改小：云端免费 KV 只有 1000 写/天，推太勤会被 Worker 的预算保护压回去。

---

## 六、升级

```bash
cd /vol1/docker/shzu-charging
git pull                        # 或重新解压新包覆盖
docker compose -f docker-compose.nas.yml up -d --build
```

无 Docker：覆盖文件后 `systemctl restart shzu-charging`。

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 日志 `403` / `口令不对` | `.env.nas` 里 `SHZU_CLOUD_TOKEN` 错或为空 |
| 日志 `找不到 curl` | Docker 镜像已自带；裸机路线要 `apt install curl` |
| 日志 `找不到 python3` | 装 python3，或设 `SHZU_PY=/usr/bin/python3` |
| `age_seconds` 一直涨、端口数变 0 | NAS 出不了网或被运营商拦；先 `curl -I https://charge.shzu.edu.cn` |
| 源 B 一直 0 端口 | 正常，铭创有风控会拦；源 A 不受影响，稍后自动恢复 |
| `http://NAS:8080` 打不开 | 检查 8080 是否被 fnOS 自身占用、防火墙；只推云端本来就不用管 |
| 容器起来又立刻退出 | `docker compose logs` 看第一行报错，多半是缺少 `.env.nas` 或口令为空 |
| 磁盘变满 | 日志已限 10 MB×3；`deploy/nas/sniffer-out/` 可随时清空；SQLite 按 `RELAY_RETAIN_DAYS` 自动清理 |
| NAS 休眠后不采集 | Docker 容器会阻止休眠；fnOS 的硬盘休眠策略里把 Docker 数据盘排除 |
| 想换端口 8080 | 同时改 `RELAY_PORT` 与 ports 映射（如 `"18080:18080"`） |

---

## 八、文件说明

| 文件 | 作用 |
|---|---|
| `deploy/nas/run.sh` | 守护脚本：起 relay → 等 `/api/health` → 起采集+发布循环；谁挂了整组退出交给外层重启 |
| `deploy/nas/Dockerfile` | 镜像定义（python3.12 + curl + tzdata），构建上下文是仓库根目录 |
| `docker-compose.nas.yml` | 仓库根的一键编排（fnOS/群晖图形界面直接选它） |
| `deploy/nas/docker-compose.yml` | 结构相同，但放在子目录里（适合在 `deploy/nas` 里直接 compose） |
| `.env.nas.example` | 口令模板，复制成 `.env.nas` |
| `deploy/nas/systemd/shzu-charging.service` | 无 Docker 路线用的服务单元 |

底层逻辑和飞牛/群晖上的 `deploy/nas/run.sh` 是**同一份**（自包含：relay + 源A 循环 + 源B 后台循环 +
独立发布定时器 + flock 单实例），不依赖 `deploy/publish_loop.sh` 那套平板脚本，
所以公开仓库里没有 `deploy/` 目录也能直接跑。