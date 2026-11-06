#!/usr/bin/env bash
# One-time (and re-runnable) setup: .env secrets → start Grocy + Mealie → create API credentials →
# start the rest of the stack → import n8n workflows. Never prints secret values.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE=(node)
if ! command -v node >/dev/null 2>&1; then
  # No Node on the host (e.g. a fresh Proxmox VM): run the script in the pinned Node image.
  NODE=(docker run --rm --network host --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work -e DETECTED_LAN_IP node:24.12.0-bookworm-slim node)
fi

DETECTED_LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1 || true)"
export DETECTED_LAN_IP

echo "== 1/5 environment"
"${NODE[@]}" scripts/bootstrap.mjs env

echo "== 2/5 starting Grocy and Mealie"
docker compose up -d grocy mealie

echo "== 3/5 creating API credentials"
"${NODE[@]}" scripts/bootstrap.mjs services

echo "== 4/5 starting the full stack"
docker compose up -d --build

echo "== 5/5 importing n8n workflows"
scripts/n8n-import.sh || echo "n8n import skipped/failed — run scripts/n8n-import.sh after n8n is healthy"

HOST="$(grep -E '^HUB_HOSTNAME=' .env | cut -d= -f2-)"
cat <<EOF

Done.
  Household Hub (phones):  https://${HOST}        (install http://${HOST}/ca.crt on each phone first)
  Household Hub (this PC): http://localhost:3000
  Mealie:                  https://${HOST}:9443   (admin login in .env: MEALIE_ADMIN_EMAIL / MEALIE_ADMIN_PASSWORD)
  Grocy (admin):           http://localhost:9283  (admin / GROCY_ADMIN_PASSWORD)
  Grocy-Mealie Sync:       http://localhost:3001  (sign in with GMS_AUTH_SECRET)
  n8n:                     http://localhost:5678
The household password is HUB_PASSWORD in .env.
Optional demo data: node scripts/seed-demo.mjs
EOF
