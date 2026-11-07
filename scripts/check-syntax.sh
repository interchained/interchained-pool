#!/usr/bin/env bash
# check-syntax.sh — node --check sweep over the pool's JavaScript.
# Skip-tolerant: groups that are not present yet (pre-integration) are
# reported as SKIP and do not fail the run. Exit is non-zero only when
# a file that exists fails node --check.
set -u

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
CHECKED=0
SKIPPED=0

# check_group <label> <glob...>
# Expands each glob in the current shell; unmatched globs are skipped
# per-file, and a group with zero existing files is a SKIP.
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
      if node --check "$f" 2>/tmp/itc-check-syntax-$$.err; then
        echo "PASS: $f"
      else
        echo "FAIL: $f"
        cat /tmp/itc-check-syntax-$$.err
        FAILURES=$((FAILURES + 1))
      fi
    done
  done
  if [ "$group_found" -eq 0 ]; then
    echo "SKIP: $label — no files found (not yet integrated)"
    SKIPPED=$((SKIPPED + 1))
  fi
  rm -f /tmp/itc-check-syntax-$$.err
}

check_group "lib/*.js" 'lib/*.js'
check_group "lib/ethash/*.js" 'lib/ethash/*.js'
check_group "api/*.js" 'api/*.js'
check_group "ui/app.js" 'ui/app.js'
check_group "start.js" 'start.js'

echo "---"
echo "check-syntax: checked=$CHECKED skipped_groups=$SKIPPED failures=$FAILURES"

if [ "$FAILURES" -ne 0 ]; then
  exit 1
fi
exit 0
