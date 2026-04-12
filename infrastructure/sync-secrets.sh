#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
RESTART=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --restart) RESTART=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

required_vars=(INFISICAL_TOKEN INFISICAL_API_URL COOLIFY_API_TOKEN COOLIFY_API_URL COOLIFY_SERVICE_UUID INFISICAL_PROJECT_ID INFISICAL_ENVIRONMENT)
for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set" >&2
    exit 1
  fi
done

secrets=$(infisical export \
  --format=json \
  --token="$INFISICAL_TOKEN" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENVIRONMENT" \
  --domain="$INFISICAL_API_URL" \
  --path="/")

total_count=$(echo "$secrets" | jq 'length')

payload=$(echo "$secrets" | jq '[
  .[] | select(.key | startswith("COOLIFY_") | not) |
  {key: .key, value: .value, is_preview: false, is_literal: true}
]')

push_count=$(echo "$payload" | jq 'length')
skip_count=$((total_count - push_count))

echo "Infisical ($INFISICAL_ENVIRONMENT): $total_count secrets found, $push_count to push, $skip_count skipped"

if [[ "$skip_count" -gt 0 ]]; then
  echo "Skipped: $(echo "$secrets" | jq -r '[.[] | select(.key | startswith("COOLIFY_")) | .key] | join(", ")')"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "DRY RUN — would push:"
  echo "$payload" | jq -r '.[].key'
  exit 0
fi

if [[ "$push_count" -eq 0 ]]; then
  echo "Nothing to push."
  exit 0
fi

bulk_body=$(echo "$payload" | jq '{data: .}')

response=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X PATCH \
  "${COOLIFY_API_URL}/api/v1/services/${COOLIFY_SERVICE_UUID}/envs/bulk" \
  -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$bulk_body")

http_code=$(echo "$response" | tail -1)

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
  echo "Pushed $push_count secrets via bulk API (HTTP $http_code)"
else
  echo "Bulk API failed (HTTP $http_code), falling back to individual updates..."

  error_count=0
  success_count=0

  while IFS= read -r item; do
    key=$(echo "$item" | jq -r '.key')

    resp=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X PATCH \
      "${COOLIFY_API_URL}/api/v1/services/${COOLIFY_SERVICE_UUID}/envs" \
      -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$item")

    code=$(echo "$resp" | tail -1)

    if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then
      echo "  [OK]    $key"
      success_count=$((success_count + 1))
    elif [[ "$code" -eq 404 ]]; then
      resp=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST \
        "${COOLIFY_API_URL}/api/v1/services/${COOLIFY_SERVICE_UUID}/envs" \
        -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$item")

      code=$(echo "$resp" | tail -1)

      if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then
        echo "  [OK]    $key (created)"
        success_count=$((success_count + 1))
      else
        echo "  [FAIL]  $key (HTTP $code)"
        error_count=$((error_count + 1))
      fi
    else
      echo "  [FAIL]  $key (HTTP $code)"
      error_count=$((error_count + 1))
    fi
  done < <(echo "$payload" | jq -c '.[]')

  echo "Individual sync: $success_count ok, $error_count failed"

  if [[ "$error_count" -gt 0 ]]; then
    exit 1
  fi
fi

if [[ "$RESTART" == "true" ]]; then
  echo "Stopping Coolify service..."

  stop_resp=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST \
    "${COOLIFY_API_URL}/api/v1/services/${COOLIFY_SERVICE_UUID}/stop" \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}")

  stop_code=$(echo "$stop_resp" | tail -1)

  if [[ "$stop_code" -ge 200 && "$stop_code" -lt 300 ]]; then
    echo "Service stopped (HTTP $stop_code)"
  else
    echo "Service stop failed (HTTP $stop_code)"
    exit 1
  fi

  echo "Starting Coolify service..."

  start_resp=$(curl -s --connect-timeout 10 --max-time 30 -w "\n%{http_code}" -X POST \
    "${COOLIFY_API_URL}/api/v1/services/${COOLIFY_SERVICE_UUID}/start" \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}")

  start_code=$(echo "$start_resp" | tail -1)

  if [[ "$start_code" -ge 200 && "$start_code" -lt 300 ]]; then
    echo "Service started (HTTP $start_code)"
  else
    echo "Service start failed (HTTP $start_code)"
    exit 1
  fi
fi

echo "Done."
