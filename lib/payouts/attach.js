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
 * The share timestamp is the attach time (Date.now()/1000): shareData
 * carries no timestamp of its own.
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

function attachPayouts(pool, algo, ledger, schemeOrConfig) {
    if (!pool || typeof pool.on !== 'function')
        throw new Error('attachPayouts: pool must be an EventEmitter');
    if (!ledger || typeof ledger.recordShare !== 'function')
        throw new Error('attachPayouts: ledger must be a payouts Ledger');
    var scheme = resolveScheme(pool, algo, schemeOrConfig);

    function onShare(isValidShare, isValidBlock, shareData) {
        if (!shareData) return;
        var shareAlgo = shareData.algo || algo;
        var time = Math.floor(Date.now() / 1000);
        if (isValidShare) {
            ledger.recordShare({
                algo: shareAlgo,
                worker: shareData.worker,
                difficulty: shareData.difficulty,
                time: time,
                height: shareData.height
            });
        }
        if (isValidBlock) {
            ledger.recordBlock({
                algo: shareAlgo,
                height: shareData.height,
                hash: shareData.blockHash,
                reward: shareData.blockReward,
                finder: shareData.worker,
                time: time,
                scheme: resolveScheme(pool, shareAlgo, schemeOrConfig)
            });
        }
    }

    pool.on('share', onShare);
    return function detach() {
        if (typeof pool.removeListener === 'function') pool.removeListener('share', onShare);
    };
}

module.exports = { attachPayouts: attachPayouts, resolveScheme: resolveScheme };
