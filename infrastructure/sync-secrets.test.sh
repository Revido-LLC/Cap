#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-secrets.sh"
MOCK_DIR=$(mktemp -d)
PASS_COUNT=0
FAIL_COUNT=0

cleanup() { rm -rf "$MOCK_DIR"; }
trap cleanup EXIT

BASE_ENV=(
  "INFISICAL_TOKEN=test-token"
  "COOLIFY_API_TOKEN=coolify-token"
  "COOLIFY_API_URL=https://coolify.test"
  "COOLIFY_SERVICE_UUID=test-uuid"
  "INFISICAL_PROJECT_ID=test-project"
  "INFISICAL_ENVIRONMENT=prod"
  "INFISICAL_API_URL=https://infisical.test/api"
  "MOCK_DIR=$MOCK_DIR"
)

create_infisical_mock() {
  local response="$1"
  cat > "$MOCK_DIR/infisical" << MOCK
#!/usr/bin/env bash
cat << 'JSON'
$response
JSON
MOCK
  chmod +x "$MOCK_DIR/infisical"
}

create_curl_mock() {
  local body="$1"
  local status="${2:-200}"
  cat > "$MOCK_DIR/curl" << MOCK
#!/usr/bin/env bash
echo "\$@" >> "$MOCK_DIR/curl_calls.log"
echo '$body'
echo "$status"
MOCK
  chmod +x "$MOCK_DIR/curl"
}

create_curl_mock_failing_bulk() {
  cat > "$MOCK_DIR/curl" << 'MOCK'
#!/usr/bin/env bash
MOCK_DIR_INNER="MOCK_DIR_PLACEHOLDER"
echo "$@" >> "$MOCK_DIR_INNER/curl_calls.log"
if echo "$@" | grep -q "envs/bulk"; then
  echo '{"error": "not found"}'
  echo "404"
else
  echo '{"message": "ok"}'
  echo "200"
fi
MOCK
  sed -i.bak "s|MOCK_DIR_PLACEHOLDER|$MOCK_DIR|g" "$MOCK_DIR/curl"
  rm -f "$MOCK_DIR/curl.bak"
  chmod +x "$MOCK_DIR/curl"
}

run_script() {
  env -i "${BASE_ENV[@]}" PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" \
    HOME="$HOME" \
    bash "$SYNC_SCRIPT" "$@" 2>&1 && return 0 || return $?
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

MOCK_SECRETS='[
  {"key": "DATABASE_ENCRYPTION_KEY", "value": "enc-key-123"},
  {"key": "MYSQL_PASSWORD", "value": "db-pass"},
  {"key": "COOLIFY_SERVICE_UUID", "value": "uuid-meta"},
  {"key": "COOLIFY_API_URL", "value": "https://coolify.test"},
  {"key": "CAP_ALLOWED_SIGNUP_DOMAINS", "value": "revido.co"}
]'

echo "=== sync-secrets.sh tests ==="
echo ""

echo "--- Missing env var validation ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"ok":true}'

for var in INFISICAL_TOKEN INFISICAL_API_URL COOLIFY_API_TOKEN COOLIFY_API_URL COOLIFY_SERVICE_UUID INFISICAL_PROJECT_ID INFISICAL_ENVIRONMENT; do
  modified_env=()
  for e in "${BASE_ENV[@]}"; do
    if [[ "$e" == "$var="* ]]; then
      modified_env+=("$var=")
    else
      modified_env+=("$e")
    fi
  done

  output=$(env -i "${modified_env[@]}" PATH="$MOCK_DIR:/usr/bin:/bin:/usr/local/bin" HOME="$HOME" \
    bash "$SYNC_SCRIPT" 2>&1) && ec=0 || ec=$?

  assert_exit_code "exits non-zero when $var is empty" "1" "$ec"
  assert_contains "mentions $var in error" "$var" "$output"
done
echo ""

echo "--- Unknown flag ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"ok":true}'

output=$(run_script "--bogus") && ec=0 || ec=$?
assert_exit_code "exits non-zero on unknown flag" "1" "$ec"
assert_contains "mentions unknown flag" "Unknown flag" "$output"
echo ""

echo "--- COOLIFY_* key filtering ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"ok":true}'

output=$(run_script "--dry-run") && ec=0 || ec=$?
assert_exit_code "dry-run exits 0" "0" "$ec"
assert_contains "lists DATABASE_ENCRYPTION_KEY" "DATABASE_ENCRYPTION_KEY" "$output"
assert_contains "lists MYSQL_PASSWORD" "MYSQL_PASSWORD" "$output"
assert_contains "lists CAP_ALLOWED_SIGNUP_DOMAINS" "CAP_ALLOWED_SIGNUP_DOMAINS" "$output"
assert_not_contains "excludes COOLIFY_SERVICE_UUID" "COOLIFY_SERVICE_UUID" "$(echo "$output" | grep -A100 "would push")"
assert_not_contains "excludes COOLIFY_API_URL" "COOLIFY_API_URL" "$(echo "$output" | grep -A100 "would push")"
assert_contains "reports 5 found" "5 secrets found" "$output"
assert_contains "reports 3 to push" "3 to push" "$output"
assert_contains "reports 2 skipped" "2 skipped" "$output"
echo ""

echo "--- Dry-run does not call curl ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"ok":true}'

run_script "--dry-run" > /dev/null 2>&1 || true
if [[ -f "$MOCK_DIR/curl_calls.log" ]]; then
  assert_fail "dry-run must not invoke curl" "curl was called"
else
  assert_pass "dry-run must not invoke curl"
fi
echo ""

echo "--- Bulk API success ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"message":"updated"}' "200"

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 on bulk success" "0" "$ec"
assert_contains "reports bulk success" "bulk API" "$output"
assert_file_contains "calls bulk endpoint" "envs/bulk" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- Bulk API failure triggers fallback ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock_failing_bulk

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 after successful fallback" "0" "$ec"
assert_contains "reports fallback" "falling back" "$output"

ok_count=$(echo "$output" | grep -c "\[OK\]" || true)

if [[ "$ok_count" -eq 3 ]]; then
  assert_pass "pushes 3 secrets individually (one per non-COOLIFY secret)"
else
  assert_fail "pushes 3 secrets individually" "got $ok_count [OK] lines"
fi
echo ""

echo "--- Empty secrets ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock '[]'
create_curl_mock '{"ok":true}'

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 on empty secrets" "0" "$ec"
assert_contains "reports nothing to push" "Nothing to push" "$output"
echo ""

echo "--- Restart flag calls restart endpoint ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock "$MOCK_SECRETS"
create_curl_mock '{"message":"ok"}' "200"

output=$(run_script "--restart") && ec=0 || ec=$?
assert_exit_code "exits 0 with restart" "0" "$ec"
assert_contains "reports restart triggered" "restart triggered" "$output"
assert_file_contains "calls restart endpoint" "restart" "$MOCK_DIR/curl_calls.log"
echo ""

echo "--- All COOLIFY_* secrets only ---"
rm -f "$MOCK_DIR/curl_calls.log"
create_infisical_mock '[{"key":"COOLIFY_X","value":"a"},{"key":"COOLIFY_Y","value":"b"}]'
create_curl_mock '{"ok":true}'

output=$(run_script) && ec=0 || ec=$?
assert_exit_code "exits 0 when all secrets are COOLIFY_*" "0" "$ec"
assert_contains "reports nothing to push" "Nothing to push" "$output"
echo ""

echo "========================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
