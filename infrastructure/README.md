# Infrastructure

Scripts for the Revido self-hosted Cap deployment (Infisical → Coolify secret sync).

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
