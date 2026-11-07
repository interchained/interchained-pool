# Interchained Tri-PoW Pool

## 1. What this is

A mining pool for Interchained (ITC), the chain that runs three proof-of-work algorithms at once, each with its own difficulty track:

| Algorithm | Miner class | Stratum port |
|---|---|---|
| SHA256 (`sha256`) | ASIC | 3333 |
| Yespower (`yespower`) | CPU | 3334 |
| Ethash (`ethash`) | GPU | 3335 |

One Node.js server runs all three pools against one Interchained daemon. The pool asks the daemon for work with `getblocktemplate` carrying an `algo` key, hands each miner work for the algorithm of the port they connected to, verifies shares in the pool (including real Ethash hashimoto light verification on port 3335), and submits solved blocks with `submitblock`.

Each algorithm independently runs one of three payout schemes: **solo**, **PROP**, or **PPLNS** (section 3). In group modes a payments processor splits matured block rewards among contributing miners and pays them as PSBTs from the pool wallet, with dry-run as the default (section 4). A stats API and dashboard on port 8080 show the pools, the miners, and the payouts, and phase 3 adds a public fairness layer on top of the payout ledger (section 5).

**Activation:** tri-PoW activates on Interchained mainnet at height **913982**. Before that height the daemon will reject `algo` requests for algorithms that are not yet active. Regtest is not height-gated in the same way; use it for end-to-end testing.

### Lineage and licence

- **zone117x, [`node-stratum-pool`](https://github.com/zone117x/node-stratum-pool)**: the original Node.js stratum poolserver by Matthew Little and contributors. The core stratum server, job manager, block template handling, daemon interface, and vardiff in `lib/` descend from it.
- **ethgr0wth, `node-stratum-pool-yespower`**: the fork that added Yespower hashing (via `node-multi-hashing-yespower`) and Interchained network and address support.
- **Interchained organisation**: this fork. Tri-PoW support, algo-aware `getblocktemplate` wiring, the Ethash stratum and verification module, group payout schemes with a PSBT payments processor, the stats API, the dashboard, and the fairness tooling, specialised for the Interchained chain.

**Licence: GPL-2.0.** See [`LICENSE`](LICENSE). Preserve the `LICENSE` file and this attribution when redistributing or forking.

## 2. Quickstart

Full walkthrough: [docs/SETUP.md](docs/SETUP.md).

### Prerequisites

- A tri-PoW `interchainedd` (Bitcoin-0.21-derived; its `getblocktemplate` honours the `algo` key), synced on mainnet, running with RPC enabled. Daemon RPC defaults to port 8332; daemon P2P defaults to port 17101.
- Node.js **16.20.2**, pinned in `.nvmrc`. The legacy native dependencies (`bignum`, `multi-hashing`) build under Node 16 and do not build on current Node releases (22/24). The pin is a requirement, not a preference.
- Miners for the algorithms you intend to serve.

### Install and configure

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
nvm install   # reads .nvmrc, installs Node 16.20.2
nvm use
npm install   # builds the native dependencies; needs a working C/C++ toolchain

cp .env.example .env
# Edit .env: at minimum the daemon RPC user and password (CHANGE_ME
# markers) and ITC_POOL_ADDRESS. Everything else has a stated default.
node start.js
```

Configuration comes in two layers that combine (details in section 6):

- **`.env`** (copied from [`.env.example`](.env.example)): every operator-facing setting as an `ITC_*` environment variable, annotated line by line.
- **JSON config** in `config/`: `config/interchained-mainnet.json` or `config/interchained-regtest.json`, chosen with `node start.js <path>` or `ITC_POOL_CONFIG=<path>`.

Precedence: environment > JSON config > built-in default. `node start.js` with no arguments and no `.env` uses the mainnet JSON config exactly as in earlier phases.

### Run the API and dashboard

In a second terminal:

```bash
node api/server.js        # port 8080, or PORT=<port> node api/server.js
```

Dashboard: `http://localhost:8080/`. Health check: `curl http://localhost:8080/health`.

### Connect a miner

Point the miner at the port for its algorithm, for example `stratum+tcp://<pool-host>:3334` for a Yespower CPU miner (use the exact scheme prefix your miner expects). Ethash miners on 3335 use the Ethash stratum dialect implemented in `lib/ethash/ethashStratum.js`.

- **Solo mode:** use the pool's configured payout address as the username.
- **Group modes (PROP/PPLNS):** use **your own** ITC address as the username. That address is your payout address. An optional worker suffix is accepted (`YOURADDRESS.rig1`); the address part is what identifies you. There are no accounts: a typo in the address means earnings accrue to an address you do not control, and nobody can reassign them afterwards.
- **Password:** stratum here is unauthenticated by design; use whatever password your miner requires (commonly `x`).

### Prove a checkout works

```bash
scripts/boot-proof.sh              # full boot proof against a stub daemon, miners included
node scripts/test-env-config.js    # env precedence and live-payments safety proof
scripts/check-syntax.sh            # node --check sweep
```

## 3. Payout schemes

The scheme is chosen per algorithm (`algos.<algo>.scheme` in JSON, or `ITC_<ALGO>_SCHEME` in `.env`). Algorithms can mix schemes in one deployment.

### Solo

The coinbase of every block found on that port pays the configured `address` directly. No sharing, no ledger balances, no fee: shares are tracked for vardiff and stats, but a share is not a claim on a reward. When no block is solved, nobody receives anything from that port. This is the right scheme for mining to your own wallet with your own rigs.

### The group model (PROP and PPLNS)

- The coinbase pays the configured `address`, which is now the **pool wallet**, controlled by the operator's daemon wallet.
- Miners connect with their own ITC address as username; that address is their payout address.
- The payments processor (`lib/payouts/`) records every accepted share and every found block to a JSON ledger (default `api/data/payouts.json`).
- When a group-mode block reaches the configured confirmation count (checked against the daemon with `getblock`), the processor splits its reward:
  1. The pool **fee** (`payments.feePercent`) comes off the top.
  2. The remainder splits among miners in proportion to share weight, where a share's weight is its share difficulty. Which shares count depends on the scheme.
  3. A miner below the **minimum payout** (`payments.minPayout`, in ITC) is not paid yet. The amount stays as a pending balance in the ledger and **carries over** to the next distribution. It is not lost and it is not dust-swept.
  4. Amounts at or above the minimum go into one payout batch per algorithm, built as a PSBT (section 4).

### PROP

Proportional, per round. A round is the period since the previous block found on that algorithm. A matured block's reward splits over the shares of that round only. Simple to explain and to audit; shares from earlier rounds count for nothing.

### PPLNS

Pay Per Last N Shares. A matured block's reward splits over the last N shares submitted on that algorithm before the block, across round boundaries. N is the algorithm's `pplnsWindow`, falling back to the top-level `payments.pplnsWindow`. Shares slide out of the window as newer shares arrive, so steady miners are rewarded across several blocks and pool-hopping gains little.

## 4. PSBT payout flow

Group-mode payouts are never a plain `sendmany`. Each batch is a Partially Signed Bitcoin Transaction built from the pool wallet, and it moves through separate, recorded stages:

1. **Build:** `walletcreatefundedpsbt` creates a funded PSBT paying the batch's miners. The batch is recorded in the ledger at stage `created`, with the base64 PSBT, the per-miner amounts, and the fee.
2. **Record:** the ledger entry is the public record of the batch (see the fairness section below). Anyone can inspect it through `/api/payouts` before any money moves.
3. **Sign:** `walletprocesspsbt` signs the PSBT with the pool wallet (stage `processed`). An external signer can instead take a `created` batch and finish it off-pool.
4. **Finalize:** `finalizepsbt` extracts the network transaction (stage `finalized`).
5. **Broadcast:** `sendrawtransaction` sends it, and the txid is recorded (stage `sent`).

A batch that stops mid-stages is **resumed** by the next processor run from its recorded PSBT, never rebuilt, so a batch cannot be double-created or double-paid.

**Dry-run is the default, everywhere.** With dry-run on, the processor computes and records everything (shares, blocks, splits, pending balances) and builds and records each batch PSBT, but it never calls a signing-stage RPC and never broadcasts. Going live is a deliberate act: set `payments.dryRun` to `false` in JSON, or set `ITC_PAYMENTS_LIVE=1` in the environment. That exact value, `1`, is the only environment value that enables live payments; `true`, `yes`, and even the string `false` do not. See the go-live checklist in [docs/SETUP.md](docs/SETUP.md).

## 5. Fairness

A pool holds other people's earnings between the block and the payout. This pool treats the split as public record, not operator say-so. The mechanisms (full document: [docs/FAIRNESS.md](docs/FAIRNESS.md)):

- **Per-block public breakdown.** For every group-mode block, the API publishes the split: the reward, the fee taken, the scheme and window used, and each miner's share weight and amount. The math for a block can be checked from the published numbers alone.
- **Reconciliation endpoint.** An API endpoint reconciles the ledger end to end: shares in, blocks matured, amounts split, pending balances carried, batches built and sent. Any total that does not reconcile is visible as a discrepancy, not hidden by rounding.
- **Downloadable ledger, standalone verifier.** The payout ledger can be downloaded as-is, and `scripts/verify-payout.js` recounts it independently of the pool: it replays the shares, recomputes every PROP and PPLNS split with the configured fee and minimum, and compares the result against the recorded payouts and PSBT batches. A miner does not need to trust the pool's code to check the pool's arithmetic; they need the ledger and the verifier.
- **Share-integrity rules.** Only accepted shares enter the ledger, each with its algorithm, worker, difficulty, and time. Shares cannot be backdated into a window, a block's split uses only shares recorded before it, and the recorded stage of a PSBT batch cannot move backwards. The rules are stated in [docs/FAIRNESS.md](docs/FAIRNESS.md) and enforced where the ledger is written.

## 6. Configuration reference

- [`.env.example`](.env.example): every `ITC_*` variable, grouped by section (daemon, wallets, stratum, payouts, API, storage, tuning), each with what it does, its default if unset, and what breaks or degrades without it. Copy it to `.env` and fill in the daemon lines and the pool address to boot.
- [`config/README.md`](config/README.md): the JSON config, field by field, with mainnet and group-mode examples, plus the environment override layer and its precedence rules.
- [docs/SETUP.md](docs/SETUP.md): the operator walkthrough, daemon setup, the group-pool go-live checklist, regtest recipe, firewall table, troubleshooting, and security notes.

## 7. Honest status

What is proven, and what is not. Nothing in this section is a claim beyond the evidence named.

**Proven in-environment (against a stub daemon and the project's own test clients):**

- Full pool boot on Node 16.20.2: `scripts/boot-proof.sh` passes, including sha256 and yespower full miner loops (subscribe, job, share accepted through the real native hashing paths), the Ethash dialect probe against the running pool, and `getblocktemplate` called with each algo tag. A block candidate produced a real `submitblock` to the stub.
- Ethash wired into the pool: the adapter feeds jobs from the real JobManager, verifies shares through hashimoto light verification (the verifier matches its C reference on the test vectors), assembles blocks, and submits them. Adapter suite and verifier suite pass.
- Group payouts in dry-run: hand-computed PROP and PPLNS splits, fee and minimum-payout carry-over, orphan rules, the full live PSBT stage chain against a fake daemon, and mid-stage failure resumed from the recorded PSBT with no double-pay. The dry-run proof runs over real HTTP against the stub daemon and confirms no signing-stage RPC is issued in dry-run.
- Environment configuration: `scripts/test-env-config.js` proves env > JSON > default precedence for the full variable set, and that only `ITC_PAYMENTS_LIVE=1` turns dry-run off. The boot proof also boots a second pool instance configured only through the environment (ports, schemes, fee, pool name) and confirms the API reports those env-supplied values.

**Still needs a real daemon (not claimed):**

- **Live PSBT broadcast.** No live (non-dry-run) payout has been made by this software. The stage chain is proven against a fake wallet, not against a funded real wallet.
- **Real miner wire compatibility.** Miners so far are the project's own test clients. Off-the-shelf ASIC, CPU, and GPU miners may have dialect quirks, especially on the Ethash port, that only real hardware will surface. The Ethash header-hash byte order, self-consistent in tests, still wants one cross-check against a live daemon.
- **A regtest run, then mainnet.** Everything above ran against a stub daemon. The owed proof is the same path against a real tri-PoW `interchainedd` on regtest (the recipe is in [docs/SETUP.md](docs/SETUP.md)), and only then on mainnet at or after height 913982.
- **Dashboard rendering** was not screenshot-verified; the API behind it is test-verified.

**Known limits:**

- Pure-JS Ethash verification costs about 44 ms per share with about 6.5 to 8.5 s cache generation per epoch, which caps Ethash share throughput. Epoch caches (about 17 MB each) are held in memory and not evicted.
- The stats API and dashboard expose operational information (hashrates, worker addresses, payout state). Run them on a trusted interface or behind a proxy or VPN.

## Licence

GPL-2.0. See [`LICENSE`](LICENSE).
