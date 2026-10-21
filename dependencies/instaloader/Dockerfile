# ABOUTME: Устанавливает закреплённый Instaloader и его Python-зависимости.
# ABOUTME: Предоставляет CLI без фонового сервиса; данные хранятся в /data.
FROM python:3.13-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/data \
    XDG_CONFIG_HOME=/data/.config

COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/requirements.txt \
    && python -m pip check \
    && rm /tmp/requirements.txt \
    && mkdir /data \
    && chown 1000:1000 /data

USER 1000:1000
WORKDIR /data
ENTRYPOINT ["instaloader"]
CMD ["--help"]
