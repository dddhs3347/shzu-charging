#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""石大充电桩 —— 本地一键启动（自部署用）。

做三件事：
  1. 起 relay（`relay/server.py`）：局域网 HTTP 服务 + SQLite 存档 + 静态托管 `app/`
  2. 起采集循环（`sniffer/real_collect.py`）：轮询学校接口，POST 给 relay
     - 源 A `charge.shzu.edu.cn`（石河子大学充电桩）：默认 15 秒一轮
     - 源 B `appapi.lvcchong.com`（充充充充电桩-铭创电子）：默认 300 秒一轮
       （官方风控，刷太快会被拦，慢一点反而稳定）
  3. 打印「手机该打开的地址」，手机连同一个 Wi-Fi 直接访问

只用 Python 标准库，不需要 pip install 任何东西。

用法：
    python start.py                    # 默认 0.0.0.0:8080
    python start.py --port 9000        # 换端口
    python start.py --shzu-interval 10 --lvcc-interval 600
    python start.py --no-lvcc          # 只采石大源（校外网络下铭创多半够不着）

按 Ctrl+C 退出，会把 relay 一起收掉。
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(HERE, "relay", "server.py")
COLLECT = os.path.join(HERE, "sniffer", "real_collect.py")
DATA_DIR = os.path.join(HERE, "relay", "data")
OUT_DIR = os.path.join(HERE, "sniffer", "out")

STOP = threading.Event()


def _py(args):
    """拼一个「用当前解释器跑某个脚本」的命令行（Windows 上同样适用）。"""
    return [sys.executable, "-X", "utf8"] + args


def lan_ips():
    """尽量把本机所有可能的局域网 IPv4 都列出来（不止默认出口那块网卡）。"""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.2)
        # 不会真的发包，只是让系统选一张出网网卡，从而拿到它自己的地址
        s.connect(("223.5.5.5", 53))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def wait_health(port, timeout=20.0):
    """等 relay 的 /api/health 能应答（起来之前不要先跑采集，否则第一批数据白丢）。"""
    url = "http://127.0.0.1:%d/api/health" % port
    deadline = time.time() + timeout
    while time.time() < deadline:
        if STOP.is_set():
            return False
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.4)
    return False


def ingest_counts(path):
    """读采集器落盘的 ingest JSON，返回 (站点数, 端口数)；读不到返回 None。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:                                          # noqa: BLE001
        return None
    stations = data.get("stations") or []
    devices = 0
    for st in stations:
        try:
            devices += len(st.get("devices") or [])
        except Exception:                                      # noqa: BLE001
            continue
    return len(stations), devices


def collect_once(source, port, workers):
    """跑一轮采集。失败只记日志，不退出循环 —— 断网 30 秒不该让整个服务挂掉。"""
    out = os.path.join(OUT_DIR, "ingest_%s.json" % source)
    cmd = _py([COLLECT, "--source", source, "--workers", str(workers),
               "--post", "http://127.0.0.1:%d" % port, "--out", out, "--quiet"])
    started = time.time()
    try:
        p = subprocess.run(cmd, cwd=HERE, timeout=180,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        took = time.time() - started
        text = (p.stdout or b"").decode("utf-8", "replace").strip()
        if p.returncode == 0:
            tail = text.splitlines()[-1][:120] if text else "ok"
            got = ingest_counts(out)
            if got is not None and got[1] == 0:
                # 采集器本身没报错，但一条端口都没拿到：最常见的原因是这台电脑
                # 不在校园网里（学校接口只对校内网开放），或者是接口临时抽风。
                if source == "shzu":
                    print("  [%s] 本次 0 个端口 —— 多半不在校园网内，"
                          "或学校接口临时不可用（%.1fs）" % (source, took), flush=True)
                else:
                    print("  [%s] 本次 0 个端口 —— 可能被官方风控挡住了，"
                          "隔几分钟会自动重试（%.1fs）" % (source, took), flush=True)
            elif got is not None:
                print("  [%s] 采集成功 %.1fs  %d 个站 / %d 个端口  %s"
                      % (source, took, got[0], got[1], tail), flush=True)
            else:
                print("  [%s] 采集成功 %.1fs  %s" % (source, took, tail), flush=True)
        else:
            print("  [%s] 采集失败（退出码 %d，%.1fs）" % (source, p.returncode, took), flush=True)
            for line in (text or "").splitlines()[-3:]:
                print("        " + line[:160], flush=True)
    except subprocess.TimeoutExpired:
        print("  [%s] 采集超时（>180s），跳过这一轮" % source, flush=True)
    except Exception as e:                                    # noqa: BLE001
        print("  [%s] 采集异常：%s" % (source, e), flush=True)


def collect_loop(source, interval, port, workers):
    # 源 B 先等 3 秒再跑，避免两份采集同时打满出口带宽
    if source == "lvcc":
        STOP.wait(3.0)
    while not STOP.is_set():
        try:
            collect_once(source, port, workers)
        except Exception as e:                                # noqa: BLE001
            print("  [%s] 循环异常：%s" % (source, e), flush=True)
        STOP.wait(interval)


def main():
    ap = argparse.ArgumentParser(description="石大充电桩 本地一键启动（relay + 采集循环）")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0（局域网可访问）")
    ap.add_argument("--port", type=int, default=8080, help="监听端口，默认 8080")
    ap.add_argument("--shzu-interval", type=int, default=15,
                    help="石大源（charge.shzu.edu.cn）采集间隔秒数，默认 15")
    ap.add_argument("--lvcc-interval", type=int, default=300,
                    help="铭创源（appapi.lvcchong.com）采集间隔秒数，默认 300（官方风控，别调太小）")
    ap.add_argument("--workers", type=int, default=16, help="石大源逐台详情的并发数，默认 16")
    ap.add_argument("--no-lvcc", action="store_true", help="不采铭创源（校外网络常被风控）")
    args = ap.parse_args()

    if sys.version_info < (3, 8):
        print("需要 Python 3.8 或更高版本，当前是 %s" % sys.version.split()[0])
        return 1
    for need in (RELAY, COLLECT, os.path.join(HERE, "app", "index.html")):
        if not os.path.exists(need):
            print("缺少文件：%s（请在仓库根目录运行本脚本）" % need)
            return 1

    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)

    print("=" * 66)
    print(" 石大充电桩 —— 本地服务")
    print("=" * 66)
    print(" 正在启动 relay（%s:%d）…" % (args.host, args.port), flush=True)

    relay_cmd = _py([RELAY, "--host", args.host, "--port", str(args.port),
                     "--data-dir", DATA_DIR,
                     "--poll-interval", str(args.shzu_interval)])
    relay = subprocess.Popen(relay_cmd, cwd=HERE)

    try:
        if not wait_health(args.port):
            print(" relay 没起来（端口被占用？看看上面的报错）")
            return 1

        print(" relay 就绪。")
        print()
        print(" 手机连同一个 Wi-Fi，浏览器打开下面任意一个：")
        for ip in lan_ips():
            print("     http://%s:%d" % (ip, args.port))
        if not lan_ips():
            print("     （没检测到局域网 IP，用 ipconfig 看一下本机地址，拼上 :%d）" % args.port)
        print(" 本机自测： http://127.0.0.1:%d" % args.port)
        print()
        print(" 采集节奏：石大源每 %ds，铭创源%s" % (
            args.shzu_interval,
            "不采（--no-lvcc）" if args.no_lvcc else "每 %ds" % args.lvcc_interval))
        print(" 提示：石大源要在校园网内才拿得到数据；铭创源出校外可能被风控。")
        print(" 按 Ctrl+C 退出（会一起停掉 relay）")
        print("-" * 66)

        threads = [threading.Thread(target=collect_loop,
                                    args=("shzu", args.shzu_interval, args.port, args.workers),
                                    daemon=True)]
        if not args.no_lvcc:
            threads.append(threading.Thread(target=collect_loop,
                                            args=("lvcc", args.lvcc_interval, args.port, args.workers),
                                            daemon=True))
        for t in threads:
            t.start()

        while True:
            time.sleep(1.0)
            if relay.poll() is not None:
                print("\n relay 进程已退出（退出码 %s），一并停止。" % relay.returncode)
                return 1
    except KeyboardInterrupt:
        print("\n 收到 Ctrl+C，正在停止…")
        return 0
    finally:
        STOP.set()
        if relay.poll() is None:
            relay.terminate()
            try:
                relay.wait(timeout=5)
            except subprocess.TimeoutExpired:
                relay.kill()
        print(" 已停止。")


if __name__ == "__main__":
    sys.exit(main())