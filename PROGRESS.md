# Progress

Living log of what is done, what is verified, and what is still open. "Verified" means exercised by an
automated test or a recorded check; "implemented" means written but not yet exercised against the real
services.

## Environment (2026-10-21)

- WSL2 2.6.3, kernel 6.6.87.2, **Ubuntu 22.04.5** (the brief says 24.04; nothing depends on it).
- `networkingMode=mirrored`: WSL shares the Windows LAN IP (192.168.1.105).
- Node 24.12.0 / npm 11.7.0 from nvm (Linux-native; a Windows npm under `/mnt/c` is on PATH but shadowed).
- Docker: fixed on 2026-10-22 by the user (snap daemon disabled, `josep` added to `docker`; apt docker.io
  29.1.3, Compose 5.0.1). Shells opened before the change need `sg docker -c …` or a new terminal.
- LAN address on 2026-10-22: 192.168.152.33 (was 192.168.1.105 the day before; detected by bootstrap).
- Ports 80, 443, 3000, 3001, 5678, 9283, 9443, 9925 free.

## Pinned versions (all verified to exist in their registries)

| Component | Version |
|---|---|
| Grocy | `lscr.io/linuxserver/grocy:v4.7.1-ls345` (Grocy 4.7.1) |
| Mealie | `ghcr.io/mealie-recipes/mealie:v3.28.0` |
| Grocy-Mealie Sync | `ghcr.io/harmellis/grocy-mealie-sync:1.18.0` (latest stable; 1.19 is RC) |
| n8n | `n8nio/n8n:2.44.4` |
| Caddy | `caddy:2.11.7-alpine` |
| Hub runtime | `node:24.12.0-bookworm-slim` |
| Next.js / React / TypeScript / Zod / Tailwind | 16.4.2 / 19.3.1 / 6.0.3 / 4.6.7 / 4.3.3 |
| Barcode decoding | `barcode-detector` 3.2.3 (ZXing-C++ WASM 3.1.6, self-hosted) |
| AI SDKs | `@anthropic-ai/sdk` 1.1.0, `openai` 7.42.0 |

## Phase status

| Phase | Status |
|---|---|
| 1 Foundation | **deployed**: all 6 containers healthy; bootstrap created Grocy/Mealie credentials; smoke test passes |
| 2 Next.js app, auth, API clients | done; production build passes; lint and strict type-check clean |
| 3 Barcode inventory | done (camera, wedge, manual, resolve, OFF, registration, receive, consume, undo); unit + browser tested against mocks |
| 4 Recipe consumption | done (plan, journal, execute, reconcile, retry, skip, correct, reverse); unit + browser tested against mocks |
| 5 Meal planning | done (calendar, Mealie plan CRUD, servings, leftovers, AI + heuristic planner, proposals) |
| 6 Shopping | done (requirements − stock, min-stock top-up, sourcing, per-store Mealie lists, export, handoff) |
| 7 Automation | 6 workflows + credential imported into n8n 2.44.4; the 5 scheduled ones active |
| 8 Production readiness | smoke test passes; seed data, live integration suite, backup/restore and `--restart` persistence not yet run |

## Tests

| Suite | Command | Result |
|---|---|---|
| Unit (Vitest) | `npm test` | **117 passed** |
| Browser (Playwright, production build, Pixel 7, mock upstreams) | `npm run build && npm run test:e2e` | **20 passed** |
| Live integration (real Grocy/Mealie/GMS/hub) | `npm run test:integration` | **7 skipped** (stack not running) |
| Deployment smoke (`scripts/smoke.sh`) | — | **passed** (health, connectivity, HTTPS via local CA, localhost-only ports, 401 without auth, no secrets in 20 bundles); `--restart` not run yet |

The browser suite covers: login/redirects/API auth; phone camera with a synthetic EAN-13 video (decoded
locally, one booking while the code stays in view, WASM served by the hub); keyboard-wedge scanner;
intentional rescans, +1 and undo; duplicate network requests; unknown barcode with Open Food Facts prefill,
registration and booking; unknown-everywhere barcode; cooking with an unmapped line, FEFO across brand
products, exact deductions, no double cooking, reversal; repeated cooking requests; serving scaling; low
stock → preferred store → check-off without stock change; refusal to check the GMS list; built-in planner
with caching and apply; assistant answers and confirm-before-write; n8n alert endpoint with dedupe; no
credentials in HTML/JS/API responses; security headers.

## Bugs found and fixed during testing

- A retry of an *uncertain* scan reconciled immediately and could double-book if Grocy was still processing
  the timed-out request → now waits a 30 s settling window (unit-tested).
- Two recipe lines needing the same product could allocate the same lot twice → shared lot pool.
- Low-stock items were dropped when a planned meal also used the product → buy `max(0, min + planned − usable)`.
- Regenerating store lists re-added items already checked off (in the cart, not yet scanned) → checked items satisfy their need.
- Next.js prerender bail-out errors were swallowed by the API error handler → `connection()` + `unstable_rethrow`.
- Assistant page crashed: an effect implicitly returned `scrollIntoView()`'s Promise (Chrome 156) → block body.
- Keyboard-wedge debounce (250 ms) could drop a fast deliberate rescan → 150 ms.
- Cook page's floating disabled button covered content → solid sticky action bar with the blocking reason.

## Found on first real deployment (2026-10-22) and fixed

- Hub image: the image's npm 11.6.2 ignores better-sqlite3's `"gypfile": false` and tried to compile it →
  `npm ci --ignore-scripts` (better-sqlite3 loads bundled prebuilds; no other dependency needs a script).
- Grocy 4.7.1 creates/migrates its database only when `/` is requested → bootstrap requests `/` first.
- Grocy 4.7.1's login form posts `password_base64`, not `password` → bootstrap sends base64.
- Grocy 4.7.1 does not expose `api_keys` through the REST API → bootstrap reads the new key (by the id in
  the `?key=` redirect) from the API-keys page and verifies it.
- Smoke script used `curl -f` for the 401 check, hiding the status code → fixed.

## Key design decisions

See [docs/architecture.md](docs/architecture.md). In short: GMS mappings are 1:1 → generic parent products;
GMS renames mapped products → map foods to generic parents only; GMS books stock on check-off of its list →
separate store lists, receiving is the only way stock goes up; Mealie has no cooked event → hub-driven
completion with a Mealie link Recipe Action; uncertain Grocy writes reconciled via stock-log watermark and
`hub:<key>` notes.

## Open issues / next steps

1. Optional demo data (`node scripts/seed-demo.mjs`), then `cd apps/web && npm run test:integration` and
   `scripts/smoke.sh --restart` to verify the scan → cook loop and persistence on the real services.
2. Hyper-V firewall rule + CA install on a real phone; test `/scan` on iOS Safari and Android Chrome.
3. Create the n8n owner account in the n8n UI.
4. Copy `config/*.example.yaml` to real files and fill in household preferences and store rules.
5. Optional: AI key, Instacart key, ntfy topic.
