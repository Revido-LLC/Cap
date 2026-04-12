#!/usr/bin/env bash
set -euo pipefail

MC_ALIAS="${MC_ALIAS:-caplocal}"
MC_BUCKET="${MC_BUCKET:-cap}"
RCLONE_PRIMARY="${RCLONE_PRIMARY:-hetzner-box:cap-backups/minio}"
RCLONE_OFFSITE="${RCLONE_OFFSITE:-b2-backup:cap-backups/minio}"
LOG_FILE="${LOG_FILE:-/var/log/cap-backup.log}"
SLACK_WEBHOOK="${SLACK_ALERT_WEBHOOK_URL:-}"
MINIO_MIRROR_DIR="${MINIO_MIRROR_DIR:-/opt/cap-backups/minio-staging}"

DAY_OF_WEEK=$(date +%u)

log() { echo "[$(date -Iseconds)] MINIO-BACKUP: $*" | tee -a "$LOG_FILE"; }
alert_slack() {
  if [[ -n "$SLACK_WEBHOOK" ]]; then
    curl -s --connect-timeout 10 --max-time 15 -X POST "$SLACK_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"$1\"}" > /dev/null 2>&1 || true
  fi
}

cleanup_on_error() {
  log "ERROR: MinIO backup failed"
  alert_slack ":x: *Cap MinIO Backup Failed* ($(hostname))\n$(tail -5 "$LOG_FILE")"
  exit 1
}
trap cleanup_on_error ERR

BUCKET_SIZE=$(mc du "${MC_ALIAS}/${MC_BUCKET}" --json 2>/dev/null | jq -r '.prefix // "unknown"' 2>/dev/null || echo "unknown")
log "Starting MinIO backup (bucket size: ${BUCKET_SIZE})"

log "Mirroring to primary (Hetzner Storage Box) via staging dir..."
mkdir -p "$MINIO_MIRROR_DIR"
mc mirror --overwrite --remove "${MC_ALIAS}/${MC_BUCKET}" "$MINIO_MIRROR_DIR" 2>>"$LOG_FILE" || true
rclone sync "$MINIO_MIRROR_DIR" "$RCLONE_PRIMARY" --log-file="$LOG_FILE" --log-level=INFO

if [[ "$DAY_OF_WEEK" -eq 7 ]]; then
  log "Sunday — syncing to off-site (Backblaze B2)..."
  rclone sync "$MINIO_MIRROR_DIR" "$RCLONE_OFFSITE" --log-file="$LOG_FILE" --log-level=INFO
fi

log "MinIO backup complete"
alert_slack ":white_check_mark: *Cap MinIO Backup OK* — bucket: ${MC_BUCKET}"
