# Interchained Tri-PoW Pool

A solo mining pool for Interchained (ITC) that serves all three of the chain's proof-of-work algorithms — SHA-256, Yespower, and Ethash — from one Node.js stratum server. The pool talks to a tri-PoW-aware `interchainedd` via `getblocktemplate` with an `algo` key, hands each miner work for the algorithm of the stratum port they connected to, verifies shares (including Ethash verification in `lib/ethash/`), submits solved blocks with `submitblock`, and pays the block reward directly in the coinbase to the miner's own address — there is no pool wallet holding miner funds. A small stats API and a web dashboard on port 8080 show what the pool and its miners are doing.

## Lineage and attribution

This project stands on upstream work, preserved here in full:

- **zone117x — [`node-stratum-pool`](https://github.com/zone117x/node-stratum-pool)** — the original high-performance Node.js stratum poolserver by Matthew Little and contributors. The core stratum server, job manager, block template handling, daemon interface, peer handling, and vardiff in `lib/` descend from it.
- **ethgr0wth — `node-stratum-pool-yespower`** — a fork of the above that added Yespower hashing (via `node-multi-hashing-yespower`) and Interchained network/address support.
- **Interchained organisation (`interchained`)** — this fork: tri-PoW support (SHA-256 + Yespower + Ethash), algo-aware `getblocktemplate` wiring, an Ethash stratum/verification module, a stats API, and a dashboard, specialised for the Interchained chain.

**Licence: GPL-2.0.** See [`LICENSE`](LICENSE) for the full text. Preserve the `LICENSE` file and this attribution when redistributing or forking — the GPL-2.0 terms that applied upstream apply to this work too.

## Features

- **Three algorithms, three stratum ports** — SHA-256 (ASIC), Yespower (CPU), and Ethash (GPU), each with its own difficulty track on the chain and its own stratum listener (see the connection table below).
- **Algo-aware block templates** — the pool requests templates from the daemon with `getblocktemplate` carrying an `"algo"` key (`"sha256"` | `"yespower"` | `"ethash"`), so miners only receive work for the algorithm they connected for.
- **Solo mining only** — the coinbase pays the connecting miner's own address (see [Solo payouts](#solo-payouts)). No shared pool wallet, no balances held by the pool.
- **Ethash support** — Ethash stratum handling and share/block verification under `lib/ethash/`, including epoch/cache handling (expect a warm-up on first start — see `docs/SETUP.md`).
- **Stats API** — a small HTTP service in `api/` (`node api/server.js`) serving pool/miner statistics, including `/health` and `/api/stats`, on port 8080.
- **Dashboard** — a static web UI in `ui/` served alongside the API on port 8080, reading the stats API.
- **Inherited stratum machinery** — daemon RPC interface, job manager, vardiff (variable difficulty), connection/banning protections against flood/zombie workers, and block submission via `submitblock`.

> **Activation note:** tri-PoW activates on Interchained mainnet at **height 913982**. Before that height only the legacy algorithms are valid on mainnet, and the daemon will reject `algo` requests for algorithms that are not yet active. Regtest is not height-gated in the same way — use it for end-to-end testing (see `docs/SETUP.md`).

## Quickstart

Full operator walkthrough: **[docs/SETUP.md](docs/SETUP.md)**. The short version:

### Prerequisites

- A **tri-PoW `interchainedd`** (Bitcoin-0.21-derived Interchained daemon whose `getblocktemplate` honours the `"algo"` key), synced (on mainnet) and running with RPC enabled. Daemon RPC defaults to port **8332**; daemon P2P defaults to port **17101**.
- **Node.js** (a current LTS release) and npm.
- Miners appropriate to the algorithm(s) you intend to serve (ASIC, CPU, or GPU — see the table below).

### Configure

```bash
cp config/interchained-mainnet.json config/local.json   # or edit the example in place
# Edit: daemon RPC host/port/user/password, payout/coin settings, enabled ports.
# A regtest example is provided alongside the mainnet one in config/.
```

Pool configuration files live in `config/*.json`. Start from `config/interchained-mainnet.json` for mainnet, or the regtest variant in the same directory for local testing. Never commit real RPC credentials.

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

Point the miner at the stratum port for its algorithm (table below), with the username set to the Interchained address you want the coinbase to pay.

## Miner connection

| Algorithm | Stratum port | Miner class | Username rule |
|---|---|---|---|
| SHA-256 (`sha256`) | 3333 | ASIC miner (e.g. SHA-256 ASIC hardware) | Your Interchained payout address |
| Yespower (`yespower`) | 3334 | CPU miner (Yespower-capable CPU miner) | Your Interchained payout address |
| Ethash (`ethash`) | 3335 | GPU miner (Ethash-capable GPU miner) | Your Interchained payout address |

- **Host:** the pool host (e.g. `stratum+tcp://<pool-host>:3334` — use the exact scheme/prefix your miner expects).
- **Username = payout address.** In solo mode the username *is* the payout identity: the coinbase of any block you solve pays that address. Double-check it — a typo means a solved block pays someone else (or an unusable address). A worker suffix (e.g. `address.worker1`) may be accepted by miners that require one; the address part is what is paid.
- **Password:** stratum in this solo design is unauthenticated (see the security notes in `docs/SETUP.md`); use whatever password your miner requires (commonly `x`) unless your deployment adds its own policy.

## Solo payouts

This is a **solo** pool, by design:

- When *your* miner solves a block, the block's coinbase pays **your address directly** — the full block reward (less any transaction fees included in the block, which follow the block itself) lands in your wallet as a normal coinbase output once the block is accepted by the network and matures under the chain's normal coinbase rules.
- When you do *not* solve a block, you receive nothing from the pool. There are no shares-based balances, no proportional splits, and no pool wallet accumulating rewards for later distribution.
- Shares are still tracked by the pool (for vardiff, stats, and the dashboard), but in solo mode shares are **not** a claim on anyone else's block reward.
- Because payment is in the coinbase itself, the pool never custodies miner funds and there is no payout threshold, payout schedule, or payout fee charged by this software.

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
│   └── ethash/               # Ethash stratum support and verification
├── api/
│   └── server.js             # Stats API + dashboard host (port 8080; /health, /api/stats)
├── ui/                       # Dashboard web UI (app.js, styles, markup)
├── config/                   # Example pool configs
│   ├── interchained-mainnet.json
│   └── *regtest*.json        # Regtest variant for local end-to-end testing
├── docs/
│   └── SETUP.md              # Operator setup, regtest recipe, troubleshooting, security
├── scripts/
│   ├── check-syntax.sh       # node --check sweep (CI-friendly, skip-tolerant)
│   └── smoke-test.sh         # Syntax sweep + API boot smoke test
├── package.json
└── LICENSE                   # GPL-2.0 — preserve it
```

Exact filenames inside `config/`, `api/`, and `ui/` follow the integrated layout above; if a checkout predates one of those directories, the scripts in `scripts/` will report it as `SKIP` rather than failing.

## Future work

- **PPLNS / PROP accounting and pooled payouts are future portal work — they are not in this repo.** A future portal layer (in the spirit of the NOMP-style portals that historically sat on top of `node-stratum-pool`) would add shared-pool accounting (e.g. PPLNS or PROP), pooled coinbase handling, balances, and scheduled payouts. Until that exists and is explicitly documented as shipped, assume **solo only**: if documentation, an issue, or a config example appears to promise PPLNS/PROP behaviour, it is describing the future design, not current behaviour.
- Additional operational hardening (metrics/alerting, multi-daemon failover tuning) as the tri-PoW mainnet deployment matures past height 913982.

## Licence

GPL-2.0 — see [`LICENSE`](LICENSE).
