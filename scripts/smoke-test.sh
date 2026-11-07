#!/usr/bin/env bash
# smoke-test.sh — syntax sweep + API boot smoke test.
# Uses `set -u` (not -e) so every check runs and every failure is
# reported. Exit is non-zero only on real failures of things that
# exist; missing (pre-integration) groups are SKIP, not FAIL.
set -u

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
CHECKED=0
SKIPPED=0
SCRATCH_PORT="${SMOKE_API_PORT:-18080}"

# --- (a) node --check sweep -------------------------------------------------

check_group() {
  label="$1"
  shift
  group_found=0
  for pattern in "$@"; do
    # shellcheck disable=SC2086
    for f in $pattern; do
      [ -e "$f" ] || continue
      [ -f "$f" ] || continue
      group_found=1
      CHECKED=$((CHECKED + 1))
      if node --check "$f" 2>/tmp/itc-smoke-check-$$.err; then
        echo "PASS: node --check $f"
      else
        echo "FAIL: node --check $f"
        cat /tmp/itc-smoke-check-$$.err
        FAILURES=$((FAILURES + 1))
      fi
    done
  done
  if [ "$group_found" -eq 0 ]; then
    echo "SKIP: $label — no files found (not yet integrated)"
    SKIPPED=$((SKIPPED + 1))
  fi
  rm -f /tmp/itc-smoke-check-$$.err
}

echo "== Syntax checks =="
check_group "lib/*.js" 'lib/*.js'
check_group "lib/ethash/*.js" 'lib/ethash/*.js'
check_group "api/*.js" 'api/*.js'
check_group "ui/app.js" 'ui/app.js'
check_group "start.js" 'start.js'

# --- (b) API boot smoke test ------------------------------------------------

echo "== API smoke test =="
if [ ! -f "api/server.js" ]; then
  echo "SKIP: api/server.js — not present (not yet integrated); API boot test skipped"
  SKIPPED=$((SKIPPED + 1))
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "FAIL: api/server.js exists but curl is not available to test it"
    FAILURES=$((FAILURES + 1))
  else
    API_LOG="$(mktemp /tmp/itc-smoke-api-XXXXXX.log)"
    PORT="$SCRATCH_PORT" API_PORT="$SCRATCH_PORT" node api/server.js >"$API_LOG" 2>&1 &
    API_PID=$!

    health_ok=0
    stats_ok=0
    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if ! kill -0 "$API_PID" 2>/dev/null; then
        break
      fi
      if curl -fsS "http://127.0.0.1:${SCRATCH_PORT}/health" >/dev/null 2>&1; then
        health_ok=1
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.5
    done

    if [ "$health_ok" -eq 1 ]; then
      echo "PASS: API /health on scratch port $SCRATCH_PORT"
    else
      echo "FAIL: API /health on scratch port $SCRATCH_PORT did not return success"
      FAILURES=$((FAILURES + 1))
    fi

    if [ "$health_ok" -eq 1 ] || kill -0 "$API_PID" 2>/dev/null; then
      if curl -fsS "http://127.0.0.1:${SCRATCH_PORT}/api/stats" >/dev/null 2>&1; then
        stats_ok=1
        echo "PASS: API /api/stats on scratch port $SCRATCH_PORT"
      else
        echo "FAIL: API /api/stats on scratch port $SCRATCH_PORT did not return success"
        FAILURES=$((FAILURES + 1))
      fi
    fi

    if [ "$health_ok" -eq 0 ] && [ "$stats_ok" -eq 0 ]; then
      echo "--- api/server.js log (tail) ---"
      tail -n 50 "$API_LOG" 2>/dev/null || true
      echo "--------------------------------"
    fi

    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
    rm -f "$API_LOG"
  fi
fi

echo "---"
echo "smoke-test: checked=$CHECKED skipped_groups=$SKIPPED failures=$FAILURES"

if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
exit 0
