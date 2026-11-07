# Interchained Tri-PoW Pool — Operator Setup

This walkthrough takes an operator from a bare host to a running tri-PoW pool: SHA-256 on stratum port 3333, Yespower on 3334, Ethash on 3335, with the stats API and dashboard on 8080.

Payout model reminder: the scheme is **per algorithm** — `"solo"`, `"pplns"`, or `"prop"`. In solo mode the coinbase pays the pool's configured `address` directly. In the group modes (PPLNS/PROP) the coinbase pays the pool wallet and the payments processor splits matured block rewards among miners (see §9, "Running a group pool"). Field-by-field config documentation is in `config/README.md`.

---

## 1. Prerequisites

- A tri-PoW build of `interchainedd` (Bitcoin-0.21-derived; its `getblocktemplate` honours an `"algo"` key: `"sha256"` | `"yespower"` | `"ethash"`, and `generatetoaddress` takes an `"algo"` argument — useful on regtest).
- Node.js **16.20.2** and npm — pinned in `.nvmrc` (`nvm install && nvm use`). The legacy native dependencies (`bignum`, `multi-hashing`) build under Node 16 and fail on current Node (22/24); the pin is a hard requirement, proven by `scripts/boot-proof.sh`.
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
6. **Payout scheme per algorithm** — each entry under `algos` carries a `"scheme"`: `"solo"`, `"pplns"`, or `"prop"`. A `"pplns"` entry may also carry `"pplnsWindow"` (the number of shares in its PPLNS window; omit it to use the top-level default). Leave every algorithm on `"solo"` for a phase-1-style solo pool.
7. **Payments (group modes only)** — the top-level `"payments"` object controls the payments processor: `enabled`, `dryRun` (default `true` — keep it `true` until §9's checklist), `feePercent`, `minPayout`, `confirmations`, `intervalSeconds`, and the default `pplnsWindow`. In solo mode the meaning of `address` is unchanged: it is the address the coinbase pays. In group modes `address` is the **pool wallet** address (see §9.1) — the coinbase pays it, and miners use their own addresses as stratum usernames.

For regtest, copy the same walkthrough in the regtest file: daemon host/port must point at your `interchainedd -regtest` instance (its RPC port is whatever you set for regtest — set it explicitly in both `interchained.conf`/daemon flags and the pool config so the two agree), and stratum ports may stay 3333/3334/3335 if nothing else is using them.

> Never commit real RPC credentials. Keep production configs out of git or with secrets redacted, and restrict file permissions (`chmod 600`).

### 3.1 Environment configuration (`.env`) - the recommended layer

Instead of editing JSON, you can run the pool from an environment file. Copy the annotated example at the repo root, fill in at least the daemon credentials and the pool address, and start as usual:

```bash
cp .env.example .env
# edit .env: ITC_DAEMON_USER, ITC_DAEMON_PASSWORD, ITC_POOL_ADDRESS
node start.js
```

`start.js` loads `.env` automatically when it exists. Every operator-facing setting has a variable there, grouped by section (daemon, wallets, stratum, payouts, API, storage, tuning), each with its default and what breaks without it: daemon RPC host/port/user/password, the pool address and pool name, per-algorithm stratum ports, schemes and PPLNS windows, the fee, minimum payout and confirmation count, payments enabled and the ledger path, and the API port and host.

Precedence: **environment > JSON config > built-in default**. A variable exported in your shell outranks the `.env` file. Unset or empty variables change nothing; invalid values stop startup with an error naming the variable. The JSON file still selects with `ITC_POOL_CONFIG` or the `start.js` argument, and stays the base layer, so a phase-1 or phase-2 JSON-only setup keeps working unchanged.

One safety rule to know before §9: from the environment, dry-run turns off **only** with `ITC_PAYMENTS_LIVE=1`, that exact value. `ITC_PAYMENTS_LIVE=true`, `=yes`, and even `=false` do not enable live payments, and `ITC_PAYMENTS_DRY_RUN` can only force dry-run back on. Prove it any time with `node scripts/test-env-config.js`.

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
- **Stratum is unauthenticated by design.** There is no miner password database in this repo: **the payout address (username) is the identity.** Anyone can connect with any address and mine to it — in solo mode a solver can only pay the address they named, and in group modes shares (and therefore earnings) accrue to whatever address a miner names — but it means: (a) miners must protect their *own* connection details if they care who can see their address/hashrate, (b) the operator must not treat a stratum username as proof of a person's identity for any out-of-band purpose, and (c) firewall/allowlist stratum ports if you run a private pool and do not want strangers mining through your daemon.
- **A wrong payout address loses the reward.** In solo mode there is no pool operator who can "re-send" a coinbase; in group modes earnings accrue to the named address and cannot be reassigned afterwards. Miners should verify their username/address before hashing; operators should say so in any onboarding material.
- **Dashboard/API (8080) leaks operational information** (hashrates, worker addresses, uptime). Put it behind a reverse proxy with authentication, a VPN, or LAN-only binding for anything beyond local testing.
- **Keep secrets out of git.** RPC credentials and any production config copies do not belong in commits, issues, screenshots, or dashboard posts.
- **Run with least privilege.** Run daemon and pool as unprivileged users, keep the host patched, and keep the `LICENSE`/attribution intact if you redistribute the pool.

## 9. Running a group pool (PPLNS/PROP)

Solo (§1–§8) pays the configured `address` in the coinbase and needs no wallet management beyond your own. A group pool shares block rewards among everyone mining on an algorithm. This section walks through turning one or more algorithms into a group pool. Read it fully before enabling payments with real funds.

### 9.1 Wallet setup — the pool wallet

In group modes the coinbase pays the pool's configured `address`. That address is the **pool wallet**, and two requirements follow:

- **The daemon wallet must control the `address`.** The coinbase pays `address`, and payouts are built from the pool wallet as PSBTs over daemon RPC (`walletcreatefundedpsbt`, then the signing stages). The wallet loaded in `interchainedd` must own `address` (its private key), or it can neither receive the rewards as spendable balance nor fund the distributions.
- **The wallet must hold the matured rewards.** Payouts come out of block rewards — there is no separate float to fund. A block's reward only becomes spendable after it matures on-chain, which is why `payments.confirmations` (§9.3) must be set at or above the chain's coinbase maturity: the processor distributes a block only once the daemon reports it at the configured confirmation count via `getblock`. Do not set a lower value to "pay faster" — the funds are not spendable yet, and an orphaned block's reward does not exist at all.

Because the daemon wallet is a **hot wallet** holding pool funds on an internet-connected host, treat it accordingly (§9.5).

Set the pool wallet address as `address` in the pool config, and tell your miners: **connect with your own ITC address as the stratum username** (an optional `.worker` suffix is fine). That address is their payout address — there are no accounts, no registration, and no way to change it after shares are recorded.

### 9.2 Choosing a scheme per algorithm

Each algorithm is configured independently:

```json
{
  "algos": {
    "sha256":   { "scheme": "solo" },
    "yespower": { "scheme": "pplns", "pplnsWindow": 10000 },
    "ethash":   { "scheme": "prop" }
  }
}
```

(Only the scheme fields are shown; each entry keeps its `enabled`, `stratumPort`, `diff`, and `varDiff` settings as in §3.)

- **solo** — coinbase direct to `address`; the payments processor does not distribute that algorithm's blocks. Right for your own rigs.
- **prop** — a block's reward is split over the shares of the *current round* (since the previous block on that algorithm). Easiest to explain and audit.
- **pplns** — a block's reward is split over the *last N shares* before the block, across round boundaries. N is the algorithm's `pplnsWindow`, falling back to the top-level `payments.pplnsWindow`. Fairer to steady miners under pool-hopping.

You can mix schemes freely — e.g. solo SHA-256 for your own ASICs and a PPLNS Yespower pool for the public.

### 9.3 Tuning: fee, minimum payout, confirmations

The top-level `payments` object (see `config/README.md` for every field):

```json
{
  "payments": {
    "enabled": true,
    "dryRun": true,
    "feePercent": 1.0,
    "minPayout": 1.0,
    "confirmations": 100,
    "intervalSeconds": 600,
    "pplnsWindow": 5000
  }
}
```

- **`feePercent`** — deducted from each group-mode block reward before the split. `0` is valid (a no-fee pool); anything above a few percent will read as expensive to miners. State it publicly wherever you advertise the pool.
- **`minPayout`** (ITC) — miners below this total keep a pending balance that carries forward instead of being sent dust every block. Too high and small miners wait a long time to see a first payout; too low and transaction fees eat the distributions.
- **`confirmations`** — how deep a block must be before its reward is distributed. **Set it at or above the chain's coinbase maturity** (§9.1). Raising it further trades payout latency for safety against reorgs.
- **`intervalSeconds`** — how often the processor checks for newly-matured blocks and runs distributions. 600 (10 minutes) is a sane default; very small values just poll the daemon more.
- **`pplnsWindow`** (top level) — the default PPLNS window in *shares* for algorithms that do not set their own. Larger windows smooth income across more blocks; smaller windows track recent hashing more closely.

### 9.4 Enabling payments — dry-run first

1. Set `"enabled": true` and keep `"dryRun": true` (the default) in `payments`.
2. Start the pool and API as in §4.
3. **Watch the dry-run.** The processor records every accepted share and found block to the ledger at `api/data/payouts.json`, computes each matured block's split (fee, per-miner amounts, pending balances), and builds the payout batch's PSBT via `walletcreatefundedpsbt`, recording the batch with its base64 PSBT at stage `created` — but with `dryRun: true` it **never calls the signing stages** (`walletprocesspsbt`, `finalizepsbt`, `sendrawtransaction`) and no funds move. The batch PSBT is also visible via `/api/payouts`, so an external signer could take a `created` batch and finish it off-pool. Check the same data through the API:
   - `curl http://localhost:8080/api/payouts` — recorded distributions and their status;
   - `curl http://localhost:8080/api/miner/<address>` — a miner's shares, pending balance, and payouts;
   - `curl http://localhost:8080/api/config` — confirm each algorithm's scheme and the payments summary (including dry-run) match your config;
   - the dashboard's pool payouts panel shows the same picture, with a **DRY-RUN** indicator while dry-run is on.
4. Let at least one group-mode block mature in dry-run and verify the split by hand against the ledger: weights are share difficulties, the fee comes off first, and sub-`minPayout` amounts sit in pending balances rather than vanishing. The same check is available to your miners at any time: the per-block breakdown and reconciliation in the API, the downloadable ledger, and the standalone recount in `scripts/verify-payout.js` are documented in `docs/FAIRNESS.md`.

### 9.5 Go-live checklist

Only when the dry-run numbers are right:

- [ ] `payments.enabled` is `true` and the schemes in `/api/config` match your intent per algorithm.
- [ ] The daemon wallet controls the configured `address` and holds the matured rewards (`interchained-cli getbalance`); `payments.confirmations` is at or above coinbase maturity.
- [ ] The ledger `api/data/payouts.json` is backed up, and a backup routine exists (§9.6).
- [ ] Set **`"dryRun": false`** — this is the single switch that authorises the real PSBT signing stages and broadcast (`walletprocesspsbt` → `finalizepsbt` → `sendrawtransaction`) — and restart the pool. If you run from `.env`, the equivalent is `ITC_PAYMENTS_LIVE=1` (that exact value; see §3.1).
- [ ] Watch the first real distribution: find its entry in `/api/payouts` / the ledger and confirm the recorded **txid** on the daemon (`interchained-cli gettransaction <txid>`), the recipient amounts, and that pending balances updated as expected.
- [ ] Confirm the dashboard's DRY-RUN indicator is gone.

### 9.6 Operator warnings

- **Hot wallet risk.** Going live means an internet-reachable daemon wallet holds every group-mode block reward until distribution. Keep the host patched and RPC on loopback (§8), consider sweeping excess balance to cold storage manually, and never run a group pool from a wallet that also holds unrelated funds.
- **Back up the ledger.** `api/data/payouts.json` is the record of who contributed what, who is owed a pending balance, and what has already been paid (txids included). Losing it loses the pending balances. Back it up like a wallet.
- **Restarts are safe by design.** The ledger persists on disk; on restart the processor reloads it and resumes — shares, rounds/windows, pending balances, and recorded payouts survive. Do not delete or hand-edit the ledger of a running pool; stop the pool first if you must inspect or restore it, and restore from backup rather than reconstructing by hand.
- **Dry-run records are records.** Dry-run distributions are written to the same ledger. When you go live, be sure you and your miners understand which recorded payouts were dry-run (never sent) — the API and dashboard mark dry-run state; the txid is the ground truth for "was this actually paid".
