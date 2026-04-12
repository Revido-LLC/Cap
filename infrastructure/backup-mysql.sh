#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/cap-backups/mysql}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-mysql-ls45v38pyyqi74mdl8w0bw2a}"
RCLONE_PRIMARY="${RCLONE_PRIMARY:-hetzner-box:cap-backups/mysql}"
RCLONE_OFFSITE="${RCLONE_OFFSITE:-b2-backup:cap-backups/mysql}"
LOG_FILE="${LOG_FILE:-/var/log/cap-backup.log}"
SLACK_WEBHOOK="${SLACK_ALERT_WEBHOOK_URL:-}"
RETENTION_DAILY=7
RETENTION_WEEKLY=4

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DAY_OF_WEEK=$(date +%u)
FILENAME="cap-mysql-${TIMESTAMP}.sql.gz"

log() { echo "[$(date -Iseconds)] MYSQL-BACKUP: $*" | tee -a "$LOG_FILE"; }
alert_slack() {
  if [[ -n "$SLACK_WEBHOOK" ]]; then
    curl -s --connect-timeout 10 --max-time 15 -X POST "$SLACK_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"$1\"}" > /dev/null 2>&1 || true
  fi
}

cleanup_on_error() {
  rm -f "${BACKUP_DIR}/${FILENAME}"
  log "ERROR: Backup failed"
  alert_slack ":x: *Cap MySQL Backup Failed* ($(hostname))\n$(tail -5 "$LOG_FILE")"
  exit 1
}
trap cleanup_on_error ERR

mkdir -p "$BACKUP_DIR"

log "Starting MySQL backup → ${FILENAME}"

docker exec "$MYSQL_CONTAINER" mysqldump \
  -u root \
  -p"${MYSQL_ROOT_PASSWORD}" \
  --single-transaction \
  --routines \
  --triggers \
  --databases cap \
  2>/dev/null | gzip > "${BACKUP_DIR}/${FILENAME}"

FILESIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
log "Dump complete: ${FILENAME} (${FILESIZE})"

log "Uploading to primary (Hetzner Storage Box)..."
rclone copy "${BACKUP_DIR}/${FILENAME}" "$RCLONE_PRIMARY" --log-file="$LOG_FILE" --log-level=INFO

if [[ "$DAY_OF_WEEK" -eq 7 ]]; then
  log "Sunday — uploading to off-site (Backblaze B2)..."
  rclone copy "${BACKUP_DIR}/${FILENAME}" "$RCLONE_OFFSITE" --log-file="$LOG_FILE" --log-level=INFO
fi

log "Pruning local backups older than ${RETENTION_DAILY} days..."
find "$BACKUP_DIR" -name "cap-mysql-*.sql.gz" -mtime +"$RETENTION_DAILY" -delete 2>/dev/null || true

log "Pruning remote backups..."
rclone delete "$RCLONE_PRIMARY" --min-age "${RETENTION_WEEKLY}w" --log-file="$LOG_FILE" --log-level=INFO 2>/dev/null || true

log "MySQL backup complete: ${FILENAME} (${FILESIZE})"
alert_slack ":white_check_mark: *Cap MySQL Backup OK* — ${FILENAME} (${FILESIZE})"
