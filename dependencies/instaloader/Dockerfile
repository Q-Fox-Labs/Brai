# ABOUTME: Устанавливает закреплённый Instaloader и его Python-зависимости.
# ABOUTME: Предоставляет CLI без фонового сервиса; данные хранятся в /data.
FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/data \
    XDG_CONFIG_HOME=/data/.config

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/requirements.txt \
    && python -m pip check \
    && rm /tmp/requirements.txt \
    && mkdir /data \
    && chown 1000:1000 /data

USER 1000:1000
WORKDIR /data
ENTRYPOINT ["instaloader"]
CMD ["--help"]
