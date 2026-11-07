'use strict';
/*
 * schemes.js -- pure reward-splitting functions. No I/O, no state.
 *
 * Weights are sums of share `difficulty` (the miner's share difficulty as
 * recorded in the ledger). Shares carry `worker` = payout address (any
 * ".worker" suffix already stripped by the ledger); a raw `address` field
 * is also accepted for hand-built share objects.
 *
 * Solo is NOT handled here: in solo mode the coinbase pays the finder
 * directly and payment never enters this pipeline.
 */

function shareAddress(share) {
    return share.worker || share.address || null;
}

function accumulate(weights, shares) {
    shares.forEach(function (s) {
        var addr = shareAddress(s);
        if (!addr) return;
        weights[addr] = (weights[addr] || 0) + (Number(s.difficulty) || 0);
    });
    return weights;
}

/*
 * PROP (proportional): all shares of the block's algo submitted in the
 * round (prevBlockTime, block.time] share the reward in proportion to
 * their difficulty. prevBlockTime may be null/undefined (first recorded
 * block of the algo) -- then the round starts at the beginning of time.
 */
function splitProp(shares, block, prevBlockTime) {
    var from = (typeof prevBlockTime === 'number') ? prevBlockTime : -Infinity;
    var inRound = (shares || []).filter(function (s) {
        return s.algo === block.algo && s.time > from && s.time <= block.time;
    });
    return accumulate({}, inRound);
}

/*
 * PPLNS (pay per last N shares): the last `windowN` shares (by count) of
 * the block's algo with time <= block.time share the reward in proportion
 * to their difficulty. windowN may be null/undefined -- then all eligible
 * shares count. Shares are ordered by time (stable for equal times).
 */
function splitPplns(shares, block, windowN) {
    var eligible = (shares || []).filter(function (s) {
        return s.algo === block.algo && s.time <= block.time;
    });
    eligible.sort(function (a, b) { return a.time - b.time; });
    if (typeof windowN === 'number' && windowN > 0 && eligible.length > windowN)
        eligible = eligible.slice(eligible.length - windowN);
    return accumulate({}, eligible);
}

/*
 * splitReward(rewardSat, weights, feePercent [, finder]) ->
 *   { amounts: { address: satoshis }, feeSat }
 *
 * - feeSat = floor(rewardSat * feePercent / 100), deducted FIRST; the fee
 *   is retained by the pool and never distributed.
 * - Each miner gets floor(distributable * weight / totalWeight).
 * - ROUNDING REMAINDER RULE: the satoshis left over by the floors
 *   (distributable - sum(amounts)) are assigned in full to the miner with
 *   the largest weight. On a tie for largest weight, the block finder
 *   (4th argument, if given and among the tied) wins; otherwise the
 *   lexicographically first address among the tied wins. This keeps
 *   sum(amounts) + feeSat === rewardSat exactly.
 * - Empty / zero-total weights -> { amounts: {}, feeSat: 0 }: nothing is
 *   owed to anyone and no fee is taken on an unsplittable reward (the
 *   payments processor logs this case and leaves the reward undistributed).
 */
function splitReward(rewardSat, weights, feePercent, finder) {
    rewardSat = Math.round(Number(rewardSat) || 0);
    weights = weights || {};
    var addrs = Object.keys(weights).filter(function (a) { return weights[a] > 0; });
    var totalWeight = addrs.reduce(function (sum, a) { return sum + weights[a]; }, 0);
    if (rewardSat <= 0 || addrs.length === 0 || totalWeight <= 0)
        return { amounts: {}, feeSat: 0 };

    var feeSat = Math.floor(rewardSat * (Number(feePercent) || 0) / 100);
    var distributable = rewardSat - feeSat;

    var amounts = {};
    var paid = 0;
    addrs.forEach(function (a) {
        amounts[a] = Math.floor(distributable * weights[a] / totalWeight);
        paid += amounts[a];
    });

    var remainder = distributable - paid;
    if (remainder > 0) {
        var maxWeight = Math.max.apply(null, addrs.map(function (a) { return weights[a]; }));
        var tied = addrs.filter(function (a) { return weights[a] === maxWeight; }).sort();
        var winner = (finder && tied.indexOf(finder) !== -1) ? finder : tied[0];
        amounts[winner] += remainder;
    }
    return { amounts: amounts, feeSat: feeSat };
}

module.exports = {
    splitProp: splitProp,
    splitPplns: splitPplns,
    splitReward: splitReward
};
