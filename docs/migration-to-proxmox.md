# Migrating to Proxmox

The stack is plain Docker Compose with named volumes, so moving it is: back up → copy → restore → re-point
phones. No code or configuration changes are needed beyond the hostname.

## 1. Prepare the VM

- A Debian 12/13 or Ubuntu 24.04 VM (2 vCPU, 4 GB RAM, 20 GB disk is plenty), x86-64 or arm64.
- Install Docker Engine and the Compose plugin from Docker's repository; add your user to `docker`.
- Give the VM a fixed LAN address (DHCP reservation), e.g. `192.168.1.50`. Optionally a local DNS name
  such as `hub.home.arpa` in your router.

## 2. Back up on WSL

```bash
cd ~/projects/household-hub
scripts/backup.sh                # stops the stack briefly; writes backups/<timestamp>/
```

The backup holds every volume (Grocy, Mealie, Grocy-Mealie Sync, n8n, hub, Caddy's CA), `config/`, and
`.env` as `env.backup` (secrets — including `N8N_ENCRYPTION_KEY`, without which n8n credentials cannot be
decrypted).

## 3. Copy

```bash
# from WSL
rsync -a --exclude node_modules --exclude .next --exclude backups ~/projects/household-hub/ vm:~/household-hub/
rsync -a ~/projects/household-hub/backups/<timestamp>/ vm:~/household-hub/backups/<timestamp>/
```

(Or clone the git repository on the VM and copy only `backups/<timestamp>/`.)

## 4. Restore on the VM

```bash
cd ~/household-hub
cp backups/<timestamp>/env.backup .env && chmod 600 .env
# point the household at the VM
sed -i 's/^HUB_HOSTNAME=.*/HUB_HOSTNAME=192.168.1.50/; s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://192.168.1.50#; s#^MEALIE_PUBLIC_URL=.*#MEALIE_PUBLIC_URL=https://192.168.1.50:9443#' .env
docker compose pull && docker compose build hub
scripts/restore.sh backups/<timestamp>         # asks you to type "restore"
scripts/smoke.sh --restart
```

Because Caddy's data volume (with its CA) is restored too, phones that already trust the old certificate
keep trusting the new address; just open `https://<new address>` and re-add it to the home screen.

Update the Mealie Recipe Action URL to the new address: re-run `node scripts/bootstrap.mjs services`
(it updates the action when `PUBLIC_BASE_URL` changed).

## 5. Decommission WSL

After a few days of normal use on the VM: `docker compose down` on WSL (keep the last backup). Don't run
both stacks against the same household at once — two hubs would book scans into two Grocy databases.

## Proxmox-specific notes

- Use a VM rather than an LXC container for Docker unless you're comfortable with nesting/keyctl settings.
- Schedule `scripts/backup.sh /mnt/backup/household-hub` with cron (e.g. nightly 03:30) and back up the VM
  with Proxmox Backup Server as a second layer.
- Without WSL there's no Hyper-V firewall step; open 80/443/9443 on the VM firewall only to the LAN.
