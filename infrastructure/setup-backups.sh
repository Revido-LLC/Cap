#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/cap-backups"
CRON_FILE="/etc/cron.d/cap-backups"
ENV_FILE="${INSTALL_DIR}/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "This script must be run as root." >&2
  exit 1
fi

echo "=== Cap Backup Infrastructure Setup ==="
echo ""

if command -v rclone &>/dev/null; then
  echo "rclone is already installed: $(rclone version | head -1)"
else
  echo "Installing rclone..."
  if command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq rclone
  else
    curl https://rclone.org/install.sh | bash
  fi
  echo "rclone installed: $(rclone version | head -1)"
fi

if command -v mc &>/dev/null; then
  echo "MinIO client (mc) is already installed."
else
  echo "Installing MinIO client..."
  curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
  chmod +x /usr/local/bin/mc
  echo "MinIO client installed."
fi

if command -v jq &>/dev/null; then
  echo "jq is already installed."
else
  echo "Installing jq..."
  apt-get update -qq && apt-get install -y -qq jq
  echo "jq installed."
fi

echo ""
echo "Creating directories..."
mkdir -p "${INSTALL_DIR}/mysql"
mkdir -p "${INSTALL_DIR}/minio-staging"
echo "  ${INSTALL_DIR}/mysql"
echo "  ${INSTALL_DIR}/minio-staging"

echo ""
echo "--- Hetzner Storage Box (SFTP) ---"
read -rp "  Host: " HETZNER_HOST
read -rp "  User: " HETZNER_USER
read -rsp "  Password: " HETZNER_PASS
echo ""

rclone config delete hetzner-box 2>/dev/null || true
rclone config create hetzner-box sftp \
  host "$HETZNER_HOST" \
  user "$HETZNER_USER" \
  pass "$(rclone obscure "$HETZNER_PASS")" \
  shell_type unix
echo "  rclone remote 'hetzner-box' configured."

echo ""
echo "--- Backblaze B2 ---"
read -rp "  Key ID: " B2_KEY_ID
read -rsp "  Application Key: " B2_APP_KEY
echo ""

rclone config delete b2-backup 2>/dev/null || true
rclone config create b2-backup b2 \
  account "$B2_KEY_ID" \
  key "$B2_APP_KEY"
echo "  rclone remote 'b2-backup' configured."

echo ""
echo "--- Local MinIO ---"
read -rp "  Access Key: " MINIO_ACCESS
read -rsp "  Secret Key: " MINIO_SECRET
echo ""

mc alias remove caplocal 2>/dev/null || true
mc alias set caplocal http://localhost:9000 "$MINIO_ACCESS" "$MINIO_SECRET"
echo "  mc alias 'caplocal' configured."

echo ""
echo "--- Slack Alerts ---"
read -rp "  Slack Webhook URL: " SLACK_WEBHOOK

echo ""
echo "--- MySQL Root Password ---"
read -rsp "  MySQL Root Password: " MYSQL_ROOT_PASS
echo ""

cat > "$ENV_FILE" <<ENVEOF
SLACK_ALERT_WEBHOOK_URL=${SLACK_WEBHOOK}
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASS}
ENVEOF
chmod 600 "$ENV_FILE"
echo "  Environment written to ${ENV_FILE}"

echo ""
echo "Copying backup scripts to ${INSTALL_DIR}..."
for script in backup-mysql.sh backup-minio.sh monitor-storage.sh restore-mysql.sh; do
  if [[ -f "${SCRIPT_DIR}/${script}" ]]; then
    cp "${SCRIPT_DIR}/${script}" "${INSTALL_DIR}/${script}"
    chmod +x "${INSTALL_DIR}/${script}"
    echo "  ${script}"
  fi
done

echo ""
echo "Installing cron entries to ${CRON_FILE}..."
cat > "$CRON_FILE" <<'CRONEOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

0 3 * * * root . /opt/cap-backups/.env && /opt/cap-backups/backup-mysql.sh >> /var/log/cap-backup.log 2>&1
0 4 * * * root . /opt/cap-backups/.env && /opt/cap-backups/backup-minio.sh >> /var/log/cap-backup.log 2>&1
0 */6 * * * root . /opt/cap-backups/.env && /opt/cap-backups/monitor-storage.sh >> /var/log/cap-monitor.log 2>&1
CRONEOF
chmod 644 "$CRON_FILE"
echo "  Cron jobs installed."

echo ""
echo "=== Running Verification Tests ==="
echo ""

TESTS_PASSED=0
TESTS_FAILED=0

echo "Testing rclone → hetzner-box..."
if rclone lsd hetzner-box: --max-depth 0 &>/dev/null; then
  echo "  PASS: hetzner-box remote is reachable."
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo "  FAIL: Could not list hetzner-box remote."
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo "Testing rclone → b2-backup..."
if rclone lsd b2-backup: --max-depth 0 &>/dev/null; then
  echo "  PASS: b2-backup remote is reachable."
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo "  FAIL: Could not list b2-backup remote."
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo "Testing mc → caplocal/cap bucket..."
if mc ls caplocal/cap &>/dev/null; then
  echo "  PASS: caplocal/cap bucket is accessible."
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo "  FAIL: Could not list caplocal/cap bucket."
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo ""
echo "=== Setup Summary ==="
echo ""
echo "  Install directory:   ${INSTALL_DIR}"
echo "  Environment file:    ${ENV_FILE}"
echo "  Cron file:           ${CRON_FILE}"
echo "  Rclone remotes:      hetzner-box (sftp), b2-backup (b2)"
echo "  MinIO alias:         caplocal → http://localhost:9000"
echo ""
echo "  Cron schedule:"
echo "    Daily 03:00  — MySQL backup"
echo "    Daily 04:00  — MinIO backup"
echo "    Every 6h     — Storage monitoring"
echo ""
echo "  Tests passed: ${TESTS_PASSED}/3"
if [[ "$TESTS_FAILED" -gt 0 ]]; then
  echo "  Tests failed: ${TESTS_FAILED}/3 — review the output above."
fi
echo ""
echo "  Scripts installed:"
for script in backup-mysql.sh backup-minio.sh monitor-storage.sh restore-mysql.sh; do
  if [[ -f "${INSTALL_DIR}/${script}" ]]; then
    echo "    ${INSTALL_DIR}/${script}"
  fi
done
echo ""
echo "Setup complete."
