# Interchained tri-PoW pool — configuration

`start.js` (repo root) boots one stratum pool per PoW algorithm from a
single JSON config file:

```bash
node start.js                                  # config/interchained-mainnet.json
node start.js config/interchained-regtest.json
ITC_POOL_CONFIG=config/interchained-mainnet.json node start.js
```

Two ready-made files ship here: `interchained-mainnet.json` and
`interchained-regtest.json`. Copy one, replace the placeholders, run it.

## Environment overrides (.env)

Every operator-facing setting in the table below can also be set from
the environment, which is the recommended way to run the pool:

```bash
cp .env.example .env   # repo root; annotated, one block per variable
# edit .env (daemon lines + ITC_POOL_ADDRESS at minimum)
node start.js
```

`start.js` loads a repo-root `.env` file automatically when one exists
(minimal built-in parser in `lib/envConfig.js`, no dependency), then
layers the variables over the JSON config. Variables exported in the
shell outrank the same variables in the `.env` file.

**Precedence: environment > JSON config > built-in default.**

Rules that matter:

- An unset or empty variable changes nothing. An invalid value (a
  non-numeric port, an unknown scheme) stops startup with an error
  naming the variable.
- **Live payments:** dry-run can only be turned off from the
  environment by `ITC_PAYMENTS_LIVE=1`, that exact value. `true`,
  `yes`, and the string `false` are not an opt-in and leave dry-run
  untouched, and `ITC_PAYMENTS_DRY_RUN=false` is deliberately ignored
  (that variable can only force dry-run back on). This is proven by
  `scripts/test-env-config.js`.
- Naming: `ITC_` prefix throughout. Daemon: `ITC_DAEMON_HOST`,
  `ITC_DAEMON_PORT`, `ITC_DAEMON_USER`, `ITC_DAEMON_PASSWORD`. Wallet
  and branding: `ITC_POOL_ADDRESS`, `ITC_POOL_NAME`, `ITC_COIN_NAME`,
  `ITC_COIN_SYMBOL`, `ITC_NETWORK`. Per algorithm (`SHA256`,
  `YESPOWER`, `ETHASH`): `ITC_<ALGO>_ENABLED`,
  `ITC_<ALGO>_STRATUM_PORT`, `ITC_<ALGO>_SCHEME`,
  `ITC_<ALGO>_PPLNS_WINDOW`, `ITC_<ALGO>_DIFF`. Payments:
  `ITC_PAYMENTS_ENABLED`, `ITC_PAYMENTS_DRY_RUN`, `ITC_PAYMENTS_LIVE`,
  `ITC_PAYMENTS_FEE_PERCENT`, `ITC_PAYMENTS_MIN_PAYOUT`,
  `ITC_PAYMENTS_CONFIRMATIONS`, `ITC_PAYMENTS_INTERVAL_SECONDS`,
  `ITC_PAYMENTS_PPLNS_WINDOW`, `ITC_PAYMENTS_DATA_FILE`. API:
  `ITC_API_PORT`, `ITC_API_HOST`. Tuning:
  `ITC_BLOCK_REFRESH_INTERVAL`, `ITC_JOB_REBROADCAST_TIMEOUT`,
  `ITC_CONNECTION_TIMEOUT`. Plus `ITC_POOL_CONFIG` for the JSON file
  itself. The full annotated list is `.env.example` at the repo root;
  it and the loader are kept in sync by `scripts/test-env-config.js`.

## How payout works — solo and group modes

The payout **scheme is per algorithm** (`algos.<algo>.scheme`):
`"solo"`, `"pplns"`, or `"prop"`. Algorithms can mix schemes in one config.

**Solo** (the phase-1 behaviour):

- Set `address` to **your own ITC address** — it is the address the
  coinbase pays.
- Connect each miner with that same address as its stratum **username**
  (an optional `.worker` suffix, e.g. `YOURADDRESS.rig1`, is accepted and
  the address part is what identifies the miner).
- A found block's coinbase pays `address` directly. There are no accounts,
  no share ledger, and no payout fee for solo blocks (`rewardRecipients`
  is forced empty in `start.js`). The daemon checks the address with
  `validateaddress` when the pool starts, so a typo fails loudly at
  start-up instead of silently losing a block.

**Group modes (`pplns` / `prop`):**

- `address` is the **pool wallet** address: the coinbase pays it, and the
  daemon wallet must control it, because distributions are sent from it.
- Miners connect with **their own ITC address** as the stratum username
  (optional `.worker` suffix) — that address is their payout address.
- The payments processor (`lib/payouts/`, configured by the top-level
  `payments` object below) records every accepted share and found block
  to a JSON ledger (`api/data/payouts.json`). When a group-mode block
  reaches `payments.confirmations` (checked via daemon `getblock`), it
  splits the block reward: pool fee first, then by share-difficulty
  weight — over the current round for `prop`, over the last N shares for
  `pplns`. Amounts below `payments.minPayout` stay as pending balances
  that carry forward. Each payout batch is built as a PSBT from the
  pool wallet (`walletcreatefundedpsbt`) and recorded with its base64
  PSBT, stage, and amounts; the signing stages
  (`walletprocesspsbt` → `finalizepsbt` → `sendrawtransaction`) are
  separate explicit steps, and an interrupted live batch is resumed
  from its recorded PSBT by the next processor run, never rebuilt.
- **Dry-run is the default** (`payments.dryRun: true`): the split is
  computed and the PSBT is built and recorded, but no signing-stage
  RPC is ever called and nothing is broadcast. Going live is
  explicitly setting `"dryRun": false` with a funded pool wallet.

## Fields

| Field | Meaning |
|---|---|
| `network` | Label only (`mainnet` / `regtest`). The pool learns the real chain from the daemon's `getblockchaininfo`. |
| `address` | Solo: your payout address — the coinbase pays it. Group modes: the **pool wallet** address — the coinbase pays it and distributions are sent from the daemon wallet that controls it. **Required** — `start.js` refuses to start without it. `poolAddress` is accepted as an alias. Placeholder must be replaced with a real address. |
| `coinName` / `coinSymbol` | Display name / ticker passed to the pool engine. Defaults: `Interchained` / `ITC`. |
| `poolName` | Optional display name for this pool instance, printed at startup (`ITC_POOL_NAME`). Branding and log identification only. |
| `daemon` | The one Interchained daemon all three pools share. `host` (default `127.0.0.1`), `port` (RPC port, default `8332` — set it to the `rpcport` in your `interchained.conf`), `user` / `password` (the daemon's `rpcuser` / `rpcpassword`). Replace the placeholders. A top-level `daemons` array of the same objects may be used instead for redundant daemon instances. |
| `algos` | Map of algorithm → settings. Keys are exactly `sha256`, `yespower`, `ethash`; each key is passed to the daemon as the `algo` tag of every `getblocktemplate` request for that pool. |
| `algos.<algo>.enabled` | `false` skips that pool. Omit / `true` runs it. |
| `algos.<algo>.stratumPort` | Port miners connect to. Contract ports: `sha256` = **3333**, `yespower` = **3334**, `ethash` = **3335**. |
| `algos.<algo>.scheme` | Payout scheme for this algorithm: `"solo"` \| `"pplns"` \| `"prop"`. Default: `"solo"`. See "How payout works" above. |
| `algos.<algo>.pplnsWindow` | PPLNS only: the window size in **shares** for this algorithm — a matured block's reward is split over the last this-many shares before the block, weighted by share difficulty. Omit to use the top-level `payments.pplnsWindow` default. Ignored for `solo` and `prop`. |
| `algos.<algo>.diff` | Starting stratum difficulty for that port. A starting point, not a rule — tune it to your hardware (regtest values are deliberately tiny). |
| `algos.<algo>.varDiff` | Variable difficulty for the port: `minDiff`, `maxDiff`, `targetTime` (aim for one share per this many seconds), `retargetTime` (re-check interval, seconds), `variancePercent` (allowed drift before retargeting). |
| `payments` | Top-level payments-processor object (group modes). Fields below. When absent or `enabled` is `false`, no distributions are computed or sent; solo algorithms are unaffected either way. |
| `payments.enabled` | `true` runs the payments processor for `pplns`/`prop` algorithms: ledger recording, maturity checks, splits, and (unless dry-run) payouts. Default: `false`. |
| `payments.dryRun` | `true` (the **default**) computes and records everything — shares, blocks, splits, pending balances — and builds and records each batch PSBT, but never calls the signing-stage RPCs and never broadcasts. Set explicitly to `false` to go live. |
| `payments.feePercent` | Pool fee, as a percentage of each group-mode block reward, deducted before the split. `0` is valid. Solo blocks are never charged. |
| `payments.minPayout` | Minimum payout per miner, in **ITC**. A miner whose accumulated amount for a distribution is below this keeps it as a pending balance in the ledger, carried forward to the next distribution. |
| `payments.confirmations` | Confirmation count a group-mode block must reach (per daemon `getblock`) before its reward is distributed. Set at or above the chain's coinbase maturity — the reward is not spendable before then. |
| `payments.intervalSeconds` | How often the processor checks for newly-matured blocks and runs distributions, in seconds. |
| `payments.pplnsWindow` | Default PPLNS window in **shares**, used by `pplns` algorithms that do not set their own `algos.<algo>.pplnsWindow`. |
| `payments.dataFile` | Path of the payments ledger JSON. Default: `api/data/payouts.json`. Env: `ITC_PAYMENTS_DATA_FILE`. Back this file up. |
| `api.host` | Optional host/interface name recorded for the stats API (`ITC_API_HOST`). The standalone API server itself listens as started (see `api.port` note). |
| `api.port` | Port of the stats API (**8080**). Consumed by the stats API lane (`api/`); `start.js` itself does not open it — if `api/collector.js` exists at run time, `start.js` loads it defensively and attaches it to each pool with that pool's algorithm name. The API surfaces the schemes and payments state: `/api/config` (per-algo scheme + payments summary), `/api/miner/<address>`, `/api/payouts`. |
| `blockRefreshInterval` | How often (ms) each pool polls the daemon for a new block template. |
| `jobRebroadcastTimeout` | Seconds of silence after which the current job is rebroadcast to miners. |
| `connectionTimeout` | Seconds without contact before a miner connection is dropped. |
| `banning` | Flood/invalid-share IP banning: `enabled`, `time` (ban seconds), `invalidPercent`, `checkThreshold` (shares before the percent is judged), `purgeInterval` (seconds between ban-list purges). |

## Examples

### Mainnet-style: payments disabled, all solo

The shipped `interchained-mainnet.json` shape — every algorithm solo,
payments off. The coinbase pays `address` directly; nothing else to run.

```json
{
  "network": "mainnet",
  "address": "YOUR_ITC_ADDRESS",
  "coinName": "Interchained",
  "coinSymbol": "ITC",
  "daemon": { "host": "127.0.0.1", "port": 8332, "user": "RPC_USER", "password": "RPC_PASSWORD" },
  "algos": {
    "sha256":   { "enabled": true, "stratumPort": 3333, "scheme": "solo", "diff": 2048 },
    "yespower": { "enabled": true, "stratumPort": 3334, "scheme": "solo", "diff": 8 },
    "ethash":   { "enabled": true, "stratumPort": 3335, "scheme": "solo", "diff": 512 }
  },
  "payments": { "enabled": false },
  "api": { "port": 8080 }
}
```

(Per-algo `varDiff` and the top-level tuning fields from the shipped
examples are omitted here for brevity; keep them as in the shipped files.)

### Group-style: PPLNS Yespower + PROP Ethash, solo SHA-256, dry-run first

`address` is the pool wallet. Miners on 3334/3335 connect with their own
ITC addresses; miners on 3333 use the configured address as before.

```json
{
  "network": "mainnet",
  "address": "POOL_WALLET_ITC_ADDRESS",
  "coinName": "Interchained",
  "coinSymbol": "ITC",
  "daemon": { "host": "127.0.0.1", "port": 8332, "user": "RPC_USER", "password": "RPC_PASSWORD" },
  "algos": {
    "sha256":   { "enabled": true, "stratumPort": 3333, "scheme": "solo", "diff": 2048 },
    "yespower": { "enabled": true, "stratumPort": 3334, "scheme": "pplns", "pplnsWindow": 10000, "diff": 8 },
    "ethash":   { "enabled": true, "stratumPort": 3335, "scheme": "prop", "diff": 512 }
  },
  "payments": {
    "enabled": true,
    "dryRun": true,
    "feePercent": 1.0,
    "minPayout": 1.0,
    "confirmations": 100,
    "intervalSeconds": 600,
    "pplnsWindow": 5000
  },
  "api": { "port": 8080 }
}
```

In this example Yespower uses its own `pplnsWindow` (10000 shares); if it
were omitted, the top-level default (5000) would apply. Going live is one
change — `"dryRun": false` — after the dry-run ledger and `/api/payouts`
have been checked (see the go-live checklist in `docs/SETUP.md` §9.5).

## Notes

- **Block submission is always `submitblock`.** `start.js` sets
  `hasSubmitMethod: true` for every pool, and the pool's daemon probe
  treats any non-`Method not found` answer as proof `submitblock` exists —
  the `getblocktemplate` proposal-submit fallback is never used against
  the Interchained daemon.
- The three pools share the daemon connection settings but nothing else:
  separate stratum listeners, separate job managers, separate templates
  (each tagged with its own `algo`), and separate payout schemes.
- The payments ledger lives at `api/data/payouts.json` (created at
  runtime). It persists across restarts — the processor reloads it and
  resumes, pending balances included. Back it up; do not hand-edit it
  while the pool is running.
- Daemon RPC credentials live only in your local copy of these files.
  Do not commit a filled-in config with real credentials.
