#!/usr/bin/env bash
# Deployment smoke test: container health, inter-service connectivity, HTTPS, secrets not shipped to
# the browser, and (with --restart) persistence across a full stack restart.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; fail=1; }
envval() { grep -E "^$1=" .env | cut -d= -f2-; }

TOKEN="$(envval HUB_API_TOKEN)"
HOST="$(envval HUB_HOSTNAME)"
HUB="http://127.0.0.1:$(envval HUB_LOCAL_PORT || echo 3000)"

echo "== containers"
for svc in grocy mealie gms n8n hub caddy; do
  state="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' | awk -v s="$svc" '$1==s {print $2" "$3}')"
  case "$state" in
    "running healthy") ok "$svc healthy" ;;
    running*) bad "$svc running but not healthy ($state)" ;;
    *) bad "$svc not running" ;;
  esac
done

echo "== connectivity (hub → Grocy, Mealie, Grocy-Mealie Sync)"
deep="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/health?deep=1" 2>&1)" && ok "deep health: $(echo "$deep" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("grocy", d["grocy"]["detail"], "| mealie", d["mealie"]["detail"], "| gms ok" if d["gms"]["ok"] else "| gms FAIL")')" || bad "deep health failed: $deep"
docker compose exec -T n8n wget -qO- http://hub:3000/api/health >/dev/null 2>&1 && ok "n8n → hub over the private network" || bad "n8n cannot reach the hub"
docker compose exec -T gms wget -qO- http://grocy:80/login >/dev/null 2>&1 && ok "gms → grocy" || bad "gms cannot reach grocy"

echo "== HTTPS"
curl -fsS --cacert <(docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt) --resolve "$HOST:443:127.0.0.1" "https://$HOST/api/health" >/dev/null 2>&1 \
  && ok "https://$HOST serves the hub with a certificate from the local CA" || bad "HTTPS check failed for https://$HOST"
curl -fsS "http://$HOST/ca.crt" | grep -q "BEGIN CERTIFICATE" && ok "CA certificate download at http://$HOST/ca.crt" || bad "CA certificate not served"

echo "== exposure"
for port in 9283 9925 3001 5678 3000; do
  if ss -tlnH "( sport = :$port )" | awk '{print $4}' | grep -qvE '^127\.0\.0\.1:'; then bad "port $port is bound beyond localhost"; else ok "port $port bound to localhost only"; fi
done
curl -sS -o /dev/null -w '%{http_code}' "$HUB/api/inventory" | grep -q 401 && ok "API rejects unauthenticated requests" || bad "API answered without authentication"

echo "== secrets stay server-side"
jar="$(mktemp)"
curl -fsS -c "$jar" -H 'Content-Type: application/json' -d "{\"password\":\"$(envval HUB_PASSWORD)\"}" "$HUB/api/auth/login" >/dev/null || bad "login failed"
pages="$(for p in / /scan /meals /shopping /inventory /assistant /settings; do curl -fsS -b "$jar" "$HUB$p"; done)"
chunks="$(echo "$pages" | grep -oE '/_next/static/[^"]+\.js' | sort -u)"
leaks=0
for c in $chunks; do
  body="$(curl -fsS "$HUB$c")"
  for key in GROCY_API_KEY MEALIE_API_TOKEN HUB_API_TOKEN GMS_AUTH_SECRET HUB_SESSION_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY INSTACART_API_KEY; do
    v="$(envval "$key")"
    if [ -n "$v" ] && [ "${#v}" -ge 12 ] && grep -qF "$v" <<<"$body$pages"; then bad "$key found in browser bundle $c"; leaks=1; fi
  done
done
rm -f "$jar"
[ "$leaks" -eq 0 ] && ok "no API key or token appears in $(echo "$chunks" | wc -w) browser bundles or page HTML"

if [ "${1:-}" = "--restart" ]; then
  echo "== persistence across a full restart"
  snapshot() {
    curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/inventory" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["items"]), round(sum(i["amount"] for i in d["items"]),3))'
    curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/recipes" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["recipes"]))'
    curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/scan/recent?limit=200" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["transactions"]))'
    curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/cook" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["occurrences"]))'
  }
  before="$(snapshot)"
  docker compose down >/dev/null 2>&1 && docker compose up -d >/dev/null 2>&1
  for _ in $(seq 1 60); do curl -fsS -H "Authorization: Bearer $TOKEN" "$HUB/api/health?deep=1" >/dev/null 2>&1 && break; sleep 3; done
  after="$(snapshot)"
  [ "$before" = "$after" ] && ok "inventory, recipes, scan journal and cooking journal identical after down/up" || bad "data changed across restart: before=[$before] after=[$after]"
fi

echo
[ "$fail" -eq 0 ] && echo "SMOKE TEST PASSED" || echo "SMOKE TEST FAILED"
exit "$fail"
