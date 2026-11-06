#!/usr/bin/env bash
# Imports the version-controlled n8n workflows and creates the "Household Hub API token" credential
# from .env. The token is piped through stdin into the container and deleted after import; it is never
# written to the host or shown on a command line.
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN="$(grep -E '^HUB_API_TOKEN=' .env | cut -d= -f2-)"
[ -n "$TOKEN" ] || { echo "HUB_API_TOKEN missing in .env" >&2; exit 1; }

echo "waiting for n8n…"
for _ in $(seq 1 60); do
  if docker compose exec -T n8n wget -qO- http://127.0.0.1:5678/healthz >/dev/null 2>&1; then break; fi
  sleep 3
done

printf '[{"id":"hubApiToken","name":"Household Hub API token","type":"httpHeaderAuth","data":{"name":"Authorization","value":"Bearer %s"}}]' "$TOKEN" |
  docker compose exec -T n8n sh -c 'umask 077; cat > /tmp/hub-cred.json; n8n import:credentials --input=/tmp/hub-cred.json; rc=$?; rm -f /tmp/hub-cred.json; exit $rc'

docker compose exec -T n8n n8n import:workflow --separate --input=/workflows

# Activate the scheduled workflows (not the receipt template). The CLI flag differs between n8n
# versions; if activation fails, activate them in the n8n UI (Workflows → toggle "Active").
for f in workflows/n8n/*.json; do
  case "$f" in *template*) continue ;; esac
  id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$f" 2>/dev/null || node -p "require('./$f').id")"
  if ! docker compose exec -T n8n n8n update:workflow --id="$id" --active=true >/dev/null 2>&1; then
    docker compose exec -T n8n n8n publish:workflow --id="$id" >/dev/null 2>&1 || echo "  could not activate $f automatically — activate it in the n8n UI"
  fi
done
echo "n8n workflows imported. Restart n8n to load activation changes: docker compose restart n8n"
