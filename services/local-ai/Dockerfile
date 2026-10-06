# ABOUTME: Упаковывает заранее собранный local-ai и проверенные portable runtime payloads.
# ABOUTME: Base image и source revision обязательны; образ ничего не устанавливает и не скачивает.
ARG BRAI_LOCAL_AI_BASE
FROM ${BRAI_LOCAL_AI_BASE}

ARG BRAI_LOCAL_AI_BASE
ARG BRAI_SOURCE_REVISION
LABEL org.opencontainers.image.title="Brai local-ai" \
      org.opencontainers.image.revision="${BRAI_SOURCE_REVISION}" \
      org.opencontainers.image.base.name="${BRAI_LOCAL_AI_BASE}" \
      org.opencontainers.image.source="https://github.com/Q-Fox-Labs/Brai"

ENV NODE_ENV=production \
    HOME=/var/lib/brai/local-ai/home \
    HF_HOME=/var/lib/brai/local-ai/home/huggingface \
    HF_MODULES_CACHE=/var/lib/brai/local-ai/home/huggingface/modules \
    TMPDIR=/var/tmp/brai-local-ai \
    TEMP=/var/tmp/brai-local-ai \
    TMP=/var/tmp/brai-local-ai \
    PATH=/opt/brai/local-ai/runtime/node-v24.21.0-linux-x64/bin:/opt/brai/local-ai/runtime/ffmpeg/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LD_LIBRARY_PATH=/opt/brai/local-ai/runtime/llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/app:/opt/brai/local-ai/runtime/llama_cpp/7533d5f6c853a3f3284ffa8763bb89db346c8156831a009b6e23ea32be9b9571/system:/opt/brai/local-ai/runtime/system-libs:/opt/brai/local-ai/runtime/python/lib:/opt/brai/local-ai/runtime/python/lib/python3.12/lib-dynload:/opt/brai/local-ai/runtime/gigaam_pytorch/.venv/lib/python3.12/site-packages/torch/lib

COPY --chown=0:0 payload/app/ /opt/brai/local-ai/app/
COPY --chown=0:0 payload/runtime/ /opt/brai/local-ai/runtime/
COPY --chown=1000:1000 payload/hf-modules-cache/ /var/lib/brai/local-ai/home/huggingface/modules/
COPY --chown=0:0 payload/SHA256SUMS /opt/brai/local-ai/payload.SHA256SUMS
COPY --chown=0:0 services/local-ai/release.json /opt/brai/local-ai/release.json

RUN test "$BRAI_LOCAL_AI_BASE" = "ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4" \
    && test -n "$BRAI_SOURCE_REVISION" \
    && mkdir -p \
      /var/lib/brai/local-ai/home/huggingface/modules \
      /var/lib/brai/local-ai/models \
      /var/lib/brai/local-ai/staging \
      /var/lib/brai/local-ai/tmp \
      /var/tmp/brai-local-ai \
    && chown -R 1000:1000 /var/lib/brai/local-ai /var/tmp/brai-local-ai

WORKDIR /opt/brai/local-ai/app/services/local-ai
USER 1000:1000
ENTRYPOINT ["/opt/brai/local-ai/runtime/node-v24.21.0-linux-x64/bin/node", "src/main.mjs"]
