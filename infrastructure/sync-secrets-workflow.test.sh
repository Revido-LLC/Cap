#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/sync-secrets.yml"
PASS_COUNT=0
FAIL_COUNT=0

assert_pass() {
  echo "  PASS  $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

assert_fail() {
  local desc="$1" detail="${2:-}"
  echo "  FAIL  $desc${detail:+ ($detail)}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

check_yaml_key() {
  local desc="$1" pattern="$2"
  if grep -q "$pattern" "$WORKFLOW"; then
    assert_pass "$desc"
  else
    assert_fail "$desc" "pattern '$pattern' not found"
  fi
}

check_yaml_absent() {
  local desc="$1" pattern="$2"
  if grep -q "$pattern" "$WORKFLOW"; then
    assert_fail "$desc" "found disallowed pattern '$pattern'"
  else
    assert_pass "$desc"
  fi
}

echo "=== sync-secrets.yml workflow tests ==="
echo ""

echo "--- File exists and is valid YAML ---"
if [[ -f "$WORKFLOW" ]]; then
  assert_pass "workflow file exists"
else
  assert_fail "workflow file exists"
  echo "Cannot continue without workflow file"
  exit 1
fi

if python3 -c "import yaml; yaml.safe_load(open('$WORKFLOW'))" 2>/dev/null; then
  assert_pass "valid YAML syntax"
else
  assert_fail "valid YAML syntax"
fi
echo ""

echo "--- Trigger configuration ---"
check_yaml_key "has workflow_dispatch trigger" "workflow_dispatch:"
check_yaml_absent "no push trigger" "^  push:"
check_yaml_absent "no pull_request trigger" "^  pull_request:"
echo ""

echo "--- Workflow dispatch inputs ---"
check_yaml_key "has environment input" "environment:"
check_yaml_key "has staging option" "staging"
check_yaml_key "has prod option" "prod"
check_yaml_key "has restart_service input" "restart_service:"
check_yaml_key "has dry_run input" "dry_run:"
echo ""

echo "--- Secret references ---"
check_yaml_key "references INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"
check_yaml_key "references INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET"
check_yaml_key "references COOLIFY_API_TOKEN" "COOLIFY_API_TOKEN"
echo ""

echo "--- Hardcoded infrastructure values ---"
check_yaml_key "has Coolify API URL" "https://coolify.revido.co"
check_yaml_key "has Coolify service UUID" "ls45v38pyyqi74mdl8w0bw2a"
check_yaml_key "has Infisical project ID" "63361c35-8075-49d3-b3b6-1d4ff4b31517"
check_yaml_key "has Infisical API URL" "https://infisical.revido.co"
echo ""

echo "--- Security: inputs accessed via env vars, not direct interpolation in run ---"

run_blocks=$(python3 -c "
import yaml, sys
with open('$WORKFLOW') as f:
    wf = yaml.safe_load(f)
for job in wf.get('jobs', {}).values():
    for step in job.get('steps', []):
        run = step.get('run', '')
        if run:
            print(run)
" 2>/dev/null)

if echo "$run_blocks" | grep -q '\${{ inputs\.' 2>/dev/null; then
  assert_fail "no direct \${{ inputs.* }} in run blocks"
else
  assert_pass "no direct \${{ inputs.* }} in run blocks"
fi

if echo "$run_blocks" | grep -q '\${{ secrets\.' 2>/dev/null; then
  assert_fail "no direct \${{ secrets.* }} in run blocks"
else
  assert_pass "no direct \${{ secrets.* }} in run blocks"
fi
echo ""

echo "--- Step structure ---"
check_yaml_key "uses actions/checkout@v4" "actions/checkout@v4"
check_yaml_key "installs Infisical CLI" "infisical-cli"
check_yaml_key "authenticates with Infisical" "universal-auth/login"
check_yaml_key "masks token in logs" "::add-mask::"
check_yaml_key "runs sync script" "sync-secrets.sh"
echo ""

echo "--- Auth step validates token ---"
check_yaml_key "checks for null token" '"null"'
echo ""

echo "--- Hardening ---"
check_yaml_key "has job timeout-minutes" "timeout-minutes:"
check_yaml_absent "no sudo -E (leaks env to install scripts)" "sudo -E"
check_yaml_absent "token not persisted to GITHUB_OUTPUT" "GITHUB_OUTPUT"
echo ""

echo "========================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
