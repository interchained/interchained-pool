# ITC Pool — Stats / API Backend (`api/`)

Stats and HTTP API service for the Interchained tri-PoW **solo** mining pool
(algos: `sha256`, `yespower`, `ethash`; stratum ports 3333 / 3334 / 3335).

Zero npm dependencies — Node.js builtins only (`http`, `fs`, `path`, `url`).
It boots standalone and does not require the pool, a daemon, or `node_modules`.

## Run

```sh
node api/server.js            # listens on 8080
PORT=18080 node api/server.js # PORT env overrides the port
```

Standalone mode creates its own `StatsCollector` with no pools attached, so
all counters/hashrates are legitimately zero until a producer feeds it.

Static dashboard: files under `../ui/` are served if present (`/` →
`ui/index.html`, correct content types, path traversal rejected). If `ui/`
is absent, `/` serves a built-in placeholder page saying the dashboard is
not built yet.

## Endpoints

All API responses are JSON. Times are epoch milliseconds.

| Route | Response |
|---|---|
| `GET /health` | `{ "ok": true }` |
| `GET /api/stats` | `{ startedAt, uptimeSeconds, algos: { sha256: AlgoStats, yespower: AlgoStats, ethash: AlgoStats } }` — always all three algos, zeros/empty when there is no data. `AlgoStats = { hashrate, workers (count), workerNames, workersDetail, sharesAccepted, sharesRejected, blocksFound, lastBlock }`; `lastBlock` is `null` until a block is found. |
| `GET /api/blocks` | JSON array of recent blocks across all algos, newest first: `[{ height, algo, hash, time }]`. Optional `?limit=N`. |
| `GET /api/workers` | Flat JSON array across algos: `[{ worker, algo, hashrate, shares, invalidShares, connected, lastShareAt }]` (`hashrate` is the per-worker rolling estimate, `0` when no accepted shares remain in the window; `lastShareAt` may be `null`). |
| `GET /api/config` | `{ solo: true, coin, algos: { sha256: { algo, stratumPort: 3333 }, yespower: { …, 3334 }, ethash: { …, 3335 } }, algoList: […same as a list…], stratumPorts: { sha256: 3333, yespower: 3334, ethash: 3335 } }` |
| `GET /…` | Static file from `../ui/`, or the placeholder page at `/`. Unknown `/api/*` → `404` JSON. |

## Collector (`api/collector.js`)

### Wiring to real pools (integration contract)

```js
const { createServer, StatsCollector } = require('./api/server');
// or: const StatsCollector = require('./api/collector');

const collector = new StatsCollector();          // loads persisted state
collector.attach(poolSha256, 'sha256');          // one attach() per pool
collector.attach(poolYespower, 'yespower');
collector.attach(poolEthash, 'ethash');
createServer({ collector }).listen(8080);        // server.collector also works
```

`attach(poolInstance, algo)` subscribes to the node-stratum-pool pool, which
is an EventEmitter emitting:

- `'share' (isValidShare, isValidBlock, shareData)` — the only event that
  feeds stats. `shareData` is read defensively; recognised fields:
  `worker` (fallback `workerName`, else `"unknown"`), `difficulty`
  (fallback `shareDiff`, else `1`), `height`, `blockHash` (fallback `hash`),
  `error`. When `isValidShare && isValidBlock`, a block entry is recorded
  from `height`/`blockHash`.
- `'log' (severity, message)` — subscribed to and deliberately ignored.

### Direct producer API (tests, other in-process producers)

```js
collector.recordShare(algo, workerName, { valid, difficulty, isBlock });
collector.recordBlock(algo, { height, hash, time });   // time: epoch ms, epoch s, or date string
collector.noteWorkerConnect(algo, workerName);
collector.noteWorkerDisconnect(algo, workerName);
collector.flush();                                     // force a save now
```

State per algo: `sharesAccepted`, `sharesRejected`, a per-worker map
`{ shares, invalidShares, lastShareAt, connected }`, and `blocksFound`
(capped at the last 100 blocks per algo, each `{ height, algo, hash, time }`),
plus the collector `startTime`.

Note: a plain `recordShare(..., { isBlock: true })` does **not** create a
block entry on its own — blocks carry height/hash and arrive via
`recordBlock()` (`attach()` calls it automatically). If `recordShare` is
also given `height`/`hash`, it records the block too.

## Hashrate convention

Rolling window, default 600 s (configurable via
`new StatsCollector({ windowSeconds })`):

```
hashrate = sum(difficulty of accepted shares in window) * 2^32 / windowSeconds
```

This is the classic **diff-1 based estimate**: a difficulty-1 share
represents ~2³² hashes on average. It is applied uniformly to all three
algos (and per worker, from that worker's own window) as a comparable
estimate — not an exact device hashrate; native difficulty semantics differ
per algo. The divisor is always the full window, so the estimate ramps up
during the first window after start. The rolling window is never persisted;
after a restart hashrate starts at 0 and rebuilds while counters/blocks
survive.

## Persistence

- File: `api/data/stats.json` by default
  (`new StatsCollector({ dataFile })` overrides it; `dataFile: null`
  disables persistence).
- Content: counters, per-worker counters, blocks, and `startTime` — **not**
  the rolling hashrate windows.
- Writes are atomic: write to `stats.json.tmp-<pid>` in the same directory,
  then rename over `stats.json`.
- Throttling: saves happen at most once every 10 s (bursts coalesce into
  one trailing save), except `recordBlock()`, which saves immediately.
- Load: on construction, a missing or corrupt file is tolerated — the
  collector starts from zeros and never throws. Workers restored from disk
  come back with `connected: false` (a persisted connection is stale after
  a restart).

## Exports

`api/server.js` exports `{ createServer, StatsCollector }`.
`createServer({ collector?, uiDir?, dataFile? })` returns an `http.Server`
that is **not yet listening**, with the collector attached as
`server.collector`. Passing a `StatsCollector` directly as the argument
also works. `api/collector.js` exports the `StatsCollector` class directly
(also as `.StatsCollector`, with `.ALGOS`).

## Phase 2 — group payouts surfacing

`createServer({ payoutsFile, poolConfig })`; the store path resolves
through the shared `lib/payouts/storePath.js` (the same resolver the
pool process writes through): explicit `payoutsFile`, env
`ITC_PAYMENTS_DATA_FILE`, the pool config's `payments.dataFile` (the
standalone entry reads the config file for this), legacy env
`ITC_PAYOUTS_FILE`, then `api/data/payouts.json`. The payouts store
(written by the payouts lane) is read fresh per request, read-only; a
missing/corrupt file yields empty data, never an error.

| Route | Response |
|---|---|
| `GET /api/miner/<address>` | `{ address, algos: { <algo>: { shares, shareDifficultySum, hashrateEstimate, lastShareAt, pendingSat, paidSat, pendingItc, paidItc } }, totals: {…same fields…} }`. Exact payout-address match on the store's `worker` field (never `workerName`). Hashrate source: **the payouts store** (works standalone), diff-1 convention over a 600 s window; `shareDifficultySum` covers all shares. `404 {error:"miner not found"}` when the address has no shares and no balances. |
| `GET /api/payouts` | `{ payouts: […newest first, cap 100, enriched with totalSat/totalItc/minersPaid/feeSat/feeItc], pool: { feePercent, minPayout, minPayoutSat, minPayoutItc, dryRun, confirmations } }` |
| `GET /api/payouts/blocks` | Store blocks, newest first, enriched with `rewardSat`/`rewardItc` and distribution `status`. |
| `GET /api/blocks?source=store` | Same as `/api/payouts/blocks`. Default `/api/blocks` (no `source`) is unchanged collector behaviour. |
| `GET /api/config` | Phase-1 fields preserved, plus per-algo `scheme`/`pplnsWindow`, a `payments` summary, flat `feePercent`/`minPayout`/`dryRun` mirrors, `poolAddress`, `poolConfigProvided`. Without `poolConfig`: schemes report `solo`, payments fields are `null` (unknown, not faked). `minPayout` is treated as satoshis, like every other money field in the store contract. `solo` is `true` exactly when every algo's scheme is `solo`. |

Verify: `node api/test-phase2.js` (fixture + bare-boot assertions).
