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

## How solo mining / payout works

This is a **solo** pool: no accounts, no share ledger, no fee
(`rewardRecipients` is forced empty in `start.js`).

- Set `address` to **your own ITC address**.
- Connect each miner with that same address as its stratum **username**
  (an optional `.worker` suffix, e.g. `YOURADDRESS.rig1`, is accepted and
  stripped by the authorize function).
- A found block's coinbase pays that address directly. The daemon checks
  the address with `validateaddress` when the pool starts, so a typo fails
  loudly at start-up instead of silently losing a block.

## Fields

| Field | Meaning |
|---|---|
| `network` | Label only (`mainnet` / `regtest`). The pool learns the real chain from the daemon's `getblockchaininfo`. |
| `address` | Payout address (see above). **Required** — `start.js` refuses to start without it. `poolAddress` is accepted as an alias. Placeholder must be replaced with a real address. |
| `coinName` / `coinSymbol` | Display name / ticker passed to the pool engine. Defaults: `Interchained` / `ITC`. |
| `daemon` | The one Interchained daemon all three pools share. `host` (default `127.0.0.1`), `port` (RPC port, default `8332` — set it to the `rpcport` in your `interchained.conf`), `user` / `password` (the daemon's `rpcuser` / `rpcpassword`). Replace the placeholders. A top-level `daemons` array of the same objects may be used instead for redundant daemon instances. |
| `algos` | Map of algorithm → settings. Keys are exactly `sha256`, `yespower`, `ethash`; each key is passed to the daemon as the `algo` tag of every `getblocktemplate` request for that pool. |
| `algos.<algo>.enabled` | `false` skips that pool. Omit / `true` runs it. |
| `algos.<algo>.stratumPort` | Port miners connect to. Contract ports: `sha256` = **3333**, `yespower` = **3334**, `ethash` = **3335**. |
| `algos.<algo>.diff` | Starting stratum difficulty for that port. A starting point, not a rule — tune it to your hardware (regtest values are deliberately tiny). |
| `algos.<algo>.varDiff` | Variable difficulty for the port: `minDiff`, `maxDiff`, `targetTime` (aim for one share per this many seconds), `retargetTime` (re-check interval, seconds), `variancePercent` (allowed drift before retargeting). |
| `api.port` | Port of the stats API (**8080**). Consumed by the stats API lane (`api/`); `start.js` itself does not open it — if `api/collector.js` exists at run time, `start.js` loads it defensively and attaches it to each pool with that pool's algorithm name. |
| `blockRefreshInterval` | How often (ms) each pool polls the daemon for a new block template. |
| `jobRebroadcastTimeout` | Seconds of silence after which the current job is rebroadcast to miners. |
| `connectionTimeout` | Seconds without contact before a miner connection is dropped. |
| `banning` | Flood/invalid-share IP banning: `enabled`, `time` (ban seconds), `invalidPercent`, `checkThreshold` (shares before the percent is judged), `purgeInterval` (seconds between ban-list purges). |

## Notes

- **Block submission is always `submitblock`.** `start.js` sets
  `hasSubmitMethod: true` for every pool, and the pool's daemon probe
  treats any non-`Method not found` answer as proof `submitblock` exists —
  the `getblocktemplate` proposal-submit fallback is never used against
  the Interchained daemon.
- The three pools share the daemon connection settings but nothing else:
  separate stratum listeners, separate job managers, separate templates
  (each tagged with its own `algo`).
- Daemon RPC credentials live only in your local copy of these files.
  Do not commit a filled-in config with real credentials.
