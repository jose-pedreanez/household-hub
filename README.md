# Household Hub

A self-hosted kitchen system for one household: scan groceries in, plan meals, mark them cooked so the
ingredients come out of inventory, and get per-store shopping lists for Trader Joe's, Grocery Outlet and
Amazon Fresh. One phone-friendly web app (PWA) on top of proven open-source services:

| Service | Role |
|---|---|
| [Grocy](https://github.com/grocy/grocy) 4.7.1 | inventory: stock, lots, due dates, barcodes, package sizes |
| [Mealie](https://github.com/mealie-recipes/mealie) v3.28.0 | recipes, meal plan, shopping lists |
| [Grocy-Mealie Sync](https://github.com/HarmEllis/grocy-mealie-sync) 1.18.0 | ingredient ↔ product and unit mappings, low-stock list, “in possession” |
| [n8n](https://docs.n8n.io/hosting/) 2.44.4 | schedules: weekly plan draft, shopping prep, alerts, audits |
| Household Hub (this repo, Next.js 16) | the household UI and every cross-service workflow |
| Caddy 2.11.7 | HTTPS on the LAN (needed for phone cameras) |

What the hub adds: camera / USB / Bluetooth barcode receiving with exact package → stock-unit conversion
and exactly-once booking; Open Food Facts enrichment with honest nutrition data; cooking that deducts the
right lots (earliest expiry first, across brand variants) with a durable journal, retry, correction and
reversal; ingredient requirements minus stock; store sourcing rules; an AI or built-in meal planner whose
suggestions are validated against real data; and an assistant that can only *propose* changes.

## Quick start

```bash
cd ~/projects/household-hub
scripts/bootstrap.sh            # creates .env secrets, Grocy/Mealie credentials, starts everything
node scripts/seed-demo.mjs      # optional demo data
scripts/smoke.sh                # verify
```

Then on a phone: install `http://<HUB_HOSTNAME>/ca.crt`, open `https://<HUB_HOSTNAME>`, sign in with
`HUB_PASSWORD` from `.env`, and add it to the home screen. Details, including the one-time Docker and
Windows firewall steps: [docs/deployment.md](docs/deployment.md).

| | URL |
|---|---|
| Household Hub (phones) | `https://<HUB_HOSTNAME>` |
| Household Hub (this PC) | http://localhost:3000 |
| Mealie | `https://<HUB_HOSTNAME>:9443` · http://localhost:9925 |
| Grocy (admin only) | http://localhost:9283 |
| Grocy-Mealie Sync (admin) | http://localhost:3001 |
| n8n (admin) | http://localhost:5678 |

## Commands

```bash
docker compose up -d                 # start
docker compose down                  # stop (data stays in named volumes)
docker compose ps                    # health
docker compose logs -f hub           # logs
scripts/smoke.sh [--restart]         # deployment checks (+ persistence across restart)
scripts/backup.sh [dir]              # backup → backups/<timestamp>/
scripts/restore.sh <backup-dir>      # restore (asks for confirmation)

cd apps/web
npm ci
npm test                             # unit tests (Vitest)
npx playwright install chromium      # once
npm run build && npm run test:e2e    # browser tests (production build + mock upstreams)
npm run test:integration             # live tests against the running, seeded stack
npm run typecheck && npm run lint
```

## How it fits together

- Grocy owns stock; Mealie owns recipes and the plan; Grocy-Mealie Sync owns mappings; the hub's SQLite
  file holds only journals, idempotency keys, nutrition metadata and plan annotations.
- One ingredient backed by several products = a generic Grocy product (“Pasta”) mapped to the Mealie food,
  with brand products as its sub-products.
- Stock goes up only by receiving (scan). Checking a store-list item off never adds stock.
- Stock goes down only when someone confirms a meal was cooked — never when it is merely planned.

More: [architecture](docs/architecture.md) · [API integrations](docs/api-integrations.md) ·
[barcode workflow](docs/barcode-workflow.md) · [cooking & consumption](docs/inventory-consumption.md) ·
[deployment](docs/deployment.md) · [backup & restore](docs/backup-restore.md) ·
[Proxmox migration](docs/migration-to-proxmox.md) · [troubleshooting](docs/troubleshooting.md) ·
[known limitations](docs/known-limitations.md) · [progress log](PROGRESS.md)

## Configuration

- `.env` — secrets and addresses (template: `.env.example`; never commit `.env`).
- `config/household.yaml` — servings, meal slots, time limits, equipment, likes/dislikes, dietary
  restrictions (only those you list), alert repeat window. Start from `household.example.yaml`.
- `config/retailers.yaml` — stores, preferred/backup products, package sizes, max prices, substitutions
  and whether they need approval. Start from `retailers.example.yaml`.

```bash
cp config/household.example.yaml config/household.yaml
cp config/retailers.example.yaml config/retailers.yaml
```

Without the real files the hub uses the examples and the Settings page says so.

## Verification status

| Area | Status |
|---|---|
| Core logic (conversions, receiving, lots, cooking, sourcing, AI validation, …) | 117 unit tests pass |
| UI + API end to end (login, camera scan, scanner, registration, cooking, shopping, planner, assistant, secrets) | 20 browser tests pass **against mock upstreams** |
| Real Grocy / Mealie / GMS / n8n, Docker image, bootstrap, backups, phone HTTPS | **not yet run** — Docker was not accessible on the build machine; see [known limitations](docs/known-limitations.md) |
# household-hub
# household-hub
