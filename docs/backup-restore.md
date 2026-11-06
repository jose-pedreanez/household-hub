# Backup and restore

## What is persistent

| Volume | Contents |
|---|---|
| `grocy-config` | Grocy SQLite database (all stock), product pictures, config |
| `mealie-data` | Mealie SQLite database (recipes, plans, lists), images |
| `gms-data` | Grocy-Mealie Sync database (mappings, history) |
| `n8n-data` | n8n database (workflows, encrypted credentials, executions) |
| `hub-data` | `hub.db`: scan and cooking journals, idempotency keys, metadata, annotations |
| `caddy-data` | Caddy's local CA and certificates (phones trust this CA) |

Plus `.env` (secrets) and `config/*.yaml` (preferences). Logs are Docker json-file logs, rotated at
5 × 10 MB per service, and are not backed up.

## Backup

```bash
scripts/backup.sh                     # → backups/<timestamp>/
scripts/backup.sh /mnt/nas/household  # → /mnt/nas/household/<timestamp>/
```

The stack is stopped during the copy (usually well under a minute) so no SQLite file is mid-write, then
restarted. Each volume becomes `<volume>.tgz`, with `SHA256SUMS`, a `MANIFEST` (date, project, image
versions), `config/` and `env.backup`. The directory is created with mode 700 — it contains secrets.

Suggested cron (on the host):

```cron
30 3 * * * cd /home/josep/projects/household-hub && scripts/backup.sh /mnt/backup/household-hub >> /tmp/hub-backup.log 2>&1
```

Keep a few generations and copy one off the machine.

## Restore

```bash
scripts/restore.sh backups/<timestamp>        # verifies checksums, asks you to type "restore"
scripts/smoke.sh
```

Restore replaces the contents of every volume in the backup. It keeps an existing `.env` (the backup's copy
is `env.backup`); on a new machine copy it over first. The hub, Grocy and Mealie must be restored from
the **same** backup: the hub's cooking journal refers to Grocy transaction ids.

## Verifying persistence

`scripts/smoke.sh --restart` records inventory, recipes, the scan journal and the cooking journal, runs
`docker compose down` + `up -d`, and checks they are identical.
