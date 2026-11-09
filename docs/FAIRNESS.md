# Pool Fairness: guarantees as implemented

This document describes the fairness mechanisms that actually exist in
this codebase (phase 3), where they live, and how a miner can verify
them without trusting the operator. If a claim is not backed by code
and a test, it is not made here.

All amounts are integer satoshis (1 ITC = 100,000,000 sat). Payouts are
built as PSBTs and are **dry-run by default**: a dry-run batch is built
and recorded but never signed or broadcast.

## What is counted

A share enters the payout ledger only through `attachPayouts`
(`lib/payouts/attach.js`), the single accounting gate between a pool's
`share` events and the ledger (`lib/payouts/ledger.js`):

- Only **valid** shares (`isValidShare === true`) are recorded.
- A recorded share keeps the worker's payout address (any `.worker`
  suffix is kept separately as `workerName`), the share's **accepted
  difficulty**, its submission timestamp and its block height.
- **Weight = sum of accepted difficulty.** The accepted difficulty is
  the difficulty the share was accepted at: `jobManager` emits it as
  `shareData.difficulty`, already adjusted to the pre-retarget
  difficulty when a share met an older vardiff target. The share's
  *achieved* difficulty (`shareDiff`) is never used for accounting,
  anywhere, including in the independent verifier.

## What is rejected

- **Duplicate shares.** The exact same submission is counted once.
  Classic stratum: `BlockTemplate.registerSubmit()` rejects it in
  `jobManager.processShare` (`[22, 'duplicate share']`) before any
  event is emitted. Additionally, the accounting gate deduplicates any
  share carrying a submission identity (classic: job + extraNonce1 +
  extraNonce2 + nTime + nonce; Ethash: job + nonce64 + mixHash). This
  second layer is what protects Ethash, whose stratum server has no
  duplicate register of its own. Shares without a strong identity are
  never deduplicated on weak fields.
- **Stale / previous-job shares.** When a new block template arrives,
  `jobManager.processTemplate` discards all previous jobs (`[21, 'job
  not found']`); the Ethash stratum clears replaced jobs on a clean
  job set (same rejection). At the accounting gate, once a block for
  height H is recorded, any share for height H timestamped *after* the
  block's found time is not recorded. Closed rounds are seeded from the
  ledger at attach time, so they stay closed across restarts.
- **Post-block shares.** A round closes at the **block event**, not at
  wall-clock drift: `jobManager` stamps each share with its submission
  time, `pool.js` stamps a found block with `blockFoundTime` at the
  synchronous find event (before the asynchronous `submitblock`
  round-trip), and the accounting gate records those event times. The
  split windows (`lib/payouts/schemes.js`) include only shares with
  `time <= block.time`, so a share submitted after the find cannot
  enter the found block's window. A share timestamped at or before the
  boundary but *delivered* late still counts: submission time, not
  delivery time, is the boundary.
- **Duplicate blocks.** A block hash already in the ledger is never
  recorded twice.

## How a block's reward is split

Solo blocks never enter the split / balances / batch pipeline below —
the coinbase pays the finder directly. But a solo block that is
**confirmed** is still *published* (breakdown and reconciliation, see
below) with its own deterministic semantics, because "not processed"
must never read as "not accounted":

- The block record's reward is the gross coinbase subsidy (that is
  what `attach.js` records from the template's `coinbasevalue`).
- The **governance carve-out** — 73% of the subsidy, chain consensus
  (the daemon's `GOVERNANCE_BPS`) — is paid to the governance wallet
  by the coinbase itself. It is **never pool revenue** and is never
  credited to any miner.
- The remainder is the **pool-creditable amount**: the finder is
  credited **100%** of it, fee **0**, paid by the coinbase itself —
  so in reconciliation a settled solo block shows as settled and
  already paid out, never as a pending balance or carry-over, and it
  never enters the FIFO model. A recorded solo split that disagrees
  with this derivation (subsidy − governance) is reported as a
  `solo-split-mismatch` discrepancy, and its breakdown shows
  `matchesRecorded: false`.

For group schemes:

- **PROP**: all shares of the block's algo in the round
  `(prevBlockTime, block.time]` share the reward by weight.
  `prevBlockTime` is the previous recorded block time of that algo.
- **PPLNS**: the last N shares of the block's algo with
  `time <= block.time` (by count, time-ordered) share the reward by
  weight.
- **Fee first**: `feeSat = floor(rewardSat × feePercent / 100)` is
  deducted before any distribution and retained by the pool.
- Each miner receives `floor(distributable × weight / totalWeight)`.
  The rounding remainder goes in full to the largest-weight miner
  (the block finder wins ties, then the lexicographically first
  address), so `sum(amounts) + feeSat === rewardSat` exactly.
- A block with no recorded shares in its window splits to nothing:
  no amounts are credited and **no fee is taken**; the processor marks
  it `emptySplit` and reconciliation reports its reward as a visible
  *undistributed* discrepancy (see below).

## Min-payout and carry-over

Credited amounts accumulate in a miner's pending balance. A payout
batch pays a miner only when their pending balance reaches the
configured `minPayout` (and is > 0); the batch then pays their **full**
pending balance. Below-threshold balances are not partially paid and
are never forfeited: they carry over. Each block breakdown (below)
shows, per miner, the credit for that block, how much of it has since
been paid out, how much carry-over the block created (still pending),
and how much older carry-over the block's batch consumed: computed
with a first-in-first-out consumption model over the recorded credits
and batches.

## Per-block breakdown (public)

- `GET /api/blocks/<height>/breakdown?algo=<algo>`: for a block:
  height, algo, hash, finder, status, scheme; total reward in satoshis
  and coins; the fee percent and the exact fee in satoshis; the share
  window actually used (scheme definition, PROP round boundaries or
  PPLNS last-N definition with the included shares' time range and
  count); and per miner: share count, weight and weight %, payout
  amount (sat + coins), paid-out amount, and carry-over in / created /
  consumed. The breakdown shows the **recorded** split and an
  **independent recompute** from the raw shares (same code as the
  verifier), with a flag when they differ. For a solo block there is
  no share window: the breakdown additionally shows the gross subsidy,
  the governance carve-out and the pool-creditable amount, the finder
  credited 100% of the creditable amount and marked paid out (by the
  coinbase), and the recompute is the same derivation any miner can
  redo from the block's coinbase alone.
- `GET /api/breakdowns`: the same summary for every recorded block.
- The dashboard renders this as a block-explorer panel with the fee
  line and a totals check, next to the reconciliation readout.

## Reconciliation (public)

`GET /api/reconcile` proves, from the recorded ledger alone:

- per settled block: `reward == sum(credits) + fee` (for solo blocks,
  `reward` is the pool-creditable amount — subsidy minus the
  governance carve-out — and the per-block entry also carries the
  gross subsidy and the carve-out itself, so nothing is hidden);
- in aggregate: `rewardIn == payouts + fees + carryOverDelta`, where
  `payouts` is the sum of the recorded batch amounts and
  `carryOverDelta` is computed independently by the FIFO model;
  recorded `balances.pending` / `balances.paid` are cross-checked
  against the same model. When settled solo blocks are present, their
  coinbase-paid credits are totalled separately as `soloSettledSat`
  and the published equation reads
  `rewardIn == payouts + fees + carryOverDelta + soloSettledSat`;
  `settledBlocks` counts solo blocks too.

Any mismatch is returned as a **discrepancy object** (`kind`, expected
vs actual satoshis, delta, message) and `balanced: false`. Nothing is
silently dropped or force-balanced. A live batch that has been created
as a PSBT but not yet broadcast is reported as an `in-flight` notice,
not hidden.

## Independent verification (zero trust)

A miner needs only Node.js and this repository's pure-JS modules:
no pool access, no network, no native dependencies:

1. Download the raw export for a block:
   `GET /api/blocks/<height>/ledger?algo=<algo>` (save it as
   `export.json`). It contains the block record as stored, the raw
   share ledger entries for the block's algo, the recorded split, the
   recorded payout batch (including its PSBT), and the parameters the
   split claims to use (fee %, PROP previous-block time, PPLNS N,
   min-payout in satoshis, and each miner's carry-in balance).
2. Run:
   ```
   node scripts/verify-payout.js export.json
   ```
   It recomputes the split from the raw shares with
   `lib/payouts/verifySplit.js`: which calls the pool's own
   `lib/payouts/schemes.js`, so the check uses the exact production
   semantics (fee-first, remainder rule, difficulty weighting): and
   compares it against the recorded amounts and fee. When a batch is
   recorded it also re-derives the expected batch amounts under the
   min-payout carry-over rule, and parses the batch's PSBT (BIP174)
   to confirm the transaction's actual outputs equal the batch
   amounts. An unparseable PSBT is a verification failure, never a
   pass.
3. Exit code `0` means every check matched. Any mismatch exits
   non-zero and prints a readable per-miner diff.

## Tests

- `node lib/payouts/test-payouts.js`: the payout processor (dry-run
  and live PSBT stages, orphan rules, carry-over).
- `node lib/payouts/test-fairness.js`: breakdown values, the
  reconciliation identity (and its failure on a tampered store), and
  the verifier CLI run end-to-end as a child process against a settled
  synthetic pool: an honest export exits 0; tampering with one payout
  amount (batch or recorded split) exits non-zero.
- `node lib/payouts/test-share-integrity.js`: the counting rules
  above, each proven against the actual modules (accounting gate,
  schemes, Ethash stratum job gate, and, when the repo's dependencies
  are installed, `jobManager` itself wired through the gate).
