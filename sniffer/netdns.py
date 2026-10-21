#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""系统 DNS 不可用时的兜底解析器（纯标准库，零依赖）。

背景（在小米平板 + KernelSU + Termux 上实测出来的真问题）：
    Android 的 DNS 解析不是走 /etc/resolv.conf，而是走 netd 的
    /dev/socket/dnsproxyd。从 root 派生出来的进程（su -c、/data/adb/service.d
    开机脚本）SELinux 域是 u:r:ksu:s0，**连不上 dnsproxyd**，于是：
        - curl 直接报 http=000（"Could not resolve host"）
        - Python urllib 报 [Errno 7] No address associated with hostname
    但同一进程的 TCP/UDP 出网是完全正常的 —— 实测直接向 223.5.5.5 发
    UDP DNS 查询，0.00s 就拿到正确 IP；拿到 IP 后 curl --resolve 立刻 200。

所以这里自己实现一个最小的 DNS A 记录查询器，解析出的 IP 通过
curl 的 --resolve 参数注入，绕开系统解析器。正常环境下永远走不到这条路径
（首次请求成功就不会兜底），所以对 Windows / 手机热点 等场景零影响。

补充（2026-10-20 下午实测）：**UDP 53 也可能被劫持**。家里路由器对全新域名
（如 api.shzucharge.xyz）直接返回 127.0.0.1，四个公共 DNS 的 UDP 查询全部
拿到这个假地址。所以 UDP 之后还要有 DoH 兜底（见 DOH_ENDPOINTS），且 DoH
服务器的 IP 也钉死，整条链路不依赖系统 DNS 一步。
"""

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import time

# 公共 DNS 候选，按国内可达性排序。新疆电信出口实测五个全部可用。
DNS_SERVERS = ["223.5.5.5", "119.29.29.29", "114.114.114.114", "8.8.8.8"]
DNS_TIMEOUT = 4.0
CACHE_TTL = 300.0  # 秒；进程内缓存，避免每台设备都解析一次

# DoH 端点：**先用 curl --resolve 把 DoH 服务器自己的 IP 钉死**，
# 这样连解析 DoH 域名这一步都不需要系统 DNS。
#
# 为什么需要这一层（2026-10-20 在平板实测出来的真问题）：
#   家里路由器 + 新疆电信对**全新域名**做 NXDOMAIN 劫持，直接返回 127.0.0.1。
#   于是 api.shzucharge.xyz 在平板上：
#     - 系统解析器 → 127.0.0.1（连的是本机 443，立刻 "Could not connect"）
#     - netdns 原来的 UDP 53 查询 → 也被劫持成 127.0.0.1
#     - 腾讯 DoH（doh.pub）→ 正常返回 104.21.81.202 / 172.67.164.7
#   所以 UDP 这条路在劫持网络里也是不可信的，必须再用 DoH 复核。
#   端点用 (域名, 钉死IP, 路径) 三元组；阿里 /resolve，腾讯和 Google 是 /dns-query。
DOH_ENDPOINTS = [
    ("doh.pub", "1.12.12.12", "/dns-query"),
    ("dns.alidns.com", "223.5.5.5", "/resolve"),
    ("dns.google", "8.8.8.8", "/dns-query"),
]
DOH_TIMEOUT = 8.0
# 劫持响应的典型值：回环、未指定、链路本地。这些一律当"解析失败"。
BAD_PREFIXES = ("127.", "0.", "169.254.", "255.")

_cache = {}  # host -> (ips, expire_at)


# ---------------------------------------------------------------- DNS 报文
def _build_query(name, qid):
    hdr = struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    q = b""
    for part in name.split("."):
        if not part:
            continue
        raw = part.encode("ascii", "replace")
        if len(raw) > 63:
            raise ValueError("域名标签过长: %s" % part)
        q += bytes([len(raw)]) + raw
    q += b"\x00"
    q += struct.pack(">HH", 1, 1)  # QTYPE=A, QCLASS=IN
    return hdr + q


def _skip_name(data, off):
    total = len(data)
    while off < total:
        ln = data[off]
        if ln == 0:
            return off + 1
        if (ln & 0xC0) == 0xC0:  # 压缩指针
            return off + 2
        off += 1 + ln
    return off


def _parse_a(data, qid):
    if len(data) < 12:
        return None
    rid, _flags, qd, an, _ns, _ar = struct.unpack(">HHHHHH", data[:12])
    if rid != qid:
        return None
    off = 12
    for _ in range(qd):
        off = _skip_name(data, off) + 4
    out = []
    for _ in range(an):
        off = _skip_name(data, off)
        if off + 10 > len(data):
            break
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[off:off + 10])
        off += 10
        rd = data[off:off + rdlen]
        off += rdlen
        if rtype == 1 and rdlen == 4:
            out.append(".".join(str(b) for b in rd))
    return out or None


def _query_one(server, name):
    qid = int(time.time() * 1000) & 0xFFFF
    pkt = _build_query(name, qid)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(DNS_TIMEOUT)
    try:
        s.sendto(pkt, (server, 53))
        data, _ = s.recvfrom(2048)
    finally:
        s.close()
    return _parse_a(data, qid)


# ---------------------------------------------------------------- DoH 兜底
def is_bogus(ip):
    """劫持响应识别：回环 / 0.0.0.0 / 链路本地 / 广播一律不认。

    实测被劫持时路由器返回的是 127.0.0.1，curl 会立刻 "Could not connect"，
    如果直接拿它去 --resolve，就是把「解析失败」变成「连接失败」，
    日志里更难看出是 DNS 的问题。所以这里显式过滤。
    """
    if not ip:
        return True
    for p in BAD_PREFIXES:
        if ip.startswith(p):
            return True
    return False


def curl_path():
    """找 curl：环境变量 → PATH → Termux 固定路径 → 常见系统路径。"""
    env = os.environ.get("SHZU_CURL") or os.environ.get("CURL")
    if env and os.path.exists(env):
        return env
    found = shutil.which("curl")
    if found:
        return found
    for cand in (
        "/data/data/com.termux/files/usr/bin/curl",
        "/system/bin/curl",
        "/usr/bin/curl",
        r"C:\Windows\System32\curl.exe",
    ):
        if os.path.exists(cand):
            return cand
    return ""


def _doh_query(host, curl=None):
    """用 DoH 查 A 记录。返回过滤后的 IPv4 列表；全失败返回 []。

    关键点：DoH 服务器自己的 IP 是**钉死**的（--resolve），不查系统 DNS，
    所以哪怕整个系统解析器被劫持成 127.0.0.1，这条路照样通。
    """
    exe = curl or curl_path()
    if not exe:
        return []
    for name, ip, path in DOH_ENDPOINTS:
        url = "https://%s%s?name=%s&type=A" % (name, path, host)
        argv = [
            exe, "-sS", "-k", "--ssl-no-revoke",
            "--max-time", str(int(DOH_TIMEOUT)),
            "--resolve", "%s:443:%s" % (name, ip),
            url,
        ]
        try:
            p = subprocess.run(argv, capture_output=True, timeout=DOH_TIMEOUT + 6)
        except Exception:
            continue
        if p.returncode != 0:
            continue
        try:
            data = json.loads(p.stdout.decode("utf-8", "replace"))
        except ValueError:
            continue
        ips = []
        for ans in data.get("Answer") or []:
            if ans.get("type") != 1:
                continue
            val = (ans.get("data") or "").strip()
            if val and not is_bogus(val) and val not in ips:
                ips.append(val)
        if ips:
            return ips
    return []


def resolve(host, servers=None, use_doh=True):
    """返回 host 的 IPv4 列表；全部失败返回 []。带进程内缓存。

    顺序：UDP 直查（快，正常网络一次命中）→ DoH（被劫持时的唯一活路）。
    UDP 拿到劫持值（127.x 等）视为失败，继续往下走，绝不返回劫持 IP。
    """
    if not host:
        return []
    # 已经是 IP 就不用解析
    try:
        socket.inet_aton(host)
        return [host]
    except OSError:
        pass
    now = time.time()
    hit = _cache.get(host)
    if hit and hit[1] > now:
        return hit[0]
    for srv in (servers or DNS_SERVERS):
        try:
            ips = _query_one(srv, host)
        except Exception:
            continue
        ips = [ip for ip in (ips or []) if not is_bogus(ip)]
        if ips:
            _cache[host] = (ips, now + CACHE_TTL)
            return ips
    if use_doh:
        ips = _doh_query(host)
        if ips:
            _cache[host] = (ips, now + CACHE_TTL)
            return ips
    return []


# ---------------------------------------------------------------- curl 注入
def host_of(url):
    """从 URL 里抠出 host（不依赖 urllib 的解析器行为）。"""
    s = url
    for p in ("https://", "http://"):
        if s.startswith(p):
            s = s[len(p):]
            break
    for sep in ("/", "?", "#"):
        i = s.find(sep)
        if i >= 0:
            s = s[:i]
    if "@" in s:  # user:pass@host
        s = s.rsplit("@", 1)[1]
    if s.startswith("["):  # IPv6
        return s[1:s.find("]")] if "]" in s else s
    if ":" in s:
        s = s.split(":", 1)[0]
    return s


def scheme_of(url):
    return "http" if url.startswith("http://") else "https"


def resolve_args(url):
    """给 curl 用的 --resolve 参数列表；解析不出来就返回 []（不影响原命令）。"""
    host = host_of(url)
    if not host:
        return []
    ips = resolve(host)
    if not ips:
        return []
    port = 80 if scheme_of(url) == "http" else 443
    return ["--resolve", "%s:%d:%s" % (host, port, ips[0])]


def run_curl(argv, timeout=None):
    """跑 curl；若首次因解析失败而 http=000，自动加 --resolve 重试一次。

    argv 必须是 [curl, ...] 的完整命令。返回 CompletedProcess。
    这里只负责"重试"，不解析输出，调用方原有的解析逻辑完全不用改。
    """
    if not argv:
        raise ValueError("argv 为空")
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise
    # curl 解析失败时的退出码是 6；也有超时 28。两种情况都值得用 --resolve 再试。
    if p.returncode in (6,) or (p.returncode != 0 and not (p.stdout or b"").strip()):
        url = argv[-1]
        extra = resolve_args(url)
        if extra:
            retry = [argv[0]] + extra + argv[1:]
            p2 = subprocess.run(retry, capture_output=True, timeout=timeout)
            if p2.returncode == 0 or (p2.stdout or b"").strip():
                return p2
    return p


if __name__ == "__main__":
    # 自检：python netdns.py [host...]
    hosts = sys.argv[1:] or ["charge.shzu.edu.cn", "ntfy.sh", "api.shzucharge.xyz"]
    for h in hosts:
        t0 = time.time()
        udp = resolve(h, use_doh=False)
        udp_t = time.time() - t0
        t1 = time.time()
        final = udp or resolve(h, use_doh=True)
        path = "UDP" if udp else ("DoH" if final else "FAIL")
        print("%-26s %-18s 走%-3s  udp=%.2fs 总=%.2fs"
              % (h, (final[0] if final else "FAIL"), path, udp_t, time.time() - t1))
