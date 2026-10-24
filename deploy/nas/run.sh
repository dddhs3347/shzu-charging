#!/usr/bin/env bash
# 石大充电桩 · NAS 采集端守护脚本（自包含，不依赖 deploy/ 里的平板脚本）
#
# 一个进程管四件事，节奏各自独立：
#   relay        常驻，接收采集结果、维护 SQLite 存档、给局域网手机提供网页
#   源 A 循环    每 SHZU_INTERVAL 秒（默认 15）采官方小程序，并发 SHZU_WORKERS 路
#   源 B 循环    每 LVCC_INTERVAL 秒（默认 300）采充充充/铭创（有风控，必须慢）
#   发布循环     独立定时器，每 SHZU_CLOUD_MIN_INTERVAL 秒（默认 120）推一份聚合快照到云端
#
# 三个循环为什么必须分开（都是踩过的坑）：
#   · 发布若跟在采集后面串行，「发布周期 = 采集耗时 + sleep」→ 实测云端间隔 78 秒，
#     而读者要的是一分钟级别的新鲜度。拆成独立定时器才对得上节奏。
#   · 源 B 一轮要 80 秒左右，串在主循环里会把源 A 的 15 秒节奏拖垮，
#     所以源 B 放后台单独跑。
#   · 发布定时器的周期必须**大于** publish.py 自己的最小间隔阈值（这里取
#     周期 - 15 秒），否则会「每两拍只发一拍」——线上实测就是这么变成 120 秒的。
#
# 用法：
#   bash deploy/nas/run.sh                 # 前台跑（Ctrl+C 全部退出）
#   环境变量见 deploy/nas/README.md 与 .env.nas.example
set -u

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF_DIR/../.." && pwd)

# ---------------------------------------------------------------- 配置
RELAY_PORT="${RELAY_PORT:-8080}"
RELAY_DATA_DIR="${RELAY_DATA_DIR:-$ROOT/relay/data}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
RELAY_RETAIN_DAYS="${RELAY_RETAIN_DAYS:-30}"

COLLECT_SOURCE="${COLLECT_SOURCE:-both}"          # shzu | lvcc | both
SHZU_INTERVAL="${SHZU_INTERVAL:-15}"
SHZU_WORKERS="${SHZU_WORKERS:-16}"
LVCC_INTERVAL="${LVCC_INTERVAL:-300}"

PUBLISH_CLOUD="${SHZU_CLOUD:-}"
CLOUD_TOKEN="${SHZU_CLOUD_TOKEN:-}"
CLOUD_MIN_INTERVAL="${SHZU_CLOUD_MIN_INTERVAL:-120}"
CLOUD_PUBLISH_GUARD=15
# ntfy 兜底（没有配 SHZU_CLOUD 时才会用到）：免费版每出口 IP 每天 250 条，
# 所以默认 7 分钟一条、140 条/天封顶。
NTFY_BASE="${SHZU_NTFY:-https://ntfy.sh}"
PUBLISH_TOPIC="${SHZU_TOPIC:-}"
PUBLISH_MIN_INTERVAL="${SHZU_PUBLISH_MIN_INTERVAL:-420}"
PUBLISH_HEARTBEAT="${SHZU_PUBLISH_HEARTBEAT:-1800}"
PUBLISH_DAILY_BUDGET="${SHZU_PUBLISH_DAILY_BUDGET:-140}"

mkdir -p "$LOG_DIR" "$RELAY_DATA_DIR" "$(dirname "$RELAY_DATA_DIR")/../sniffer/out" 2>/dev/null || true
mkdir -p "$ROOT/sniffer/out" 2>/dev/null || true

# ---------------------------------------------------------------- 日志
say()  { printf '[%s] %s\n'  "$(date '+%H:%M:%S')" "$*"; }
dim()  { printf '[%s]   %s\n' "$(date '+%H:%M:%S')" "$*"; }
ok()   { printf '[%s] ✓ %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '[%s] ! %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
err()  { printf '[%s] ✗ %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }

# ---------------------------------------------------------------- 单实例锁
# 两个采集进程同时往 relay 灌数据、同时往云端推，会让 last_push_at 来回跳，
# 用户看到的是「数据时新时旧」。所以整个容器只允许一份。
LOCK_FILE="${TMPDIR:-/tmp}/shzu-nas.lock"
exec 9>"$LOCK_FILE"
if ! command -v flock >/dev/null 2>&1; then
    warn "没有 flock，跳过单实例检查（Docker 里一般都有）"
elif ! flock -n 9; then
    err "已有实例在跑（锁 $LOCK_FILE），本进程退出"
    exit 0
fi

# ---------------------------------------------------------------- Python
resolve_python() {
    local cand
    for cand in "${SHZU_PY:-}" python python3; do
        [ -n "$cand" ] || continue
        if command -v "$cand" >/dev/null 2>&1; then
            printf '%s\n' "$cand"
            return 0
        fi
    done
    return 1
}
PY_BIN="$(resolve_python)" || { err "找不到 python/python3，装一个或设置 SHZU_PY 指过去"; exit 2; }
command -v curl >/dev/null 2>&1 || err "找不到 curl（采集器依赖它发 HTTPS 请求，Debian 上 apt install curl）"

CLOUD_PUBLISH_MIN=$(( CLOUD_MIN_INTERVAL - CLOUD_PUBLISH_GUARD ))
[ "$CLOUD_PUBLISH_MIN" -lt 5 ] && CLOUD_PUBLISH_MIN=5

INGEST_SHZU="$ROOT/sniffer/out/ingest_shzu.json"
INGEST_LVCC="$ROOT/sniffer/out/ingest_lvcc.json"
INGEST_BOTH="$ROOT/sniffer/out/ingest_real.json"

RELAY_PID=""
LVCC_PID=""
PUB_PID=""

cleanup() {
    trap - INT TERM EXIT
    say "收到停止信号，收尾中…"
    for pid in "$PUB_PID" "$LVCC_PID" "$RELAY_PID"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null
    done
    wait 2>/dev/null
    exit 0
}
trap cleanup INT TERM EXIT

# ---------------------------------------------------------------- relay
start_relay() {
    if [ -n "$RELAY_PID" ] && kill -0 "$RELAY_PID" 2>/dev/null; then return 0; fi
    say "启动 relay（端口 $RELAY_PORT，数据 $RELAY_DATA_DIR）…"
    "$PY_BIN" "$ROOT/relay/server.py" \
        --port "$RELAY_PORT" \
        --data-dir "$RELAY_DATA_DIR" \
        --retain-days "$RELAY_RETAIN_DAYS" \
        9>&- >>"$LOG_DIR/relay.log" 2>&1 &
    RELAY_PID=$!
    local i
    for i in $(seq 1 60); do
        if curl -fsS --max-time 2 "http://127.0.0.1:$RELAY_PORT/api/health" >/dev/null 2>&1; then
            ok "relay 就绪：http://<NAS 的 IP>:$RELAY_PORT"
            return 0
        fi
        kill -0 "$RELAY_PID" 2>/dev/null || { err "relay 启动后立刻退出，看 $LOG_DIR/relay.log"; exit 1; }
        sleep 1
    done
    err "relay 60 秒内没就绪，看 $LOG_DIR/relay.log"
    exit 1
}

# ---------------------------------------------------------------- 采集
collect_source() {
    local which="$1" src out t0 rc
    t0=$(date +%s)
    case "$which" in
        shzu) src="shzu"; out="$INGEST_SHZU" ;;
        lvcc) src="lvcc"; out="$INGEST_LVCC" ;;
        *)    src="both"; out="$INGEST_BOTH" ;;
    esac
    say "采集源 $src …"
    cd "$ROOT/sniffer" || return 1
    # --out 每个源一份文件：共用一个文件时，后一轮会把前一轮整个覆盖掉
    "$PY_BIN" real_collect.py \
        --source "$src" \
        --out "$out" \
        --post "http://127.0.0.1:$RELAY_PORT" \
        --workers "$SHZU_WORKERS" \
        --quiet 9>&-
    rc=$?
    if [ "$rc" -ne 0 ]; then
        err "采集源 $src 失败（exit=$rc），relay 里保留上一轮数据"
        return 1
    fi
    dim "源 $src 采集+入库耗时 $(( $(date +%s) - t0 )) 秒"
    return 0
}

# ---------------------------------------------------------------- 发布
# 返回 0 = 成功或被节流跳过（都是预期行为），1 = 真失败
publish_once() {
    local rc out
    local -a cloud_args
    if [ -n "$PUBLISH_CLOUD" ]; then
        if [ -z "$CLOUD_TOKEN" ]; then
            err "配了 SHZU_CLOUD 却没有 SHZU_CLOUD_TOKEN —— Worker 会返回 403"
            return 1
        fi
        cloud_args=(--cloud "$PUBLISH_CLOUD" --cloud-token "$CLOUD_TOKEN"
                    --cloud-min-interval "$CLOUD_PUBLISH_MIN"
                    --heartbeat "$CLOUD_PUBLISH_MIN")
        say "发布到 $PUBLISH_CLOUD …"
    else
        [ -n "$PUBLISH_TOPIC" ] || { warn "既没配 SHZU_CLOUD 也没配 SHZU_TOPIC，跳过发布"; return 0; }
        cloud_args=()
        say "发布到公共频道 $PUBLISH_TOPIC …"
    fi
    cd "$ROOT/sniffer" || return 1
    out=$("$PY_BIN" publish.py \
        --relay "http://127.0.0.1:$RELAY_PORT" \
        --topic "$PUBLISH_TOPIC" \
        --ntfy "$NTFY_BASE" \
        --min-interval "$PUBLISH_MIN_INTERVAL" \
        --heartbeat "$PUBLISH_HEARTBEAT" \
        --daily-budget "$PUBLISH_DAILY_BUDGET" \
        "${cloud_args[@]}" \
        --quiet 2>&1 9>&-)
    rc=$?
    [ -n "$out" ] && printf '%s\n' "$out"
    case "$rc" in
        0) return 0 ;;
        3) say "配额退避中，本轮不发（采集照常，下一轮自动重试）"; return 0 ;;
        2) err "拒绝发布：relay 快照里 0 个端口（数据源可能挂了，看 $LOG_DIR/relay.log）"; return 1 ;;
        *) err "发布失败（exit=$rc）"; return 1 ;;
    esac
}

# ---------------------------------------------------------------- 三个循环
lvcc_loop() {
    while :; do
        collect_source lvcc
        sleep "$LVCC_INTERVAL"
    done
}

publish_loop() {
    local next_ts now left
    next_ts=$(date +%s)
    while :; do
        now=$(date +%s)
        left=$(( next_ts - now ))
        [ "$left" -gt 0 ] && sleep "$left"
        publish_once
        # 按键拍绝对对齐，避免「publish 自己耗 1~3 秒」累积漂移
        next_ts=$(( next_ts + CLOUD_MIN_INTERVAL ))
        now=$(date +%s)
        if [ "$next_ts" -le "$now" ]; then
            warn "发布耗时超过 ${CLOUD_MIN_INTERVAL}s，节奏按实际耗时顺延"
            next_ts=$(( now + 1 ))
        fi
    done
}

start_lvcc_loop() {
    case "$COLLECT_SOURCE" in
        lvcc|both) ;;
        *) return 0 ;;
    esac
    [ -n "$LVCC_PID" ] && kill -0 "$LVCC_PID" 2>/dev/null && return 0
    # 9>&- 关掉继承的 flock 锁 fd：否则这个后台循环会替主进程持锁，
    # 主进程死掉后锁不释放，新实例永远起不来。
    lvcc_loop 9>&- &
    LVCC_PID=$!
    ok "源 B 采集循环已在后台启动（pid=$LVCC_PID，每 ${LVCC_INTERVAL}s 一轮）"
}

start_publish_loop() {
    [ -n "$PUB_PID" ] && kill -0 "$PUB_PID" 2>/dev/null && return 0
    [ -n "$PUB_PID" ] && warn "发布循环 pid=$PUB_PID 已不在，重新拉起"
    publish_loop 9>&- &
    PUB_PID=$!
    ok "发布循环已在后台启动（pid=$PUB_PID，每 ${CLOUD_MIN_INTERVAL}s 一拍）"
}

# ---------------------------------------------------------------- main
echo
echo "=============================================="
echo " 石大充电桩 · NAS 采集端"
echo "   relay    : http://<NAS 的 IP>:$RELAY_PORT"
echo "   源 A     : 每 ${SHZU_INTERVAL}s（并发 $SHZU_WORKERS 路）"
echo "   源 B     : 每 ${LVCC_INTERVAL}s"
if [ -n "$PUBLISH_CLOUD" ]; then
    echo "   云端     : $PUBLISH_CLOUD 每 ${CLOUD_MIN_INTERVAL}s 一更"
else
    echo "   云端     : 未配置 SHZU_CLOUD（只发 ntfy 公共频道，有每日配额）"
fi
echo "   采集范围 : $COLLECT_SOURCE"
echo "   日志目录 : $LOG_DIR"
echo "=============================================="
echo

start_relay

A_FAILS=0
while :; do
    # relay 挂了就整组退出，交给 Docker/systemd 重启，别在这里半死不活
    if ! kill -0 "$RELAY_PID" 2>/dev/null; then
        err "relay 进程不在了，退出让容器重启（看 $LOG_DIR/relay.log）"
        exit 1
    fi
    start_lvcc_loop
    start_publish_loop

    case "$COLLECT_SOURCE" in
        lvcc) ;;                       # 只采源 B，主循环不碰源 A
        *) collect_source shzu || A_FAILS=$(( A_FAILS + 1 )) ;;
    esac

    if [ "$A_FAILS" -ge 3 ]; then
        BACKOFF=$(( SHZU_INTERVAL * A_FAILS ))
        [ "$BACKOFF" -gt 900 ] && BACKOFF=900
        warn "源 A 连续失败 $A_FAILS 次，退避 ${BACKOFF}s 后重试"
        A_FAILS=0
        sleep "$BACKOFF"
        continue
    fi
    sleep "$SHZU_INTERVAL"
done