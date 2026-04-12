#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/cap-backups/mysql}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-mysql-ls45v38pyyqi74mdl8w0bw2a}"
RCLONE_PRIMARY="${RCLONE_PRIMARY:-hetzner-box:cap-backups/mysql}"
RCLONE_OFFSITE="${RCLONE_OFFSITE:-b2-backup:cap-backups/mysql}"
LOG_FILE="${LOG_FILE:-/var/log/cap-backup.log}"

log() { echo "[$(date -Iseconds)] MYSQL-RESTORE: $*" | tee -a "$LOG_FILE"; }

BACKUP_FILE="${1:-}"

if [[ -z "$BACKUP_FILE" ]]; then
  echo "Usage: $0 <backup-file.sql.gz | latest>"
  echo ""
  echo "Examples:"
  echo "  $0 latest                                    # restore most recent local backup"
  echo "  $0 /opt/cap-backups/mysql/cap-mysql-20260412.sql.gz  # restore specific file"
  echo "  $0 remote                                    # download latest from Hetzner Box, then restore"
  exit 1
fi

if [[ "$BACKUP_FILE" == "latest" ]]; then
  BACKUP_FILE=$(ls -t "${BACKUP_DIR}"/cap-mysql-*.sql.gz 2>/dev/null | head -1)
  if [[ -z "$BACKUP_FILE" ]]; then
    log "ERROR: No local backups found in ${BACKUP_DIR}"
    exit 1
  fi
  log "Using latest local backup: ${BACKUP_FILE}"
fi

if [[ "$BACKUP_FILE" == "remote" ]]; then
  log "Downloading latest backup from Hetzner Storage Box..."
  mkdir -p "$BACKUP_DIR"

  REMOTE_FILE=$(rclone lsf "$RCLONE_PRIMARY" --files-only | sort -r | head -1)
  if [[ -z "$REMOTE_FILE" ]]; then
    log "No backups on primary, trying off-site (B2)..."
    REMOTE_FILE=$(rclone lsf "$RCLONE_OFFSITE" --files-only | sort -r | head -1)
    if [[ -z "$REMOTE_FILE" ]]; then
      log "ERROR: No remote backups found"
      exit 1
    fi
    rclone copy "${RCLONE_OFFSITE}/${REMOTE_FILE}" "$BACKUP_DIR" --log-level=INFO
  else
    rclone copy "${RCLONE_PRIMARY}/${REMOTE_FILE}" "$BACKUP_DIR" --log-level=INFO
  fi

  BACKUP_FILE="${BACKUP_DIR}/${REMOTE_FILE}"
  log "Downloaded: ${BACKUP_FILE}"
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  log "ERROR: File not found: ${BACKUP_FILE}"
  exit 1
fi

FILESIZE=$(du -h "$BACKUP_FILE" | cut -f1)
log "Restoring from: ${BACKUP_FILE} (${FILESIZE})"

echo ""
echo "WARNING: This will REPLACE all data in the 'cap' database."
echo "File: ${BACKUP_FILE} (${FILESIZE})"
echo ""
read -r -p "Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

log "Restoring database..."
gunzip -c "$BACKUP_FILE" | docker exec -i "$MYSQL_CONTAINER" mysql \
  -u root \
  -p"${MYSQL_ROOT_PASSWORD}" \
  2>/dev/null

TABLE_COUNT=$(docker exec "$MYSQL_CONTAINER" mysql \
  -u root \
  -p"${MYSQL_ROOT_PASSWORD}" \
  -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='cap'" \
  2>/dev/null)

log "Restore complete. Tables in 'cap' database: ${TABLE_COUNT}"
