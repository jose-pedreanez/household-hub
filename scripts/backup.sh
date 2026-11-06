#!/usr/bin/env bash
# Consistent backup of every persistent volume plus configuration and secrets.
# The stack is stopped for the copy (typically under a minute) so SQLite databases are not mid-write.
#
#   scripts/backup.sh                 → backups/<timestamp>/
#   scripts/backup.sh /mnt/nas/hub    → /mnt/nas/hub/<timestamp>/
#
# The backup contains .env (secrets, including N8N_ENCRYPTION_KEY) — store it somewhere private.
set -euo pipefail
cd "$(dirname "$0")/.."

DEST_ROOT="${1:-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_ROOT/$STAMP"
PROJECT="$(docker compose config --format json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])' 2>/dev/null || echo household-hub)"
VOLUMES=(grocy-config mealie-data gms-data n8n-data hub-data caddy-data)
TAR_IMAGE="caddy:2.11.7-alpine" # already part of the stack; has busybox tar

mkdir -p "$DEST"
chmod 700 "$DEST"
umask 077

was_running="$(docker compose ps --status running -q | wc -l)"
echo "stopping the stack for a consistent copy…"
docker compose stop

for v in "${VOLUMES[@]}"; do
  vol="${PROJECT}_${v}"
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    docker run --rm -v "$vol":/v:ro -v "$(cd "$DEST" && pwd)":/backup "$TAR_IMAGE" tar czf "/backup/$v.tgz" -C /v .
    echo "  ✓ $v"
  else
    echo "  – $v (volume not found, skipped)"
  fi
done

cp .env "$DEST/env.backup"
mkdir -p "$DEST/config" && cp -a config/. "$DEST/config/"
{
  echo "created=$STAMP"
  echo "project=$PROJECT"
  grep -E '^\s+image:' compose.yaml | sed 's/^\s*image:\s*/image=/'
} > "$DEST/MANIFEST"
(cd "$DEST" && sha256sum ./*.tgz > SHA256SUMS)

if [ "$was_running" -gt 0 ]; then
  echo "starting the stack again…"
  docker compose up -d
fi
echo "backup written to $DEST"
