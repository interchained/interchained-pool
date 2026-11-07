# Interchained Tri-PoW Pool — Operator Setup

This walkthrough takes an operator from a bare host to a running solo tri-PoW pool: SHA-256 on stratum port 3333, Yespower on 3334, Ethash on 3335, with the stats API and dashboard on 8080.

Payout model reminder: **solo only**. The coinbase pays the miner's own address (the stratum username). PPLNS/PROP accounting and pooled payouts are future portal work and are **not** in this repo.

---

## 1. Prerequisites

- A tri-PoW build of `interchainedd` (Bitcoin-0.21-derived; its `getblocktemplate` honours an `"algo"` key: `"sha256"` | `"yespower"` | `"ethash"`, and `generatetoaddress` takes an `"algo"` argument — useful on regtest).
- Node.js (current LTS) and npm.
- Miners: SHA-256 ASICs, a Yespower-capable CPU miner, and/or an Ethash-capable GPU miner, depending on which ports you enable.
- On mainnet, tri-PoW activates at **height 913982**. Before that height, only legacy algorithms are valid — see Troubleshooting.

## 2. Daemon setup (`interchainedd`)

### 2.1 `interchained.conf` essentials

Create/edit the daemon config (default data-dir location for your build; typically `~/.interchained/interchained.conf`):

```ini
server=1
rpcuser=<choose-a-strong-rpc-user>
rpcpassword=<choose-a-strong-rpc-password>
rpcport=8332
# Bind RPC to localhost only unless you have a specific, firewalled reason not to:
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```

| Setting | Value | Notes |
|---|---|---|
| `server` | `1` | Enables the RPC server the pool depends on. |
| `rpcuser` / `rpcpassword` | operator-chosen | Must match the pool config exactly. Use long random values; treat them as secrets. |
| `rpcport` | `8332` | Default daemon RPC port. |
| P2P port | `17101` | Default daemon peer port — this is chain networking, **not** RPC and **not** stratum. |

Start the daemon and let it fully sync before starting the pool on mainnet:

```bash
interchainedd -daemon
interchained-cli getblockchaininfo   # check "blocks" / "headers" / verification progress
```

### 2.2 The algo-aware `getblocktemplate`

The pool does not build generic templates and filter them locally. For each algorithm it asks the daemon for work for that algorithm, conceptually:

```json
getblocktemplate {"rules": ["segwit"], "algo": "yespower"}
```

with `"algo"` one of `"sha256"`, `"yespower"`, or `"ethash"`. Solved blocks go back with `submitblock`. If your daemon build does not accept the `"algo"` key, it is not the tri-PoW build — stop and fix the daemon first; do not work around it in the pool.

Quick manual check (mainnet, after activation; regtest, any time):

```bash
interchained-cli getblocktemplate '{"rules":["segwit"],"algo":"yespower"}' | head -c 400
```

## 3. Pool configuration

Pool configs live in `config/*.json`. Two examples ship with the integrated layout:

- `config/interchained-mainnet.json` — mainnet pool.
- A regtest variant in the same directory (name contains `regtest`) — same shape, pointed at a regtest daemon.

Walk through the mainnet file top to bottom before first start:

1. **Coin / network identity** — confirms the pool is building Interchained addresses and coinbases, not another chain's. A wrong network here produces unpayable or wrong-network coinbases.
2. **Daemon connection(s)** — host (normally `127.0.0.1`), RPC port `8332`, and the `rpcuser`/`rpcpassword` from §2.1. Keep host loopback unless daemon and pool are on separate, privately networked hosts.
3. **Algorithm / port bindings** — the stratum listeners:
   - `sha256` → `3333`
   - `yespower` → `3334`
   - `ethash` → `3335`
   Disable an algorithm by removing/disabling its port binding if you have no miners or no daemon support for it; do not leave an enabled port pointed at an algorithm the daemon will reject.
4. **Difficulty / vardiff per port** — start from the example values. ASIC (3333), CPU (3334), and GPU (3335) hashrates differ by orders of magnitude; one difficulty policy does not fit all three.
5. **API settings** — the stats service listens on `8080` (`api/server.js`). Keep it bound as in the example unless you are putting a reverse proxy in front of it.
6. **Payout-related fields** — in solo mode there is no pool payout wallet to configure for miner rewards: each miner's coinbase is built for that miner's username/address. If the config carries an operator/donation address field, read its comment carefully and do not mistake it for a shared payout wallet.

For regtest, copy the same walkthrough in the regtest file: daemon host/port must point at your `interchainedd -regtest` instance (its RPC port is whatever you set for regtest — set it explicitly in both `interchained.conf`/daemon flags and the pool config so the two agree), and stratum ports may stay 3333/3334/3335 if nothing else is using them.

> Never commit real RPC credentials. Keep production configs out of git or with secrets redacted, and restrict file permissions (`chmod 600`).

## 4. Starting the pool, API, and dashboard

```bash
# 1. Daemon first — fully started (and, on mainnet, synced)
interchainedd -daemon

# 2. Pool (from the repo root)
npm install
node start.js

# 3. Stats API + dashboard host, in a second terminal
node api/server.js
```

Then:

- Dashboard: open `http://localhost:8080/` (replace `localhost` with the pool host if you are browsing remotely and have deliberately exposed 8080 — see §6).
- API health: `curl http://localhost:8080/health`
- API stats: `curl http://localhost:8080/api/stats`

Healthy signs: the pool log shows daemon connection / template receipt for each enabled algorithm, stratum listeners bound on 3333/3334/3335, miners can connect and receive jobs, and `/api/stats` reflects connected workers.

Repository checks (no daemon needed):

```bash
scripts/check-syntax.sh   # node --check sweep; SKIPs groups not yet present
scripts/smoke-test.sh     # syntax sweep + boots api/server.js on a scratch port if present
```

## 5. Regtest end-to-end sanity recipe

Regtest is the safe place to prove the whole path — daemon templates, stratum, share/block flow, API — without mainnet height or hashrate.

```bash
# 1. Start a regtest daemon with RPC enabled (use a throwaway datadir)
interchainedd -regtest -daemon -server=1 -rpcuser=regtest -rpcpassword=regtest \
  -rpcport=8332 -fallbackfee=0.0002

# 2. Create/load a wallet if your build requires one, and get an address
interchained-cli -regtest createwallet "regtest"    # if not already loaded
ADDR=$(interchained-cli -regtest getnewaddress)

# 3. Algo-aware generation checks — generatetoaddress takes an "algo" arg.
#    Generate one block per algorithm you intend to serve:
interchained-cli -regtest generatetoaddress 1 "$ADDR" "yespower"
interchained-cli -regtest generatetoaddress 1 "$ADDR" "sha256"
interchained-cli -regtest generatetoaddress 1 "$ADDR" "ethash"
# If an algo is rejected here, the daemon build/config is the problem — fix it
# before involving the pool.
interchained-cli -regtest getblockcount
```

Then prove the pool path with the cheapest miner — CPU/Yespower:

```bash
# 4. Point the pool at regtest (use the regtest config variant) and start it
node start.js
node api/server.js        # second terminal

# 5. Point a Yespower CPU miner at the Yespower stratum port, with
#    username = $ADDR (your regtest payout address), password = x
#    e.g. stratum host 127.0.0.1, port 3334 (exact flags depend on your miner)

# 6. Watch it land
curl http://localhost:8080/health
curl http://localhost:8080/api/stats     # worker should appear; shares should count up
interchained-cli -regtest getblockcount  # advances when the miner/pool submits a block
```

Pass criteria: each `generatetoaddress … "algo"` call succeeds, the CPU miner connects on 3334 and is visible via the API, shares are accepted, and a pool-submitted block (at regtest difficulty, with continued mining) advances `getblockcount` with its coinbase paying `$ADDR`. Test 3333/3335 the same way with suitable miners before calling those ports proven — a Yespower pass does not prove Ethash verification.

Clean up: `interchained-cli -regtest stop` and remove the throwaway datadir if you used one.

## 6. Ports and firewall

| Port | Service | Expose to |
|---|---|---|
| 3333 / tcp | Stratum — SHA-256 | Miners (internet if miners are remote) |
| 3334 / tcp | Stratum — Yespower | Miners (internet if miners are remote) |
| 3335 / tcp | Stratum — Ethash | Miners (internet if miners are remote) |
| 8080 / tcp | Stats API + dashboard | Operator / trusted viewers only, ideally via reverse proxy or VPN — it is operational information |
| 8332 / tcp | Daemon RPC | **Loopback only. Never expose.** |
| 17101 / tcp | Daemon P2P | Internet (normal chain peering) |

Only open stratum ports for algorithms you actually run. If all miners are on a LAN, restrict 3333–3335 to that LAN instead of the world.

## 7. Troubleshooting

### Daemon RPC authentication failures

Symptoms: pool logs RPC `401`/unauthorized errors, no templates, stratum may start but never issue real work.

- Confirm `rpcuser`/`rpcpassword` in the pool config match `interchained.conf` **exactly** (no trailing whitespace, no stale copy of the config).
- Confirm the daemon was restarted after editing `interchained.conf`.
- Confirm host/port: pool → daemon RPC is `8332` by default, not P2P `17101` and not a stratum port.
- Test outside the pool: `interchained-cli getblockchaininfo` (uses the same RPC credentials path) and a manual `getblocktemplate` call as in §2.2.

### `getblocktemplate` `algo` rejected — especially pre-913982 on mainnet

Symptoms: daemon rejects the template request, or rejects a specific algorithm, with the pool unable to build jobs for that port.

- **Check the height first:** `interchained-cli getblockcount`. On **mainnet before height 913982**, tri-PoW is not yet active and rejection of a not-yet-active algorithm is expected behaviour, not a pool bug. Serve only the legacy-valid algorithm(s) until activation, or do your tri-PoW testing on regtest.
- Confirm the exact algo string: `"sha256"`, `"yespower"`, `"ethash"` (lowercase, no display names like "SHA-256").
- Confirm the daemon is actually the tri-PoW build (§2.2 manual GBT test reproduces the failure without the pool).

### Ethash epoch / cache warm-up

Symptoms: first Ethash start or first job after an epoch change is slow; initial shares may lag; CPU/disk activity while the cache/DAG material is prepared.

- Treat the first start on 3335 as a warm-up: start the pool, let Ethash initialisation finish, and only then connect GPU miners and judge share latency.
- Do not restart-loop the pool during warm-up — each cold start pays it again.
- Ensure the host has enough free disk/RAM for the epoch cache for the current epoch, and that the cache directory (per the Ethash module/config in `lib/ethash/`) is writable by the pool user and persistent across restarts, so warm-up is one-time per epoch rather than per start.
- If verification fails for *every* Ethash share after warm-up completes, stop and debug verification/config — that is not warm-up behaviour.

### Other quick checks

- **Miner connects but earns nothing for a long time:** expected in solo mode if no block is solved — check shares are being *accepted* (API/dashboard), not just that the miner is hashing. Solo income is block-or-nothing.
- **Miner rejected / no jobs on one port only:** check that algorithm is enabled in config, the daemon accepts its `algo` GBT (§2.2), and no other process holds the port (`ss -ltnp | grep -E '3333|3334|3335|8080'`).
- **Dashboard loads but stats are empty:** confirm `node api/server.js` is running, the pool itself is running (the API reports the pool, it is not the pool), and you are looking at port 8080, not a stratum port.

## 8. Security notes

- **Never expose daemon RPC (8332).** Anyone who reaches RPC with the credentials controls the daemon (including wallet and generation functions). Bind it to loopback, firewall it regardless, and use a long random `rpcpassword`. The pool needs RPC; the internet does not.
- **Stratum is unauthenticated by design in solo mode.** There is no miner password database in this repo: **the payout address (username) is the identity.** Anyone can connect with any address and mine to it — that is mostly harmless because a solver can only pay the address they named, but it means: (a) miners must protect their *own* connection details if they care who can see their address/hashrate, (b) the operator must not treat a stratum username as proof of a person's identity for any out-of-band purpose, and (c) firewall/allowlist stratum ports if you run a private pool and do not want strangers mining to their own addresses through your daemon.
- **A wrong payout address loses the block.** There is no pool operator who can "re-send" a coinbase. Miners should verify their username/address before hashing; operators should say so in any onboarding material.
- **Dashboard/API (8080) leaks operational information** (hashrates, worker addresses, uptime). Put it behind a reverse proxy with authentication, a VPN, or LAN-only binding for anything beyond local testing.
- **Keep secrets out of git.** RPC credentials and any production config copies do not belong in commits, issues, screenshots, or dashboard posts.
- **Run with least privilege.** Run daemon and pool as unprivileged users, keep the host patched, and keep the `LICENSE`/attribution intact if you redistribute the pool.
