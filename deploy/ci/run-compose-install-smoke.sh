#!/usr/bin/env bash
# ABOUTME: Собирает кандидата Brai и запускает его Compose с одноразовыми БД и NATS.
# ABOUTME: Проверяет запуск Web, Auth, Timer и Artifacts без внешних пользовательских доступов.
set -euo pipefail

[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "${BRAI_CI_SOURCE_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'Use a full Brai commit SHA.' >&2
  exit 1
}
run_dir=$(mktemp -d "$RUNNER_TEMP/brai-compose-install.XXXXXXXX")
source_dir="$run_dir/source"
compose=()
sampler=

sample_disk() {
  df -B1 --output=avail /var/lib/docker | tail -1
}

finish() {
  local status=$?
  trap - EXIT
  if [[ -n "$sampler" ]]; then
    kill "$sampler" 2>/dev/null || true
    wait "$sampler" 2>/dev/null || true
    { cat "$run_dir/disk"; sample_disk || true; } | awk '
      NR == 1 { start = min = $1 }
      $1 < min { min = $1 }
      END {
        printf "Start free: %.2f GiB\nLowest sampled free: %.2f GiB\nSampled increase: %.2f GiB\n", start / 2^30, min / 2^30, (start - min) / 2^30
      }'
  fi
  if (("${#compose[@]}")); then
    if ((status)); then
      "${compose[@]}" ps -a || true
      "${compose[@]}" logs --tail 40 || true
    fi
    if ! "${compose[@]}" down --volumes --remove-orphans; then
      status=1
    fi
  fi
  rm -rf -- "$run_dir"
  exit "$status"
}
trap finish EXIT

printf 'CPU cores: %s\n' "$(nproc)"
df -B1 --output=target,size,avail / "$RUNNER_TEMP" /var/lib/docker
sample_disk > "$run_dir/disk"
(while sleep 5; do sample_disk >> "$run_dir/disk"; done) &
sampler=$!

git init -q "$source_dir"
git -C "$source_dir" fetch --no-tags --depth=1 https://github.com/Q-Fox-Labs/Brai.git "$BRAI_CI_SOURCE_SHA"
git -C "$source_dir" switch --detach FETCH_HEAD
test "$(git -C "$source_dir" rev-parse HEAD)" = "$BRAI_CI_SOURCE_SHA"

# Web uses the release's prepared runtime. The other images use their source Dockerfiles.
(
  cd "$source_dir"
  test "$(npm --version)" = '11.19.1'
  npm ci --no-audit --no-fund
  npm run build --workspace=@brai/agent
  CI=1 NEXT_TELEMETRY_DISABLED=1 BRAI_WEB_STANDALONE_OUTPUT=0 npm run build --workspace=@brai/web
  node deploy/scripts/materialize-runtime.mjs --source "$source_dir" --workspace @brai/web \
    --revision "$BRAI_CI_SOURCE_SHA" --output "$run_dir/web-runtime"
)
cat > "$run_dir/from-source.yml" <<'YAML'
services:
  db:
    healthcheck:
      test: [CMD, pg_isready, -h, 127.0.0.1, -U, timer_owner, -d, brai_timer_test]
  artifacts:
    build: { context: .., dockerfile: services/artifacts/Dockerfile }
  artifacts-migrate:
    build: { context: .., dockerfile: services/artifacts/Dockerfile }
  artifacts-volume-init:
    build: { context: .., dockerfile: services/artifacts/Dockerfile }
  artifacts-mcp:
    build: { context: .., dockerfile: services/artifacts/Dockerfile }
YAML
cat > "$run_dir/compose.env" <<ENV
BRAI_SOURCE_REVISION=$BRAI_CI_SOURCE_SHA
BRAI_WEB_RUNTIME_CONTEXT=$run_dir/web-runtime
BRAI_ARTIFACTS_RUNTIME_CONTEXT=$source_dir
BRAI_ARTIFACTS_IMAGE=brai-ci-artifacts:$BRAI_CI_SOURCE_SHA
BRAI_AUTH_IMAGE=brai-ci-auth:$BRAI_CI_SOURCE_SHA
BRAI_TIMER_IMAGE=brai-ci-timer:$BRAI_CI_SOURCE_SHA
BRAI_ARTIFACTS_TEST_SUBNET=172.29.97.0/24
BRAI_ARTIFACTS_PRIVATE_HOST_IP=172.29.97.1
ENV
compose=(docker compose --env-file "$run_dir/compose.env"
  -f "$source_dir/deploy/compose.production-test.yml" -f "$run_dir/from-source.yml")
"${compose[@]}" config -q
for service in auth timer; do
  docker build --label "org.opencontainers.image.revision=$BRAI_CI_SOURCE_SHA" \
    --tag "brai-ci-$service:$BRAI_CI_SOURCE_SHA" --file "$source_dir/services/$service/Dockerfile" "$source_dir"
done
# YAML's quoted scalar in the d415983 fixture contains a real newline inside a JavaScript string.
init_script=$("${compose[@]}" --profile artifacts-initialize config --format json \
  | jq -er '.services["artifacts-volume-init"].command[2]')
init_script=${init_script//$'artifact fixture bytes\n'/artifact fixture bytes\\n}
node --check <<< "$init_script"
"${compose[@]}" --profile artifacts-initialize run --rm --build --no-deps artifacts-volume-init node -e "$init_script"
"${compose[@]}" up -d --wait db nats
"${compose[@]}" --profile migration run --rm artifacts-migrate
"${compose[@]}" build web
"${compose[@]}" up -d --no-build --wait
"${compose[@]}" ps -a
curl --fail --silent --show-error http://127.0.0.1:13000/api/health \
  | jq -e '.component == "web" and .ready == true'
echo "Candidate $BRAI_CI_SOURCE_SHA started with fresh PostgreSQL and NATS."
python3 - "$source_dir" "$run_dir" <<'PY'
import hashlib
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import quote
from urllib.request import urlopen

source, work = map(Path, sys.argv[1:])
profiles = source / 'services/local-ai/profiles'
total = 0
for name in ('gigaam_pytorch', 'embeddinggemma2_llama_cpp', 'silero_pytorch'):
    profile = json.loads((profiles / f'{name}.json').read_text())
    model = profile['source']
    destination = work / 'models' / name
    destination.mkdir(parents=True)
    for entry in model['files']:
        filename = entry['path']
        if Path(filename).name != filename:
            raise ValueError(f'Unexpected model path in {name}')
        url = entry.get('url') or (
            f'https://huggingface.co/{model["repository"]}/resolve/'
            f'{model["revision"]}/{quote(filename)}'
        )
        target = destination / filename
        with urlopen(url) as response, target.open('wb') as output:
            shutil.copyfileobj(response, output)
        with target.open('rb') as saved:
            digest = hashlib.file_digest(saved, 'sha256').hexdigest()
        size = target.stat().st_size
        if size != entry['bytes'] or digest != entry['sha256']:
            raise ValueError(f'Model file differs from the source manifest: {name}/{filename}')
        total += size
    print(f'Verified public model snapshot {name}.', flush=True)
print(f'Public model files on disk: {total} bytes.')
PY
