#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SCRIPT="$SCRIPT_DIR/backup-mysql.sh"
MOCK_DIR=$(mktemp -d)
TEMP_DIR=$(mktemp -d)
PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "$MOCK_DIR" "$TEMP_DIR"; }
trap cleanup EXIT

BASE_ENV=(
  "MYSQL_ROOT_PASSWORD=test-root-pw"
  "BACKUP_DIR=$TEMP_DIR/backups"
  "MYSQL_CONTAINER=test-mysql-container"
  "RCLONE_PRIMARY=mock-primary:cap-backups/mysql"
  "RCLONE_OFFSITE=mock-offsite:cap-backups/mysql"
  "LOG_FILE=$TEMP_DIR/backup.log"
  "SLACK_ALERT_WEBHOOK_URL=https://hooks.slack.mock/test"
  "MOCK_DIR=$MOCK_DIR"
)

create_docker_mock() {
  local exit_code="${1:-0}"
  cat > "$MOCK_DIR/docker" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/docker_calls.log"
if echo "\$@" | grep -q "mysqldump"; then
  if [[ "$exit_code" -ne 0 ]]; then
    exit $exit_code
  fi
  echo "-- MySQL dump mock output"
  echo "CREATE DATABASE cap;"
  echo "INSERT INTO videos VALUES (1);"
fi
MOCK
  chmod +x "$MOCK_DIR/docker"
}

create_rclone_mock() {
  cat > "$MOCK_DIR/rclone" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/rclone_calls.log"
MOCK
  chmod +x "$MOCK_DIR/rclone"
}

create_curl_mock() {
  cat > "$MOCK_DIR/curl" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/curl_calls.log"
MOCK
  chmod +x "$MOCK_DIR/curl"
}

create_date_mock() {
  local day_of_week="${1:-1}"
  cat > "$MOCK_DIR/date" << MOCK
#!/usr/bin/env bash
if [[ "\$1" == "+%Y%m%d-%H%M%S" ]]; then
  echo "20260412-120000"
elif [[ "\$1" == "+%u" ]]; then
  echo "$day_of_week"
elif [[ "\$1" == "-Iseconds" ]]; then
  echo "2026-04-12T12:00:00+00:00"
else
  /bin/date "\$@"
fi
MOCK
  chmod +x "$MOCK_DIR/date"
}

create_find_mock() {
  cat > "$MOCK_DIR/find" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/find_calls.log"
MOCK
  chmod +x "$MOCK_DIR/find"
}

create_du_mock() {
  cat > "$MOCK_DIR/du" << MOCK
#!/usr/bin/env bash
echo "42M\t\$2"
MOCK
  chmod +x "$MOCK_DIR/du"
}

create_hostname_mock() {
  cat > "$MOCK_DIR/hostname" << MOCK
#!/usr/bin/env bash
echo "test-host"
MOCK
  chmod +x "$MOCK_DIR/hostname"
}

create_all_mocks() {
  local day_of_week="${1:-1}"
  local docker_exit="${2:-0}"
  rm -f "$MOCK_DIR"/*.log
  rm -rf "$TEMP_DIR/backups"
  mkdir -p "$TEMP_DIR/backups"
  : > "$TEMP_DIR/backup.log"
  create_docker_mock "$docker_exit"
  create_rclone_mock
  create_curl_mock
  create_date_mock "$day_of_week"
  create_find_mock
  create_du_mock
  create_hostname_mock
}

run_script() {
  env -i "${BASE_ENV[@]}" \
    PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" \
    HOME="$HOME" \
    bash "$BACKUP_SCRIPT" 2>&1 && return 0 || return $?
}

assert_pass() {
  local desc="$1"
  echo "  PASS  $desc"
  PASS_COUNT=$((PASS_COUNT + 1))
}

assert_fail() {
  local desc="$1" detail="${2:-}"
  echo "  FAIL  $desc${detail:+ ($detail)}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_exit_code() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "expected exit $expected, got $actual"
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "output missing '$needle'"
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    assert_fail "$desc" "output unexpectedly contains '$needle'"
  else
    assert_pass "$desc"
  fi
}

assert_file_contains() {
  local desc="$1" needle="$2" file="$3"
  if [[ -f "$file" ]] && grep -q "$needle" "$file"; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "file missing '$needle'"
  fi
}

echo "=== backup-mysql.sh tests ==="
echo ""

echo "--- Missing MYSQL_ROOT_PASSWORD ---"
create_all_mocks

no_pw_env=()
for e in "${BASE_ENV[@]}"; do
  if [[ "$e" != "MYSQL_ROOT_PASSWORD="* ]]; then
    no_pw_env+=("$e")
  fi
done

output=$(env -i "${no_pw_env[@]}" \
  PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" \
  HOME="$HOME" \
  bash "$BACKUP_SCRIPT" 2>&1) && ec=0 || ec=$?
if [[ "$ec" -ne 0 ]]; then
  assert_pass "exits non-zero when MYSQL_ROOT_PASSWORD is unset"
else
  assert_fail "exits non-zero when MYSQL_ROOT_PASSWORD is unset" "got exit 0"
fi
assert_contains "mentions MYSQL_ROOT_PASSWORD in error" "MYSQL_ROOT_PASSWORD" "$output"
echo ""

echo "--- Successful backup ---"
create_all_mocks 1

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 on successful backup" "0" "$ec"

backup_file="$TEMP_DIR/backups/cap-mysql-20260412-120000.sql.gz"
if [[ -f "$backup_file" ]]; then
  assert_pass "creates .sql.gz backup file"
else
  assert_fail "creates .sql.gz backup file" "file not found at $backup_file"
fi

assert_file_contains "docker exec calls mysqldump" "mysqldump" "$MOCK_DIR/docker_calls.log"
assert_file_contains "rclone called for primary upload" "mock-primary:cap-backups/mysql" "$MOCK_DIR/rclone_calls.log"
assert_contains "logs success message" "MySQL backup complete" "$output"
assert_file_contains "posts Slack OK notification" "Backup OK" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Sunday triggers B2 upload ---"
create_all_mocks 7

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 on Sunday backup" "0" "$ec"

primary_count=$(grep -c "mock-primary" "$MOCK_DIR/rclone_calls.log" 2>/dev/null || echo "0")
offsite_count=$(grep -c "mock-offsite" "$MOCK_DIR/rclone_calls.log" 2>/dev/null || echo "0")

if [[ "$primary_count" -ge 1 ]]; then
  assert_pass "rclone called for primary on Sunday"
else
  assert_fail "rclone called for primary on Sunday" "got $primary_count primary calls"
fi

if [[ "$offsite_count" -ge 1 ]]; then
  assert_pass "rclone called for offsite (B2) on Sunday"
else
  assert_fail "rclone called for offsite (B2) on Sunday" "got $offsite_count offsite calls"
fi

assert_contains "logs Sunday offsite message" "Sunday" "$output"
echo ""

echo "--- Non-Sunday skips B2 ---"
create_all_mocks 3

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 on non-Sunday backup" "0" "$ec"

assert_file_contains "rclone called for primary on Wednesday" "mock-primary" "$MOCK_DIR/rclone_calls.log"

if [[ -f "$MOCK_DIR/rclone_calls.log" ]] && grep -q "mock-offsite:cap-backups/mysql" "$MOCK_DIR/rclone_calls.log"; then
  offsite_copy_count=$(grep "copy.*mock-offsite" "$MOCK_DIR/rclone_calls.log" | grep -v "delete" | wc -l | tr -d ' ')
  if [[ "$offsite_copy_count" -gt 0 ]]; then
    assert_fail "skips B2 offsite upload on non-Sunday" "offsite copy was called"
  else
    assert_pass "skips B2 offsite upload on non-Sunday"
  fi
else
  assert_pass "skips B2 offsite upload on non-Sunday"
fi

assert_not_contains "no Sunday log message on Wednesday" "Sunday" "$output"
echo ""

echo "--- Slack alert on failure ---"
create_all_mocks 1 1

output=$(run_script) && ec=0 || ec=$?
if [[ "$ec" -ne 0 ]]; then
  assert_pass "exits non-zero when docker exec fails"
else
  assert_fail "exits non-zero when docker exec fails" "got exit 0"
fi

assert_file_contains "Slack webhook called on failure" "Backup Failed" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Pruning ---"
create_all_mocks 1

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 for pruning test" "0" "$ec"

assert_file_contains "find called with -delete for local pruning" "delete" "$MOCK_DIR/find_calls.log"
assert_file_contains "find targets cap-mysql-*.sql.gz pattern" "cap-mysql-" "$MOCK_DIR/find_calls.log"

rclone_delete_found=false
if [[ -f "$MOCK_DIR/rclone_calls.log" ]] && grep -q "delete" "$MOCK_DIR/rclone_calls.log"; then
  rclone_delete_found=true
fi
if [[ "$rclone_delete_found" == "true" ]]; then
  assert_pass "rclone delete called for remote pruning"
else
  assert_fail "rclone delete called for remote pruning" "no rclone delete call found"
fi

assert_file_contains "rclone prune uses --min-age" "min-age" "$MOCK_DIR/rclone_calls.log"
echo ""

echo "--- Backup file naming ---"
create_all_mocks 1

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 for naming test" "0" "$ec"

matching_files=$(find "$TEMP_DIR/backups" -name "cap-mysql-*.sql.gz" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$matching_files" -ge 1 ]]; then
  assert_pass "output file matches pattern cap-mysql-*.sql.gz"
else
  assert_fail "output file matches pattern cap-mysql-*.sql.gz" "no matching files found"
fi

if [[ -f "$TEMP_DIR/backups/cap-mysql-20260412-120000.sql.gz" ]]; then
  assert_pass "filename includes mocked timestamp"
else
  assert_fail "filename includes mocked timestamp" "expected cap-mysql-20260412-120000.sql.gz"
fi
echo ""

echo "========================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
