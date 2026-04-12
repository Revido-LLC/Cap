#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_SCRIPT="$SCRIPT_DIR/monitor-storage.sh"
MOCK_DIR=$(mktemp -d)
TMP_LOG=$(mktemp)
PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "$MOCK_DIR" "$TMP_LOG"; }
trap cleanup EXIT

BASE_ENV=(
  "SLACK_ALERT_WEBHOOK_URL=https://hooks.slack.test/services/T00/B00/xxx"
  "MYSQL_ROOT_PASSWORD=test-pass"
  "MYSQL_CONTAINER=mysql-test"
  "MC_ALIAS=caplocal"
  "MC_BUCKET=cap"
  "LOG_FILE=$TMP_LOG"
  "MOCK_DIR=$MOCK_DIR"
)

create_df_mock() {
  local pct="$1"
  local used="${2:-54G}"
  local total="${3:-75G}"
  local avail="${4:-19G}"
  cat > "$MOCK_DIR/df" << MOCK
#!/usr/bin/env bash
if echo "\$@" | grep -q "\-h"; then
  printf "Filesystem      Size  Used Avail Use%% Mounted on\n"
  printf "/dev/sda1       %s   %s   %s  %s%% /\n" "$total" "$used" "$avail" "$pct"
else
  printf "Filesystem     1K-blocks     Used Available Use%% Mounted on\n"
  printf "/dev/sda1      78643200  56623104  18022400  %s%% /\n" "$pct"
fi
MOCK
  chmod +x "$MOCK_DIR/df"
}

create_mc_mock() {
  local json="$1"
  cat > "$MOCK_DIR/mc" << MOCK
#!/usr/bin/env bash
echo '$json'
MOCK
  chmod +x "$MOCK_DIR/mc"
}

create_mc_mock_failing() {
  cat > "$MOCK_DIR/mc" << 'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
  chmod +x "$MOCK_DIR/mc"
}

create_docker_mock() {
  local result="$1"
  cat > "$MOCK_DIR/docker" << MOCK
#!/usr/bin/env bash
echo "$result"
MOCK
  chmod +x "$MOCK_DIR/docker"
}

create_docker_mock_failing() {
  cat > "$MOCK_DIR/docker" << 'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
  chmod +x "$MOCK_DIR/docker"
}

create_curl_mock() {
  cat > "$MOCK_DIR/curl" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/curl_calls.log"
MOCK
  chmod +x "$MOCK_DIR/curl"
}

create_jq_passthrough() {
  local jq_real
  jq_real=$(which jq 2>/dev/null || true)
  if [[ -n "$jq_real" ]]; then
    ln -sf "$jq_real" "$MOCK_DIR/jq"
  fi
}

create_date_mock() {
  cat > "$MOCK_DIR/date" << 'MOCK'
#!/usr/bin/env bash
echo "2026-04-12T00:00:00+00:00"
MOCK
  chmod +x "$MOCK_DIR/date"
}

run_script() {
  rm -f "$TMP_LOG"
  touch "$TMP_LOG"
  env -i "${BASE_ENV[@]}" PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" \
    HOME="$HOME" \
    bash "$MONITOR_SCRIPT" "$@" 2>&1 && return 0 || return $?
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

assert_file_not_exists() {
  local desc="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "file unexpectedly exists"
  fi
}

echo "=== monitor-storage.sh tests ==="
echo ""

echo "--- Disk at 50%: no Slack alert ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "50" "37G" "75G" "36G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 at 50% disk" "0" "$ec"
assert_contains "logs OK status" "OK" "$output"
assert_contains "logs disk percentage" "50%" "$output"
assert_file_not_exists "curl not called (no Slack alert)" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Disk at 72%: WARNING Slack alert ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "72" "54G" "75G" "19G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 at 72% disk" "0" "$ec"
assert_contains "logs WARNING status" "WARNING" "$output"
assert_contains "logs disk percentage" "72%" "$output"
assert_file_contains "curl called for Slack" "hooks.slack.test" "$MOCK_DIR/curl_calls.log"
assert_file_contains "Slack payload contains Warning" "Warning" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Disk at 87%: CRITICAL Slack alert ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "87" "65G" "75G" "8G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 at 87% disk" "0" "$ec"
assert_contains "logs CRITICAL status" "CRITICAL" "$output"
assert_contains "logs disk percentage" "87%" "$output"
assert_file_contains "curl called for Slack" "hooks.slack.test" "$MOCK_DIR/curl_calls.log"
assert_file_contains "Slack payload contains CRITICAL" "CRITICAL" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- mc fails gracefully: MinIO size shows unknown ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "50" "37G" "75G" "36G"
create_mc_mock_failing
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 when mc fails" "0" "$ec"
assert_contains "MinIO shows unknown" "MinIO: unknown" "$output"
echo ""

echo "--- docker exec fails gracefully: MySQL size shows unknown ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "50" "37G" "75G" "36G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock_failing
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 when docker fails" "0" "$ec"
assert_contains "MySQL shows unknown" "MySQL: unknown" "$output"
echo ""

echo "--- Missing SLACK_ALERT_WEBHOOK_URL: runs without Slack ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "87" "65G" "75G" "8G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

no_webhook_env=()
for e in "${BASE_ENV[@]}"; do
  if [[ "$e" == "SLACK_ALERT_WEBHOOK_URL="* ]]; then
    no_webhook_env+=("SLACK_ALERT_WEBHOOK_URL=")
  else
    no_webhook_env+=("$e")
  fi
done

rm -f "$TMP_LOG"
touch "$TMP_LOG"
output=$(env -i "${no_webhook_env[@]}" PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" \
  HOME="$HOME" \
  bash "$MONITOR_SCRIPT" 2>&1) && ec=0 || ec=$?
assert_exit_code "exits 0 without webhook URL" "0" "$ec"
assert_contains "logs CRITICAL even without webhook" "CRITICAL" "$output"
assert_file_not_exists "curl not called without webhook" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Log output: stats written to log file ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_df_mock "50" "37G" "75G" "36G"
create_mc_mock '{"status":"success","size":5368709120}'
create_docker_mock "42.5"
create_curl_mock
create_jq_passthrough
create_date_mock

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 for log check" "0" "$ec"
assert_file_contains "log file contains disk stats" "50%" "$TMP_LOG"
assert_file_contains "log file contains MinIO stats" "MinIO" "$TMP_LOG"
assert_file_contains "log file contains MySQL stats" "MySQL" "$TMP_LOG"
assert_file_contains "log file contains STORAGE-MONITOR tag" "STORAGE-MONITOR" "$TMP_LOG"
echo ""

echo "========================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
