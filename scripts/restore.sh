#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh. DESTRUCTIVE: replaces the current contents of every
# volume in the backup. Asks for confirmation unless --yes is given.
#
#   scripts/restore.sh backups/20261021-220000 [--yes]
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:?usage: scripts/restore.sh <backup-dir> [--yes]}"
[ -f "$SRC/MANIFEST" ] || { echo "$SRC is not a backup directory (no MANIFEST)" >&2; exit 1; }
(cd "$SRC" && sha256sum -c SHA256SUMS >/dev/null) || { echo "checksum mismatch in $SRC" >&2; exit 1; }

PROJECT="$(grep -E '^project=' "$SRC/MANIFEST" | cut -d= -f2)"
TAR_IMAGE="caddy:2.11.7-alpine"

if [ "${2:-}" != "--yes" ]; then
  echo "This will REPLACE the current data of project '$PROJECT' with the backup in $SRC:"
  ls "$SRC"/*.tgz | xargs -n1 basename
  read -r -p "Type 'restore' to continue: " answer
  [ "$answer" = "restore" ] || { echo "aborted"; exit 1; }
fi

docker compose down
for archive in "$SRC"/*.tgz; do
  v="$(basename "$archive" .tgz)"
  vol="${PROJECT}_${v}"
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol":/v -v "$(cd "$SRC" && pwd)":/backup:ro "$TAR_IMAGE" sh -c "find /v -mindepth 1 -delete && tar xzf /backup/$v.tgz -C /v"
  echo "  ✓ restored $v"
done

if [ ! -f .env ]; then
  cp "$SRC/env.backup" .env && chmod 600 .env
  echo "  ✓ restored .env"
else
  echo "  – kept the existing .env (the backup's copy is $SRC/env.backup)"
fi
docker compose up -d
echo "restore complete; run scripts/smoke.sh to verify"
