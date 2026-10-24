# ABOUTME: Добавляет Python стандартной библиотеки для неизменного принятого сборщика GameCore.
# ABOUTME: Node base задаётся immutable image; приложение и модели в этот образ не копируются.
ARG BRAI_NODE_IMAGE
FROM ${BRAI_NODE_IMAGE}
ARG BRAI_NODE_IMAGE
ARG BRAI_SOURCE_REVISION
ARG BRAI_PYTHON_PACKAGE_VERSION=3.11.2-1+b1
LABEL org.opencontainers.image.title="Brai GameCore compiler runtime" \
      org.opencontainers.image.revision="${BRAI_SOURCE_REVISION}" \
      org.opencontainers.image.base.name="${BRAI_NODE_IMAGE}"
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3="${BRAI_PYTHON_PACKAGE_VERSION}" \
 && python3 -c 'import hashlib, json, pathlib, tempfile, uuid' \
 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
