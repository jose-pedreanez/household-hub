# Troubleshooting

**`permission denied … /var/run/docker.sock`** — your user is not in the `docker` group, or two daemons
fight over the socket. See *Prerequisites* in [deployment.md](deployment.md).

**`docker compose` complains `set HUB_PASSWORD in .env`** — run `scripts/bootstrap.sh` (or
`node scripts/bootstrap.mjs env`) to generate secrets.

**Hub page says “Invalid server configuration: GROCY_API_KEY …”** — bootstrap has not created the
Grocy/Mealie credentials yet: `node scripts/bootstrap.mjs services`, then `docker compose up -d hub gms`.

**Phone: “The camera only works over HTTPS”** — you opened `http://…`. Use `https://<HUB_HOSTNAME>` and
install the CA (`http://<HUB_HOSTNAME>/ca.crt`). If the page doesn't load at all from the phone, add the
Hyper-V firewall rule (deployment.md) and check `HUB_HOSTNAME` is the PC's current LAN IP (`ip -4 addr`).

**Phone: certificate warning** — the CA isn't trusted yet (iOS needs both the profile install *and* the
Certificate Trust Settings toggle). Recreating the `caddy-data` volume creates a new CA; phones must
install it again.

**Camera permission denied** — allow the camera for the site in the browser's site settings, then tap
*Start camera*. On iOS standalone (home-screen) apps the permission is asked per launch.

**Scanner types the code but nothing happens** — the scanner must send Enter (most do; check its manual).
Click outside any text field first. Very slow Bluetooth scanners (> 40 ms per character) look like human
typing; use the *Type* tab and scan into the field instead.

**“No conversion from Pack to g …” when scanning** — the barcode's package unit has no conversion to the
product's stock unit. Edit the barcode in Grocy to give the package size in the stock unit (e.g. 500 g), or
add a product conversion (1 Pack = 500 g) in Grocy-Mealie Sync → Units & Conversions.

**A scan stays “Waiting for Grocy to confirm…”** — Grocy didn't answer in time. The hub waits 30 s and then
checks Grocy's stock log; it books at most once. If it still can't tell, it says so; check the product's
history and undo/retry as needed.

**Cooking line “Not linked”** — the Mealie food has no Grocy product. Map it in Grocy-Mealie Sync (map the
food to a *generic* product; brand products go underneath as sub-products), or choose a product for this
meal only, or mark it “didn't use”.

**Cooking line “Unit unknown”** — e.g. cups of flour while flour is stocked in grams: add a product
conversion (1 cup = 120 g) for that product, or enter the amount in grams.

**Cooking shows “partial”** — some Grocy consumes failed (usually stock changed meanwhile). Open the record:
*Retry*, *Skip* the line, or correct it. Nothing that succeeded is repeated.

**Checked an item on the “Low stock (synced from Grocy)” list in Mealie and stock went up** — that list is
Grocy-Mealie Sync's; checking it there books a purchase. Use the store lists in the hub and scan purchases
instead. Undo the extra booking from the product's history.

**AI planner says “used the built-in planner”** — the provider is not configured, unreachable, declined, or
returned invalid output; the note says which. Check `AI_PROVIDER` and the key on the Settings page.

**Grocy-Mealie Sync shows a stale lock** — use *Clear Sync Locks* in its UI or
`curl -X POST -H "Authorization: Bearer $GMS_AUTH_SECRET" http://localhost:3001/api/sync/unlock`.

**Reset only the hub's own data** (journals, metadata; not stock or recipes):
`docker compose stop hub && docker volume rm household-hub_hub-data && docker compose up -d hub`.
Cooking records are lost; their Grocy transactions stay (undo them in Grocy if needed).

**Edited the Caddyfile but nothing changed** — it is bind-mounted as a single file, and editors that save by
replacing the file leave the container reading the old copy. Use `docker compose restart caddy` rather
than `caddy reload`. Check with `docker compose exec caddy cat /etc/caddy/Caddyfile`.

**The LAN address changed** — set `HUB_HOSTNAME`, `PUBLIC_BASE_URL` and `MEALIE_PUBLIC_URL` in `.env`,
run `docker compose up -d` (Caddy issues a certificate for the new address from the same CA, so phones keep
trusting it), then `node scripts/bootstrap.mjs services` to update Mealie's "Mark cooked" button URL.
