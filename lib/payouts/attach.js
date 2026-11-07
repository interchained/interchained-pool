'use strict';
/*
 * attach.js -- glue between a lib/pool.js pool instance and the ledger.
 *
 * attachPayouts(pool, algo, ledger [, schemeOrConfig]) -> detach function
 *
 * Subscribes to the pool's 'share' event:
 *   pool.emit('share', isValidShare, isValidBlock, shareData)
 *   shareData = { job, ip, port, worker, algo, height, blockReward,
 *                 difficulty, shareDiff, blockDiff, blockHash }
 *
 * - Valid shares (isValidShare === true) are recorded for accounting/stats
 *   for every scheme, solo included.
 * - Found blocks (isValidBlock === true) are recorded with the algo's
 *   configured scheme, the coinbase reward (shareData.blockReward,
 *   satoshis) and finder = shareData.worker.
 *
 * Scheme resolution order (first hit wins):
 *   1. 4th argument: a scheme string ('solo'|'pplns'|'prop'), an object
 *      { scheme }, or a full payments config { schemes: { <algo>: {...} } }
 *   2. pool.options.payments / pool.options.payouts (same shapes as above)
 *   3. 'solo' -- the phase-1 behaviour: blocks are still recorded (stats),
 *      but the payments processor never splits or pays them.
 *
 * ACCOUNTING INTEGRITY (phase 3, fairness -- enforced HERE, at the one
 * point every share must pass through before it can be counted):
 * - TIMESTAMPS: a share is recorded with shareData.time (the submission
 *   time stamped by jobManager / the stratum adapter) when present, NOT
 *   with attach time; a block is recorded with shareData.blockFoundTime
 *   (stamped by pool.js at the synchronous block-found event) when
 *   present. Payout windows in schemes.js are time-bounded, so honest
 *   event times are what close a round at the block event instead of at
 *   wall-clock drift (e.g. async submitblock acceptance).
 * - DUPLICATES: a share carrying a strong submission identity (classic:
 *   job + extraNonce1 + extraNonce2 + nTime + nonce; ethash: job +
 *   nonce64 + mixHash) is recorded at most once per attach lifetime, no
 *   matter how many times the event is emitted. (jobManager's
 *   registerSubmit already rejects classic duplicates at the source;
 *   the Ethash stratum has no such register, so this layer is the one
 *   that protects the Ethash ledger.) Shares without a strong identity
 *   are never deduplicated on weak fields -- two legitimate shares can
 *   share worker/difficulty/second, a submission identity cannot.
 * - STALE ROUNDS: a share whose height matches an already-recorded
 *   block of the same algo and whose submission time is AFTER that
 *   block's found time is for a previous, closed job/round and is NOT
 *   recorded. A share timestamped at or before the found time is a
 *   delayed delivery of pre-boundary work and IS recorded (the split
 *   windows decide its fate by time, exactly as the verifier recomputes).
 * - DUPLICATE BLOCKS: a block hash already in the ledger is never
 *   recorded twice.
 * - DIFFICULTY: the recorded difficulty is shareData.difficulty
 *   verbatim -- the ACCEPTED difficulty (jobManager adjusts it to the
 *   pre-retarget difficulty when applicable). shareDiff (actual
 *   achieved difficulty) is never used for accounting, here or in the
 *   verifier's recompute.
 */

function resolveScheme(pool, algo, arg) {
    function fromShape(shape) {
        if (!shape) return null;
        if (typeof shape === 'string') return shape;
        if (typeof shape.scheme === 'string') return shape.scheme;
        if (shape.schemes && shape.schemes[algo] && typeof shape.schemes[algo].scheme === 'string')
            return shape.schemes[algo].scheme;
        return null;
    }
    return fromShape(arg)
        || fromShape(pool && pool.options && (pool.options.payments || pool.options.payouts))
        || 'solo';
}

/* Epoch seconds from a share/block timestamp field: seconds pass
 * through, milliseconds (>1e11) are converted, anything else -> null. */
function epochSeconds(value) {
    if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null;
    if (value > 1e11) return Math.floor(value / 1000);
    return Math.floor(value);
}

function shareIdentityKey(algo, shareData) {
    var worker = shareData.worker == null ? '' : String(shareData.worker);
    if (shareData.nonce64 != null && shareData.mixHash) {
        // Ethash submission identity.
        return JSON.stringify([algo, worker, shareData.job || shareData.jobId || null,
            String(shareData.nonce64), String(shareData.mixHash).toLowerCase()]);
    }
    if (shareData.extraNonce2 != null && shareData.nonce != null) {
        // Classic stratum submission identity (jobManager emits these).
        return JSON.stringify([algo, worker, shareData.job || null,
            String(shareData.extraNonce1 || ''), String(shareData.extraNonce2),
            String(shareData.nTime || ''), String(shareData.nonce)]);
    }
    return null; // no strong identity -> cannot dedupe safely
}

function attachPayouts(pool, algo, ledger, schemeOrConfig) {
    if (!pool || typeof pool.on !== 'function')
        throw new Error('attachPayouts: pool must be an EventEmitter');
    if (!ledger || typeof ledger.recordShare !== 'function')
        throw new Error('attachPayouts: ledger must be a payouts Ledger');
    var scheme = resolveScheme(pool, algo, schemeOrConfig);

    var seenShareKeys = {};   // identity key -> true
    var seenShareCount = 0;
    var closedRounds = {};    // algo -> { height -> blockFoundTime }
    function noteClosedRound(blockAlgo, height, time) {
        if (typeof height !== 'number' || typeof time !== 'number') return;
        if (!closedRounds[blockAlgo]) closedRounds[blockAlgo] = {};
        var prev = closedRounds[blockAlgo][height];
        if (typeof prev !== 'number' || time < prev) closedRounds[blockAlgo][height] = time;
    }
    // Seed from blocks the ledger already holds (e.g. after a restart):
    // their rounds are closed at their recorded (found) times.
    if (typeof ledger.getBlocks === 'function') {
        ledger.getBlocks().forEach(function (b) {
            if (b) noteClosedRound(b.algo, b.height, b.time);
        });
    }

    function onShare(isValidShare, isValidBlock, shareData) {
        if (!shareData) return;
        var shareAlgo = shareData.algo || algo;
        var now = Math.floor(Date.now() / 1000);
        var shareTime = epochSeconds(shareData.time) || now;
        if (isValidShare) {
            var key = shareIdentityKey(shareAlgo, shareData);
            var duplicate = !!(key && seenShareKeys[key]);
            var closedAt = (closedRounds[shareAlgo] && typeof shareData.height === 'number')
                ? closedRounds[shareAlgo][shareData.height] : undefined;
            var stale = (typeof closedAt === 'number' && shareTime > closedAt);
            if (!duplicate && !stale) {
                ledger.recordShare({
                    algo: shareAlgo,
                    worker: shareData.worker,
                    difficulty: shareData.difficulty,
                    time: shareTime,
                    height: shareData.height
                });
                if (key) {
                    seenShareKeys[key] = true;
                    seenShareCount++;
                    if (seenShareCount > 200000) { // bound memory; oldest identities age out
                        var keys = Object.keys(seenShareKeys);
                        for (var i = 0; i < 50000 && i < keys.length; i++) delete seenShareKeys[keys[i]];
                        seenShareCount = Object.keys(seenShareKeys).length;
                    }
                }
            }
        }
        if (isValidBlock) {
            var blockTime = epochSeconds(shareData.blockFoundTime) ||
                epochSeconds(shareData.time) || now;
            var alreadyRecorded = shareData.blockHash &&
                typeof ledger.getBlockByHash === 'function' &&
                !!ledger.getBlockByHash(shareData.blockHash);
            if (!alreadyRecorded) {
                ledger.recordBlock({
                    algo: shareAlgo,
                    height: shareData.height,
                    hash: shareData.blockHash,
                    reward: shareData.blockReward,
                    finder: shareData.worker,
                    time: blockTime,
                    scheme: resolveScheme(pool, shareAlgo, schemeOrConfig)
                });
            }
            noteClosedRound(shareAlgo, shareData.height, blockTime);
        }
    }

    pool.on('share', onShare);
    return function detach() {
        if (typeof pool.removeListener === 'function') pool.removeListener('share', onShare);
    };
}

module.exports = { attachPayouts: attachPayouts, resolveScheme: resolveScheme };
