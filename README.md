# Interchained Tri-PoW Pool

A mining pool for Interchained (ITC) that serves all three of the chain's proof-of-work algorithms — SHA-256, Yespower, and Ethash — from one Node.js stratum server, with three payout schemes: **solo**, **PPLNS**, and **PROP**. The pool talks to a tri-PoW-aware `interchainedd` via `getblocktemplate` with an `algo` key, hands each miner work for the algorithm of the stratum port they connected to, verifies shares in-pool (including real Ethash hashimoto light verification on the Ethash port), and submits solved blocks with `submitblock`. In solo mode the coinbase pays the configured address directly, as in phase 1. In the group modes (PPLNS/PROP) the coinbase pays the pool wallet and a payments processor splits each matured block reward among the miners who contributed shares, weighted by share difficulty. A stats API and a web dashboard on port 8080 show what the pool, its miners, and its payouts are doing.

## Lineage and attribution

This project stands on upstream work, preserved here in full:

- **zone117x — [`node-stratum-pool`](https://github.com/zone117x/node-stratum-pool)** — the original high-performance Node.js stratum poolserver by Matthew Little and contributors. The core stratum server, job manager, block template handling, daemon interface, peer handling, and vardiff in `lib/` descend from it.
- **ethgr0wth — `node-stratum-pool-yespower`** — a fork of the above that added Yespower hashing (via `node-multi-hashing-yespower`) and Interchained network/address support.
- **Interchained organisation (`interchained`)** — this fork: tri-PoW support (SHA-256 + Yespower + Ethash), algo-aware `getblocktemplate` wiring, an Ethash stratum/verification module wired into the pool, group payout schemes (PPLNS/PROP) with a payments processor, a stats API, and a dashboard, specialised for the Interchained chain.

**Licence: GPL-2.0.** See [`LICENSE`](LICENSE) for the full text. Preserve the `LICENSE` file and this attribution when redistributing or forking — the GPL-2.0 terms that applied upstream apply to this work too.

## Features

- **Tri-PoW, three stratum ports** — SHA-256 (ASIC), Yespower (CPU), and Ethash (GPU), each with its own difficulty track on the chain and its own stratum listener (see the connection table below).
- **Three payout schemes, per algorithm** — each algorithm's config entry carries a `"scheme"`: `"solo"`, `"pplns"`, or `"prop"`. You can run SHA-256 solo and Yespower as a PPLNS group pool from the same config. See [Payout schemes](#payout-schemes).
- **Ethash verified in-pool** — the Ethash instance on port 3335 speaks the Ethash stratum dialect (see `lib/ethash/ethashStratum.js`), takes its job feed from `getblocktemplate`, and verifies every share with real hashimoto light verification in the pool path before accepting it; solved blocks are assembled by the pool and submitted with `submitblock`.
- **Algo-aware block templates** — the pool requests templates from the daemon with `getblocktemplate` carrying an `"algo"` key (`"sha256"` | `"yespower"` | `"ethash"`), so miners only receive work for the algorithm they connected for.
- **Payments processor** — for group-mode algorithms, `lib/payouts/` records every accepted share and found block to a JSON ledger (`api/data/payouts.json`) and, once a block reaches the configured confirmation count, splits the reward among contributing miners (fee deducted first, minimum payout with carry-forward) and pays each algorithm batch out as a **PSBT** built from the pool wallet (signing and broadcast are separate, explicit stages). **Dry-run is the default**: it builds and records the batch PSBT but never signs or broadcasts. See [Payout schemes](#payout-schemes) and `docs/SETUP.md`.
- **Stats API** — a small HTTP service in `api/` (`node api/server.js`) on port 8080: `/health`, `/api/stats`, `/api/config` (per-algo scheme plus a payments summary), `/api/miner/<address>`, and `/api/payouts`. Block entries carry their distribution status.
- **Dashboard** — a static web UI in `ui/` served alongside the API on port 8080, with per-algo scheme badges, a pool payouts panel (with a visible **DRY-RUN** indicator when payments are in dry-run), and a miner lookup by address.
- **Inherited stratum machinery** — daemon RPC interface, job manager, vardiff (variable difficulty), connection/banning protections against flood/zombie workers, and block submission via `submitblock`.

> **Activation note:** tri-PoW activates on Interchained mainnet at **height 913982**. Before that height only the legacy algorithms are valid on mainnet, and the daemon will reject `algo` requests for algorithms that are not yet active. Regtest is not height-gated in the same way — use it for end-to-end testing (see `docs/SETUP.md`).

## Quickstart

Full operator walkthrough: **[docs/SETUP.md](docs/SETUP.md)**. The short version:

### Prerequisites

- A **tri-PoW `interchainedd`** (Bitcoin-0.21-derived Interchained daemon whose `getblocktemplate` honours the `"algo"` key), synced (on mainnet) and running with RPC enabled. Daemon RPC defaults to port **8332**; daemon P2P defaults to port **17101**.
- **Node.js 16.20.2** (pinned in `.nvmrc`; install with `nvm install` / `nvm use`). The pool's legacy native dependencies (`bignum`, `multi-hashing`) build under Node 16; they do **not** build on current Node releases (22/24), so the pin is a requirement, not a preference.
- Miners appropriate to the algorithm(s) you intend to serve (ASIC, CPU, or GPU — see the table below).

### Configure

```bash
cp config/interchained-mainnet.json config/local.json   # or edit the example in place
# Edit: daemon RPC host/port/user/password, payout/coin settings, enabled ports.
# A regtest example is provided alongside the mainnet one in config/.
```

Pool configuration files live in `config/*.json`. Start from `config/interchained-mainnet.json` for mainnet, or the regtest variant in the same directory for local testing. Field-by-field documentation — including the payout `scheme` fields and the top-level `payments` object — is in [`config/README.md`](config/README.md). Never commit real RPC credentials.

### Run the pool

```bash
npm install
node start.js
```

### Run the stats API and open the dashboard

In a second terminal:

```bash
node api/server.js
```

Then open the dashboard in a browser:

```text
http://localhost:8080/
```

The API answers at `http://localhost:8080/health` and `http://localhost:8080/api/stats`. Smoke-check a checkout with `scripts/smoke-test.sh` and syntax-check the JavaScript with `scripts/check-syntax.sh`.

### Connect a miner

Point the miner at the stratum port for its algorithm (table below). In **solo** mode, use the pool's configured payout address as the username. In **group modes (PPLNS/PROP)**, use **your own** ITC address as the username — that address is where your share of block rewards is paid.

## Miner connection

| Algorithm | Stratum port | Miner class | Username rule |
|---|---|---|---|
| SHA-256 (`sha256`) | 3333 | ASIC miner (e.g. SHA-256 ASIC hardware) | Solo: the configured payout address. Group: your own ITC address |
| Yespower (`yespower`) | 3334 | CPU miner (Yespower-capable CPU miner) | Solo: the configured payout address. Group: your own ITC address |
| Ethash (`ethash`) | 3335 | GPU miner (Ethash-capable GPU miner, Ethash stratum dialect) | Solo: the configured payout address. Group: your own ITC address |

- **Host:** the pool host (e.g. `stratum+tcp://<pool-host>:3334` — use the exact scheme/prefix your miner expects). Ethash miners connect to 3335 and use the Ethash stratum dialect implemented in `lib/ethash/ethashStratum.js` (subscribe / authorize / notify / submit, with shares carrying a nonce and a mix hash).
- **Username = payout identity.** An optional worker suffix (e.g. `address.worker1`) may follow the address; the address part is what identifies the miner. In group modes the address in your username **is** your payout address — double-check it: a typo means your earnings accrue to an address you do not control, and there is no account system to fix it afterwards.
- **Password:** stratum in this design is unauthenticated (see the security notes in `docs/SETUP.md`); use whatever password your miner requires (commonly `x`) unless your deployment adds its own policy.

## Payout schemes

The scheme is chosen **per algorithm** with the `"scheme"` field in that algorithm's config entry. The three schemes differ in who the coinbase pays and how a block reward reaches miners.

### Solo (`"scheme": "solo"`)

The phase-1 behaviour, unchanged:

- The coinbase of every block found on that port pays the pool's configured `address` directly — the full block reward lands in that wallet as a normal coinbase output once the block is accepted by the network and matures under the chain's normal coinbase rules.
- There is no sharing: when no block is solved, nobody receives anything from that port. Shares are tracked for vardiff, stats, and the dashboard, but they are **not** a claim on a block reward.
- Because payment is in the coinbase itself, the pool holds no balances for that algorithm, and the payments processor does not distribute solo blocks. This is the right scheme for mining to your own wallet, alone or with your own rigs.

### Group modes: the common model (PROP and PPLNS)

In a group mode the economics invert:

- The coinbase pays the pool's configured `address` — the **pool wallet**, controlled by the operator's daemon wallet.
- Miners connect with **their own ITC address** as the stratum username (optional `.worker` suffix). That address is their payout address.
- The payments processor (`lib/payouts/`) records **every accepted share and every found block** to a JSON ledger at `api/data/payouts.json`.
- When a group-mode block reaches the configured **confirmation count** (checked against the daemon with `getblock`), the processor splits that block's reward:
  1. The pool **fee** (`payments.feePercent`) is deducted first.
  2. The remainder is split among miners in proportion to their share weights, where each share's weight is its **share difficulty**. Which shares count depends on the scheme (below).
  3. A miner whose total is below **`payments.minPayout`** (in ITC) is not paid yet — the amount stays as a **pending balance** in the ledger and carries forward to the next distribution.
  4. All amounts at or above the minimum go into **one payout batch per algorithm, built as a PSBT** from the pool wallet (`walletcreatefundedpsbt`). The batch is recorded in the ledger with its base64 PSBT, per-miner amounts, and stage. In live mode the processor walks the signing stages as separate explicit steps — `walletprocesspsbt` → `finalizepsbt` → `sendrawtransaction` — and records the txid; a batch that stops mid-stages is **resumed** by a later run from its recorded PSBT, never rebuilt (so it can never double-pay). Because the batch PSBT and its stage are exposed in the API (`/api/payouts`), an external signer can take a `created` batch and finish it outside the pool instead.
- Distributions are evaluated on the payments interval (`payments.intervalSeconds`); a block's distribution status is visible in the API and dashboard.

### PROP (`"scheme": "prop"`)

Proportional, per round. A **round** is the period since the previous block found on that algorithm. When a block matures, the reward is split in proportion to the shares each miner contributed **in that round only** — shares from earlier rounds count for nothing. Simple and easy to audit; miners who hop between pools keep only what they contributed to the round that actually found the block.

### PPLNS (`"scheme": "pplns"`)

Pay Per Last N Shares. When a block matures, the reward is split in proportion to the **last N shares** submitted on that algorithm before the block, regardless of round boundaries. The window size N is the algorithm's `"pplnsWindow"` if set, otherwise the top-level `payments.pplnsWindow` default. Shares slide out of the window as newer shares arrive, so steady miners are rewarded across several blocks and pool-hopping gains little.

### Fees, minimums, confirmations — and dry-run

- **Fee:** `payments.feePercent` is taken off the top of each group-mode block reward before the split. Solo blocks are not charged by this software.
- **Minimum payout:** `payments.minPayout` (ITC) keeps dust from being sent; sub-minimum earnings are not lost, they carry forward as pending balances.
- **Confirmations:** `payments.confirmations` is how deep a block must be (per the daemon's `getblock`) before its reward is distributed — set it at or above the chain's coinbase maturity so the processor never tries to spend an immature or orphaned reward.
- **Dry-run (the default):** with `"dryRun": true`, the processor computes and records everything — shares, blocks, splits, pending balances — and builds each payout batch's PSBT, recording it at stage `created`, but **never calls a signing-stage RPC** (`walletprocesspsbt` / `finalizepsbt` / `sendrawtransaction`). Run in dry-run first, watch the ledger and `/api/payouts`, and only set `"dryRun": false` when the numbers look right and the pool wallet is funded with the matured rewards. The full go-live checklist is in `docs/SETUP.md`.

## Project layout

```text
.
├── start.js                  # Pool entry point: loads config/*.json, starts stratum listeners
├── lib/                      # Stratum pool core (from node-stratum-pool lineage)
│   ├── pool.js               # Pool orchestration
│   ├── stratum.js            # Stratum TCP server
│   ├── jobManager.js         # Job / share processing
│   ├── blockTemplate.js      # getblocktemplate handling (algo-aware)
│   ├── daemon.js             # Daemon RPC client (GBT / submitblock)
│   ├── algoProperties.js     # Algorithm definitions (sha256, yespower, ethash, …)
│   ├── ethash/               # Ethash stratum dialect + hashimoto verification (wired into the ethash pool)
│   └── payouts/              # Payments processor: share/block ledger, PROP/PPLNS splits, PSBT payout batches
├── api/
│   ├── server.js             # Stats/payouts API + dashboard host (port 8080)
│   └── data/payouts.json     # Payments ledger written by lib/payouts/ (created at runtime)
├── ui/                       # Dashboard web UI (app.js, styles, markup)
├── config/                   # Example pool configs — see config/README.md
│   ├── interchained-mainnet.json
│   └── *regtest*.json        # Regtest variant for local end-to-end testing
├── docs/
│   └── SETUP.md              # Operator setup, group-pool walkthrough, regtest recipe, troubleshooting, security
├── scripts/
│   ├── check-syntax.sh       # node --check sweep (CI-friendly, skip-tolerant)
│   └── smoke-test.sh         # Syntax sweep + API boot smoke test
├── package.json
└── LICENSE                   # GPL-2.0 — preserve it
```

Exact filenames inside `config/`, `api/`, and `ui/` follow the integrated layout above; if a checkout predates one of those directories, the scripts in `scripts/` will report it as `SKIP` rather than failing.

## Status — what is proven, what is pending

Honest status, carried forward from the phase-1 evidence and updated for phase 2. Phase-2 items are **being verified in phase 2** by the lanes building them; this section is reconciled at integration, and an item below is not a claim until that reconciliation says so.

**Proven in phase 1:**

- Syntax and smoke checks pass on the integrated tree (`scripts/check-syntax.sh` 21/21; API boot with `/health` and `/api/stats` answering).
- The stats collector wiring in `start.js` was exercised against a test pool: shares and blocks moved the stats exactly as expected, and persisted state reloaded correctly.
- The Ethash verifier itself is proven standalone: the JavaScript hashimoto-light implementation matched the vendored C reference byte-for-byte across its test vectors (epochs 0 and 30), and the standalone Ethash stratum server passed a live-TCP smoke test (subscribe / notify / authorize / share / block flag) against a test client.
- `getblocktemplate` `algo` injection and `submitblock` forcing were verified against the code and the contract in a stubbed harness (three pools built with the correct ports).

**Phase 2 results (verified in-environment, against a stub daemon):**

- **Full pool boot — proven.** The runtime story is **Node 16.20.2 via nvm** (`.nvmrc` + `engines`), under which the legacy native dependencies build cleanly. `scripts/boot-proof.sh` passes on the integrated tree: all three pools boot through `start.js`, `getblocktemplate` is called with each algo tag, sha256 and yespower complete the full miner loop (subscribe → job → share accepted through the real native hashing path), and a block candidate produced a real `submitblock`. The group-mode configuration also boots with the ledger and payments processor started.
- **Ethash wired into the pool — proven against the stub.** The ethash instance runs with no classic ports; `lib/ethash/ethashPool.js` attaches on pool start, feeds jobs from the real JobManager, verifies shares through hashimoto-light, assembles blocks with nonce64 + mixHash, and calls `submitblock` (adapter suite 25/25, including the exact 125-byte submission; verifier still 33/33 against the C reference). The boot proof's Ethash-dialect probe (subscribe / authorize / notify) passes against the running pool.
- **Group payouts — proven in dry-run.** The processor suite passes 55/55: exact hand-computed PROP and PPLNS splits, fee and min-payout carry-over, orphan rules, the full live PSBT stage chain against a fake daemon, and mid-stage failure → next-run resume of the same PSBT (no double-pay). `scripts/payments-dryrun-proof.js` additionally proves the dry-run end to end over real HTTP against the stub daemon: the batch PSBT is built and recorded at stage `created`, and no signing-stage RPC is issued. **No live (non-dry-run) payout has been made by this software, and none of this has run against a real Interchained daemon or wallet.**

**Still not claimed:**

- **Live daemon / real miners.** Everything above ran against a stub daemon and the project's own test clients. A regtest (then mainnet) run against the real tri-PoW `interchainedd` is still the owed proof; real Ethash miner wire compatibility beyond the project's own probe is unproven, and the adapter's Ethash header-hash byte order — self-consistent in tests — still wants one cross-check against a live daemon.
- **Dashboard rendering** was not screenshot-verified; the API behind it is test-verified (43 checks, including PSBT/stage surfacing and miner lookup).

**Known limits (phase 1 measurements, still relevant):**

- Pure-JS Ethash verification costs ~44 ms per share with ~6.5–8.5 s cache generation per epoch, which caps Ethash share throughput; epoch caches (~17 MB each) are held in memory and not evicted.
- A fresh checkout's `npm install` on Node 24 was broken by the legacy native modules in phase 1 (the pure-JS `js-sha3` dependency installs cleanly on its own).

## Future work

- Additional operational hardening (metrics/alerting, multi-daemon failover tuning) as the tri-PoW mainnet deployment matures past height 913982.

## Licence

GPL-2.0 — see [`LICENSE`](LICENSE).
