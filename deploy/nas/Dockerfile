# 石大充电桩 · NAS 采集端镜像
#
# 只需要 Python 标准库 + curl，没有 pip 依赖，镜像很小（~150 MB，主要是 python 基础镜像）。
# 构建上下文必须是**仓库根目录**（要拷 relay/ sniffer/ shared/ app/ deploy/）：
#   docker build -f deploy/nas/Dockerfile -t shzu-charging .
# 或者在仓库根目录直接：docker compose -f docker-compose.nas.yml up -d --build
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    RELAY_PORT=8080 \
    RELAY_DATA_DIR=/app/relay/data \
    LOG_DIR=/app/logs

# curl：采集器是直接调 curl 子进程抓接口的，没有 curl 就什么都采不到。
# ca-certificates：https 证书链。tzdata：日志时间要是北京时间才看得懂。
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tzdata bash util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . /app
RUN chmod +x deploy/nas/run.sh deploy/publish_loop.sh \
    && mkdir -p /app/logs /app/relay/data /app/sniffer/out /app/deploy/run

EXPOSE 8080

# /api/health 由 relay 提供，能反映「relay 是否真的活着」，比看进程更可靠。
HEALTHCHECK --interval=60s --timeout=5s --start-period=45s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${RELAY_PORT}/api/health" >/dev/null || exit 1

CMD ["bash", "deploy/nas/run.sh"]