# Local deployment (WSL2)

## Prerequisites

- WSL2 with `networkingMode=mirrored` (in `%UserProfile%\.wslconfig`) so phones can reach WSL on the
  Windows LAN address. This machine already has it.
- Docker Engine reachable **without sudo**. On this machine two daemons were installed (snap `docker` and
  apt `docker.io`) and both bind `/var/run/docker.sock`. Keep apt docker.io:

  ```bash
  sudo snap stop --disable docker          # snap daemon off (its data stays on disk)
  sudo usermod -aG docker "$USER"          # docker without sudo
  sudo systemctl restart docker.socket docker
  newgrp docker                            # or open a new WSL terminal
  docker version && docker compose version
  ```

- Node 24 on the host for the bootstrap/seed scripts (optional: `bootstrap.sh` falls back to the pinned
  Node container).

## First start

```bash
cd ~/projects/household-hub
scripts/bootstrap.sh          # .env secrets → Grocy/Mealie credentials → full stack → n8n workflows
node scripts/seed-demo.mjs    # optional demo kitchen (products, barcodes, recipes, plan)
scripts/smoke.sh              # health, connectivity, HTTPS, exposure, no leaked secrets
```

`bootstrap.sh` is safe to re-run. It never prints secrets; the household password is `HUB_PASSWORD` in
`.env` (mode 600).

Open the n8n UI once (http://localhost:5678), create the owner account, and check that the five
“Household Hub · …” workflows are active (the receipt template stays inactive). To get push notifications
on phones, open a workflow, enable the disabled *Send push notification* node and put in your own ntfy
topic (or swap it for Email/Slack). Notifications are always also in the hub (Settings → Notifications).

## Phone access (HTTPS)

Browsers only allow the camera on HTTPS (or localhost). Caddy serves the hub on
`https://<HUB_HOSTNAME>` with a certificate from its own local CA.

1. **Allow inbound traffic to WSL** (PowerShell as Administrator, once). In mirrored mode inbound traffic
   is filtered by the Hyper-V firewall; this follows Microsoft's WSL networking documentation:

   ```powershell
   New-NetFirewallHyperVRule -Name HouseholdHub -DisplayName "Household Hub (WSL)" -Direction Inbound `
     -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 80,443,9443
   ```

2. **Trust the hub's certificate on each phone** — open `http://<HUB_HOSTNAME>/ca.crt` on the phone:
   - iPhone: install the profile (Settings → General → VPN & Device Management), then enable it under
     Settings → General → About → Certificate Trust Settings.
   - Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
3. Open `https://<HUB_HOSTNAME>`, sign in, and *Add to Home Screen* (installs the PWA).

`HUB_HOSTNAME` is the LAN IP by default. Give the PC a DHCP reservation in the router so it doesn't
change; if it does, update `HUB_HOSTNAME`, `PUBLIC_BASE_URL`, `MEALIE_PUBLIC_URL` and run
`docker compose up -d caddy hub mealie` (the CA stays the same, so phones keep trusting it).

**Alternative without installing a CA:** Tailscale with `tailscale serve` gives a publicly trusted
certificate on a tailnet name. That needs a Tailscale account, so it is not set up by default.

## Everyday commands

```bash
docker compose ps                        # status and health
docker compose logs -f hub               # hub logs (also: grocy, mealie, gms, n8n, caddy)
docker compose restart hub
docker compose down                      # stop (data is kept in named volumes)
docker compose up -d                     # start
scripts/backup.sh                        # see docs/backup-restore.md
```

Admin UIs (this PC only): Grocy http://localhost:9283 (admin / `GROCY_ADMIN_PASSWORD`),
Mealie https://<HUB_HOSTNAME>:9443 or http://localhost:9925, Grocy-Mealie Sync http://localhost:3001
(`GMS_AUTH_SECRET`), n8n http://localhost:5678. The household never needs Grocy's UI.

## Development mode

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d   # everything except the hub container
cd apps/web
set -a; source ../../.env; set +a
export GROCY_URL=http://127.0.0.1:9283 MEALIE_URL=http://127.0.0.1:9925 GMS_URL=http://127.0.0.1:3001
npm run dev                                                 # http://localhost:3000 (camera works on localhost)
```

Caddy then proxies `https://<HUB_HOSTNAME>` to the dev server, so phones can test `/scan` too.

## Upgrading

Images are pinned in `compose.yaml`. Upgrade one service at a time: back up, change the tag, read the
project's release notes (Mealie and Grocy migrate their databases on start), `docker compose up -d
<service>`, then `scripts/smoke.sh` and `npm run test:integration`. Keep Grocy-Mealie Sync on a stable
tag (no `-rc`). Rebuild the hub with `docker compose build hub && docker compose up -d hub`.
