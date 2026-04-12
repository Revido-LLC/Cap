#!/usr/bin/env bash
set -euo pipefail

SLACK_WEBHOOK="${SLACK_ALERT_WEBHOOK_URL:-}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-mysql-ls45v38pyyqi74mdl8w0bw2a}"
MC_ALIAS="${MC_ALIAS:-caplocal}"
MC_BUCKET="${MC_BUCKET:-cap}"
LOG_FILE="${LOG_FILE:-/var/log/cap-monitor.log}"
WARN_THRESHOLD=70
CRIT_THRESHOLD=85
HOSTNAME_LABEL="cap.revido.co"

log() { echo "[$(date -Iseconds)] STORAGE-MONITOR: $*" | tee -a "$LOG_FILE"; }

alert_slack() {
  if [[ -n "$SLACK_WEBHOOK" ]]; then
    curl -s --connect-timeout 10 --max-time 15 -X POST "$SLACK_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"$1\"}" > /dev/null 2>&1 || true
  fi
}

DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
DISK_USED=$(df -h / | awk 'NR==2 {print $3}')
DISK_TOTAL=$(df -h / | awk 'NR==2 {print $2}')

MINIO_SIZE=$(mc du "${MC_ALIAS}/${MC_BUCKET}" --json 2>/dev/null \
  | jq -r '
      if .status == "success" then
        (.size / 1073741824 * 10 | floor / 10 | tostring) + "GB"
      else "unknown"
      end
    ' 2>/dev/null || echo "unknown")

MYSQL_SIZE=$(docker exec "$MYSQL_CONTAINER" \
  mysql -u root -p"${MYSQL_ROOT_PASSWORD}" -N -e \
  "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 1) FROM information_schema.tables WHERE table_schema='cap'" \
  2>/dev/null | tr -d '[:space:]' || echo "unknown")
if [[ -n "$MYSQL_SIZE" && "$MYSQL_SIZE" != "unknown" && "$MYSQL_SIZE" != "NULL" ]]; then
  MYSQL_SIZE="${MYSQL_SIZE}MB"
else
  MYSQL_SIZE="unknown"
fi

log "Disk: ${DISK_PCT}% used (${DISK_USED} / ${DISK_TOTAL}) | MinIO: ${MINIO_SIZE} | MySQL: ${MYSQL_SIZE}"

if [[ "$DISK_PCT" -ge "$CRIT_THRESHOLD" ]]; then
  MSG="🚨 Cap Storage CRITICAL (${HOSTNAME_LABEL})\nDisk: ${DISK_PCT}% used (${DISK_USED} / ${DISK_TOTAL})\nMinIO: ${MINIO_SIZE}\nMySQL: ${MYSQL_SIZE}\nAction: Immediate attention needed — disk nearly full"
  log "CRITICAL: Disk at ${DISK_PCT}% — sending alert"
  alert_slack "$MSG"
elif [[ "$DISK_PCT" -ge "$WARN_THRESHOLD" ]]; then
  MSG="⚠️ Cap Storage Warning (${HOSTNAME_LABEL})\nDisk: ${DISK_PCT}% used (${DISK_USED} / ${DISK_TOTAL})\nMinIO: ${MINIO_SIZE}\nMySQL: ${MYSQL_SIZE}\nAction: Consider attaching a Hetzner Volume"
  log "WARNING: Disk at ${DISK_PCT}% — sending alert"
  alert_slack "$MSG"
else
  log "OK: Disk at ${DISK_PCT}% — no alert needed"
fi
