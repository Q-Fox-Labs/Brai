#!/bin/sh
# ABOUTME: Собирает закреплённый Kitesurf в отдельный каталог поставки Brai.
# ABOUTME: Не устанавливает сервисы, не запускает браузер и не перезаписывает каталог.
set -eu

if [ "$#" -ne 2 ]; then
    echo 'Usage: build.sh /absolute/kitesurf-source /absolute/new-output' >&2
    exit 2
fi
source_root=$1
output=$2
case "$source_root:$output" in
    /*:/*) ;;
    *) echo 'Absolute source and output paths are required' >&2; exit 2 ;;
esac
if [ -e "$output" ] || [ -L "$output" ]; then
    echo 'Output already exists' >&2
    exit 2
fi
expected=b9b904e208836b946c6ffc81832ac1ec576ece54
if [ "$(git -C "$source_root" rev-parse HEAD)" != "$expected" ] || ! git -C "$source_root" diff --quiet HEAD --; then
    echo 'Unexpected Kitesurf source' >&2
    exit 2
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$output/services/hermes/kitesurf" "$output/services/hermes/identity" "$output/assets" "$output/bundle"
cp "$script_dir/package.json" "$script_dir/package-lock.json" "$script_dir/engine.mjs" "$output/services/hermes/kitesurf/"
cp "$script_dir/../identity/kitesurf_outbound.mjs" "$output/services/hermes/identity/"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$output/services/hermes/kitesurf"
PATH="$output/services/hermes/kitesurf/node_modules/.bin:$PATH"
export PATH CI=1 WRANGLER_SEND_METRICS=false
pnpm --dir "$source_root" install --frozen-lockfile --ignore-scripts
pnpm --dir "$source_root" run build
"$source_root/packages/engine/node_modules/.bin/wrangler" deploy --dry-run --env local \
    --config "$source_root/packages/engine/wrangler.jsonc" --outdir "$output/bundle"
cp -a "$source_root/packages/engine/public/." "$output/assets/"
npm prune --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$output/services/hermes/kitesurf"
