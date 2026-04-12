# Infrastructure

Scripts for the Revido self-hosted Cap deployment. Covers secret sync, automated backups, monitoring, and operational runbooks.

## Sync Secrets

`sync-secrets.sh` reads secrets from Infisical and pushes them to Coolify's service-level env var store. The compose file handles routing secrets to the right containers (e.g., `MINIO_ROOT_USER` becomes both the MinIO credential and `CAP_AWS_ACCESS_KEY` for cap-web).

Keys prefixed with `COOLIFY_` are skipped (meta vars used by the sync infrastructure itself).

### Via GitHub Action (recommended)

Go to **Actions → "Sync Secrets (Infisical → Coolify)" → Run workflow**. Choose the environment, whether to restart, and whether to dry-run.

### Local usage

```bash
export INFISICAL_TOKEN="..."
export INFISICAL_API_URL="https://infisical.revido.co/api"
export INFISICAL_PROJECT_ID="63361c35-8075-49d3-b3b6-1d4ff4b31517"
export INFISICAL_ENVIRONMENT="prod"
export COOLIFY_API_TOKEN="..."
export COOLIFY_API_URL="https://coolify.revido.co"
export COOLIFY_SERVICE_UUID="ls45v38pyyqi74mdl8w0bw2a"

./infrastructure/sync-secrets.sh --dry-run   # preview only
./infrastructure/sync-secrets.sh             # push secrets
./infrastructure/sync-secrets.sh --restart   # push + restart service
```

### Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Print which secrets would be pushed, without pushing |
| `--restart` | Restart the Coolify service after syncing |

### Prerequisites

- [Infisical CLI](https://infisical.com/docs/cli/overview) (`infisical export`)
- `curl` and `jq`
- Valid Infisical access token (obtain via Universal Auth or `infisical login`)
- Coolify API bearer token

### GitHub Secrets Required

| Secret | Purpose |
|--------|---------|
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | Machine identity client ID for Infisical Universal Auth |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | Machine identity client secret for Infisical Universal Auth |
| `COOLIFY_API_TOKEN` | Bearer token for Coolify REST API |

### Verifying secrets reached the container

```bash
ssh root@178.104.68.218 "docker exec cap-web env | grep -E 'CAP_ALLOWED_SIGNUP_DOMAINS|DEEPGRAM|ANTHROPIC'"
```

### How Coolify env vars work

Compose-referenced vars (e.g., `MYSQL_PASSWORD` used as `${MYSQL_PASSWORD:-changeme}`) are substituted during compose regeneration. Non-compose vars (e.g., `CAP_ALLOWED_SIGNUP_DOMAINS`) are injected directly into containers by Coolify. Both persist across restarts when stored in Coolify's service-level env var store.

---

## Automated Backups

Dual-target backup strategy: **Hetzner Storage Box** (daily, fast, same DC) + **Backblaze B2** (weekly, off-provider safety).

### First-time setup

```bash
ssh root@178.104.68.218
bash /path/to/infrastructure/setup-backups.sh
```

The setup script installs `rclone` and `mc`, configures remotes, and installs cron jobs. It prompts for credentials interactively.

### What gets backed up

| Data | Script | Schedule | Primary | Off-site |
|------|--------|----------|---------|----------|
| MySQL (metadata, users, videos) | `backup-mysql.sh` | Daily 3am | Hetzner Box | B2 (Sundays) |
| MinIO (video/audio files) | `backup-minio.sh` | Daily 4am | Hetzner Box | B2 (Sundays) |

### Restoring from backup

**MySQL:**
```bash
./infrastructure/restore-mysql.sh latest          # latest local backup
./infrastructure/restore-mysql.sh remote           # download latest from Hetzner Box
./infrastructure/restore-mysql.sh /path/to/file.sql.gz  # specific file
```

The restore script prompts for confirmation before overwriting the database.

**MinIO:**
```bash
rclone sync hetzner-box:cap-backups/minio /opt/cap-backups/minio-staging
mc mirror /opt/cap-backups/minio-staging caplocal/cap --overwrite
```

### Backup logs

All backup activity logs to `/var/log/cap-backup.log`. Failed backups post alerts to Slack.

### Infisical secrets required for backups

| Key | Purpose |
|-----|---------|
| `HETZNER_STORAGE_BOX_URL` | SFTP endpoint for Hetzner Storage Box |
| `HETZNER_STORAGE_BOX_USER` | Storage Box username |
| `HETZNER_STORAGE_BOX_PASSWORD` | Storage Box password |
| `B2_KEY_ID` | Backblaze B2 application key ID |
| `B2_APPLICATION_KEY` | Backblaze B2 application key |
| `SLACK_ALERT_WEBHOOK_URL` | Slack incoming webhook for alerts |

---

## Storage Monitoring

`monitor-storage.sh` runs every 6 hours via cron and checks disk usage.

| Threshold | Action |
|-----------|--------|
| ≤ 70% | Log only, no alert |
| > 70% | Warning posted to Slack |
| > 85% | Critical alert posted to Slack |

Logs to `/var/log/cap-monitor.log`.

---

## Loom Migration Guide

Cap has a Loom import API but it requires the Effect workflow service not included in self-hosted. Use the manual approach below.

### For each team member

1. Go to **Loom → Settings → My Videos → Request Export**
2. Loom emails a download link with all videos as MP4s
3. Open the Cap desktop app (server URL: `https://cap.revido.co`)
4. Upload each MP4 through the app

### For individual shared Loom videos

1. Copy the Loom share URL
2. Go to `https://cap.revido.co/tools/loom-downloader`
3. Paste the URL and download the MP4
4. Upload via the Cap desktop app

### What to tell the team

> Old Loom videos will stay accessible on Loom (read-only). All new recordings should go through Cap. If you need a specific old Loom video in Cap, download it from Loom and upload it via the Cap app.

---

## Server Upgrade Path

Current server: Hetzner CX33 (4 CPU, 8GB RAM, 80GB disk).

### When disk hits 70% (~55GB used)

Attach a **Hetzner Volume** for MinIO data:

1. Create a volume in Hetzner Cloud console (start with 100GB, expandable to 10TB)
2. Mount it on the server (e.g., `/mnt/cap-storage`)
3. Stop the Cap service
4. Move MinIO data: `mv /var/lib/docker/volumes/ls45v38pyyqi74mdl8w0bw2a_cap-minio-data/_data/* /mnt/cap-storage/`
5. Update Docker volume or bind mount to point to `/mnt/cap-storage`
6. Start the Cap service

Cost: ~€4.40/mo per 100GB.

### When CPU/RAM becomes a bottleneck

Upgrade the server in Hetzner Cloud console:

| Plan | CPU | RAM | Disk | Price |
|------|-----|-----|------|-------|
| CX33 (current) | 4 | 8GB | 80GB | ~€13/mo |
| CX41 | 8 | 16GB | 160GB | ~€22/mo |
| CX51 | 16 | 32GB | 240GB | ~€40/mo |

Hetzner supports in-place rescaling with a brief reboot (~2 min downtime).
