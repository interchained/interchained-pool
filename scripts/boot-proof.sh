#!/usr/bin/env bash
# boot-proof.sh — Interchained tri-PoW pool BOOT PROOF (lane: runtime,
# phase-2 integration updates for the Ethash adapter).
#
# Proves the pool actually boots and mines against a fake daemon:
#   1. stub-daemon.js on :18332 (fake Interchained JSON-RPC + PSBT wallet)
#   2. node start.js scripts/harness-config.json  (3 pools: sha256 :13333,
#      yespower :13334, ethash :13335)
#   3. fake-miner.js for sha256/yespower: subscribe/authorize/notify/submit
#      ethash-probe.js for ethash: the port is served by the Ethash
#      stratum adapter (lib/ethash/ethashPool.js) in the Ethash dialect
#
# Assertions:
#   - require('./lib/pool.js') loads under the pinned Node (see .nvmrc)
#   - all three stratum ports accept TCP + serve subscribe/notify
#   - stub log shows getblocktemplate called WITH each algo tag
#   - sha256: share submitted AND accepted by the pool (full loop)
#   - yespower: share submitted AND accepted (native multi-hashing)
#   - ethash: adapter attached; dialect subscribe/authorize/notify probe
#     passes (hashimoto share verification itself is proven by
#     lib/ethash/test-pool-wiring.js against the same adapter)
#   - bonus (reported, not required): submitblock seen by the stub
#
# Exit code 0 = PASS, 1 = FAIL. Logs land in ${ITC_PROOF_DIR:-/tmp/itc-boot-proof}.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
PROOF_DIR="${ITC_PROOF_DIR:-/tmp/itc-boot-proof}"
mkdir -p "$PROOF_DIR"
STUB_LOG="$PROOF_DIR/stub.log"
STUB_CALLS="$PROOF_DIR/stub-calls.jsonl"
POOL_LOG="$PROOF_DIR/pool.log"
: > "$STUB_CALLS"

# --- resolve pinned Node 16 (nvm) -------------------------------------------
NODE_BIN=""
if [ -x "$HOME/.nvm/versions/node/v16.20.2/bin/node" ]; then
  NODE_BIN="$HOME/.nvm/versions/node/v16.20.2/bin/node"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use 16.20.2 >/dev/null 2>&1 && NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1 && node --version | grep -q '^v16\.'; then
  NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "BOOT-PROOF FAIL: Node 16.20.2 not found. Install: nvm install 16.20.2 (see .nvmrc)"
  exit 1
fi
NODE="$NODE_BIN"
echo "== boot-proof: node = $($NODE --version) ($NODE_BIN)"

# --- preflight: the require that never succeeded on Node 24 ------------------
if ! "$NODE" -e "require('./lib/pool.js')" 2>"$PROOF_DIR/require.err"; then
  echo "BOOT-PROOF FAIL: require('./lib/pool.js') failed:"
  cat "$PROOF_DIR/require.err"
  exit 1
fi
echo "== preflight OK: require('./lib/pool.js') loads"

PIDS=""
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in $PIDS; do kill -9 "$p" 2>/dev/null; done
}
trap cleanup EXIT

wait_port() { # port, timeout_s
  local port="$1" t="${2:-20}" i=0
  while [ "$i" -lt $((t * 2)) ]; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 0.5; i=$((i + 1))
  done
  return 1
}

# --- 1. stub daemon -----------------------------------------------------------
STUB_CALL_LOG="$STUB_CALLS" "$NODE" scripts/stub-daemon.js 18332 >"$STUB_LOG" 2>&1 &
PIDS="$PIDS $!"
wait_port 18332 15 || { echo "BOOT-PROOF FAIL: stub daemon did not start"; cat "$STUB_LOG"; exit 1; }
echo "== stub daemon up on :18332"

# --- 2. pool ------------------------------------------------------------------
"$NODE" start.js scripts/harness-config.json >"$POOL_LOG" 2>&1 &
POOL_PID=$!
PIDS="$PIDS $POOL_PID"
ok=1
for port in 13333 13334 13335; do
  wait_port "$port" 30 || { echo "BOOT-PROOF FAIL: stratum port $port never listened"; ok=0; }
done
[ "$ok" -eq 1 ] || { cat "$POOL_LOG"; exit 1; }
echo "== pool up: stratum ports 13333/13334/13335 listening"
grep -c "Stratum Pool Server Started" "$POOL_LOG" | sed 's/^/== pool-start banners: /'

# --- 3. miners ----------------------------------------------------------------
run_miner() { # algo port timeout_s
  local algo="$1" port="$2" tmo="$3"
  local log="$PROOF_DIR/miner-$algo.log"
  timeout "$tmo" "$NODE" scripts/fake-miner.js --port "$port" --algo "$algo" \
    --user 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa --timeout "$tmo" >"$log" 2>&1
  return $?
}

FAIL=0
run_miner sha256 13333 240;   SHA_RC=$?
run_miner yespower 13334 300; YES_RC=$?
timeout 120 "$NODE" scripts/ethash-probe.js --port 13335 \
  --user 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa --timeout 110 >"$PROOF_DIR/miner-ethash.log" 2>&1
ETH_RC=$?
sleep 2   # let any block submission land in the stub log

echo "== miner results: sha256 rc=$SHA_RC, yespower rc=$YES_RC, ethash(dialect probe) rc=$ETH_RC"
for a in sha256 yespower ethash; do echo "--- miner-$a:"; cat "$PROOF_DIR/miner-$a.log"; done

# --- assertions ---------------------------------------------------------------
assert_grep() { # desc file pattern
  if grep -q "$3" "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; FAIL=1; fi
}
assert_grep "pool booted sha256 pool"   "$POOL_LOG"   "Stratum Pool Server Started for Interchained \[ITC\] {sha256}"
assert_grep "pool booted yespower pool" "$POOL_LOG"   "Stratum Pool Server Started for Interchained \[ITC\] {yespower}"
assert_grep "pool booted ethash pool"   "$POOL_LOG"   "Stratum Pool Server Started for Interchained \[ITC\] {ethash}"
assert_grep "stub saw GBT algo=sha256"   "$STUB_CALLS" '"method":"getblocktemplate".*"algo":"sha256"'
assert_grep "stub saw GBT algo=yespower" "$STUB_CALLS" '"method":"getblocktemplate".*"algo":"yespower"'
assert_grep "stub saw GBT algo=ethash"   "$STUB_CALLS" '"method":"getblocktemplate".*"algo":"ethash"'
assert_grep "stub saw DetectCoinData validateaddress" "$STUB_CALLS" '"method":"validateaddress"'
assert_grep "stub saw submitblock probe" "$STUB_CALLS" '"method":"submitblock","params":\[\]'
[ "$SHA_RC" -eq 0 ] && echo "PASS: sha256 full loop (share accepted)" || { echo "FAIL: sha256 full loop"; FAIL=1; }
[ "$YES_RC" -eq 0 ] && echo "PASS: yespower full loop (share accepted)" || { echo "FAIL: yespower full loop"; FAIL=1; }
assert_grep "ethash adapter attached" "$POOL_LOG" "Ethash stratum adapter listening on port 13335"
[ "$ETH_RC" -eq 0 ] && echo "PASS: ethash dialect probe (subscribe/authorize/notify via adapter)" || { echo "FAIL: ethash dialect probe"; FAIL=1; }
if grep -q '"method":"submitblock","params":\["' "$STUB_CALLS"; then
  echo "INFO: BLOCK FOUND during proof — stub recorded a real submitblock"
else
  echo "INFO: no block candidate found this run (submitblock exercised only as startup probe)"
fi
grep -q "valid share\|\[sha256\] share:" "$POOL_LOG" && echo "INFO: pool log carries share events (see pool.log)"

echo "== logs: $PROOF_DIR (stub.log, stub-calls.jsonl, pool.log, miner-*.log)"
if [ "$FAIL" -eq 0 ]; then echo "BOOT-PROOF: PASS"; exit 0; else echo "BOOT-PROOF: FAIL"; exit 1; fi
