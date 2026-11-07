'use strict';
/*
 * reconcile.js -- proof that the pool's books balance, from the recorded
 * ledger store alone. Pure JS + Node builtins. Integer satoshis.
 *
 * A block is SETTLED when the payments processor has recorded its split
 * on it (`amounts` field present -- status 'confirmed' or 'paid').
 * Solo blocks are excluded: their reward never enters the pool's books
 * (the coinbase pays the finder directly).
 *
 * Per settled block the identity checked is:
 *     rewardSat == sum(amounts) + feeSat
 * In aggregate the identity checked is:
 *     rewardInSat == payoutsSat + feeSat + carryOverDeltaSat
 * where payoutsSat is the sum of the RECORDED payout batches and
 * carryOverDeltaSat is computed INDEPENDENTLY by a FIFO simulation:
 * every credited lot is consumed oldest-first by recorded batches, and
 * whatever credit remains unconsumed is the carry-over. Balances in the
 * store (pending / paid) are cross-checked against the same simulation.
 *
 * NOTHING is force-balanced: every mismatch becomes a discrepancy
 * object { scope, kind, algo, height, expectedSat, actualSat, deltaSat,
 * message, severity } in the result. `balanced` is true only when
 * there are no error-severity discrepancies.
 */

var verifySplit = require('./verifySplit');

function storeOf(input) {
    if (!input) return { shares: [], blocks: [], balances: {}, payouts: [] };
    if (typeof input.getBlocks === 'function') { // a Ledger instance
        return {
            shares: typeof input.getShares === 'function'
                ? ['sha256', 'yespower', 'ethash'].reduce(function (acc, a) {
                    return acc.concat(input.getShares(a));
                }, []) : [],
            blocks: input.getBlocks(),
            balances: typeof input.getBalances === 'function' ? input.getBalances() : {},
            payouts: typeof input.getPayouts === 'function' ? input.getPayouts() : []
        };
    }
    var data = input.data && typeof input.data === 'object' ? input.data : input;
    return {
        shares: Array.isArray(data.shares) ? data.shares : [],
        blocks: Array.isArray(data.blocks) ? data.blocks : [],
        balances: (data.balances && typeof data.balances === 'object') ? data.balances : {},
        payouts: Array.isArray(data.payouts) ? data.payouts : []
    };
}

function isSettled(block) {
    // Empty-split blocks (amounts {} + emptySplit) are NOT settled splits:
    // their reward is undistributed and is accounted separately below.
    return !!block && block.scheme !== 'solo' &&
        block.amounts && typeof block.amounts === 'object' && block.emptySplit !== true;
}

function isEmptySplit(block) {
    return !!block && block.scheme !== 'solo' && block.emptySplit === true &&
        (block.status === 'confirmed' || block.status === 'paid');
}

function sumMap(map) {
    return Object.keys(map || {}).reduce(function (s, k) { return s + (Number(map[k]) || 0); }, 0);
}

/*
 * FIFO simulation over settled blocks + recorded batches.
 * Events are processed in (time, kind) order, blocks before batches at
 * equal times. Returns lots, per-block/per-miner paid & carry figures,
 * per-payout consumption, and unattributed batch amounts.
 */
function simulate(rawStore) {
    var store = storeOf(rawStore);
    var settled = store.blocks.filter(isSettled)
        .sort(function (a, b) { return (a.time - b.time) || (a.height - b.height); });
    var payouts = store.payouts.slice()
        .sort(function (a, b) { return (a.time - b.time) || String(a.id).localeCompare(String(b.id)); });

    var lots = []; // {algo, height, hash, address, amountSat, paidSat}
    var lotQueues = {}; // algo|address -> [lot indexes, FIFO]
    var pendingBefore = {}; // blockKey -> {address: pendingSat before this block's credit}
    var blockKey = function (b) { return b.algo + '|' + b.hash; };
    var consumptionByPayout = {}; // payoutId -> [{height, hash, address, sat}]
    var unattributedByPayout = {}; // payoutId -> sat paid beyond recorded credits

    function applyPayout(p) {
        consumptionByPayout[p.id] = [];
        var excess = 0;
        Object.keys(p.amounts || {}).sort().forEach(function (addr) {
            var remaining = Math.round(Number(p.amounts[addr]) || 0);
            var queue = lotQueues[p.algo + '|' + addr] || [];
            for (var i = 0; i < queue.length && remaining > 0; i++) {
                var lot = lots[queue[i]];
                var avail = lot.amountSat - lot.paidSat;
                if (avail <= 0) continue;
                var take = Math.min(avail, remaining);
                lot.paidSat += take;
                remaining -= take;
                consumptionByPayout[p.id].push({ height: lot.height, hash: lot.hash, address: addr, sat: take });
            }
            if (remaining > 0) excess += remaining;
        });
        unattributedByPayout[p.id] = excess;
    }

    var pi = 0;
    settled.forEach(function (block) {
        // Batches timestamped before this block settle earlier credits.
        while (pi < payouts.length && payouts[pi].time < block.time) applyPayout(payouts[pi++]);
        var key = blockKey(block);
        pendingBefore[key] = {};
        Object.keys(block.amounts).forEach(function (addr) {
            var queue = lotQueues[block.algo + '|' + addr] || [];
            var pending = 0;
            queue.forEach(function (idx) { pending += lots[idx].amountSat - lots[idx].paidSat; });
            pendingBefore[key][addr] = pending;
        });
        Object.keys(block.amounts).forEach(function (addr) {
            var lot = {
                algo: block.algo, height: block.height, hash: block.hash,
                address: addr, amountSat: Math.round(Number(block.amounts[addr]) || 0), paidSat: 0
            };
            lots.push(lot);
            var qk = block.algo + '|' + addr;
            if (!lotQueues[qk]) lotQueues[qk] = [];
            lotQueues[qk].push(lots.length - 1);
        });
        // Batches at the same timestamp as the block settle after it.
        while (pi < payouts.length && payouts[pi].time === block.time) applyPayout(payouts[pi++]);
    });
    while (pi < payouts.length) applyPayout(payouts[pi++]);

    var perBlock = {}; // blockKey -> {address: {creditedSat, paidSat, carrySat}}
    lots.forEach(function (lot) {
        var key = lot.algo + '|' + lot.hash;
        if (!perBlock[key]) perBlock[key] = {};
        perBlock[key][lot.address] = {
            creditedSat: lot.amountSat,
            paidSat: lot.paidSat,
            carrySat: lot.amountSat - lot.paidSat
        };
    });

    return {
        store: store,
        settled: settled,
        payouts: payouts,
        lots: lots,
        perBlock: perBlock,
        pendingBefore: pendingBefore,
        consumptionByPayout: consumptionByPayout,
        unattributedByPayout: unattributedByPayout,
        blockKey: blockKey
    };
}

/* Carry-in consumed by the batch that settled `block`, per miner: the
 * satoshis of OLDER lots (other blocks) that block's payout batch paid. */
function carryConsumedByBlockBatch(sim, block) {
    var out = {};
    if (!block.payoutId) return out;
    var consumed = sim.consumptionByPayout[block.payoutId] || [];
    consumed.forEach(function (c) {
        if (c.hash === block.hash) return;
        out[c.address] = (out[c.address] || 0) + c.sat;
    });
    return out;
}

function reconcile(rawStore) {
    var sim = simulate(rawStore);
    var store = sim.store;
    var discrepancies = [];

    function discrepancy(scope, kind, algo, height, expectedSat, actualSat, message, severity) {
        discrepancies.push({
            scope: scope, kind: kind, algo: algo || null, height: (height == null ? null : height),
            expectedSat: expectedSat, actualSat: actualSat,
            deltaSat: actualSat - expectedSat,
            message: message, severity: severity || 'error'
        });
    }

    var perBlock = [];
    var rewardInSat = 0, creditedSatTotal = 0, feeSatTotal = 0;
    sim.settled.forEach(function (block) {
        var credited = sumMap(block.amounts);
        var feeSat = Math.round(Number(block.feeSat) || 0);
        var reward = Math.round(Number(block.reward) || 0);
        rewardInSat += reward; creditedSatTotal += credited; feeSatTotal += feeSat;
        var balanced = (reward === credited + feeSat);
        if (!balanced)
            discrepancy('block', 'reward-mismatch', block.algo, block.height,
                reward, credited + feeSat,
                'block ' + block.height + ' (' + block.algo + '): reward ' + reward +
                ' sat != credited ' + credited + ' + fee ' + feeSat);
        var lotsForBlock = sim.perBlock[sim.blockKey(block)] || {};
        var paidSat = 0, carrySat = 0;
        Object.keys(lotsForBlock).forEach(function (a) {
            paidSat += lotsForBlock[a].paidSat; carrySat += lotsForBlock[a].carrySat;
        });
        perBlock.push({
            height: block.height, algo: block.algo, hash: block.hash,
            scheme: block.scheme, status: block.status,
            rewardSat: reward, rewardCoins: verifySplit.satToCoins(reward),
            creditedSat: credited, feeSat: feeSat,
            paidOutSat: paidSat, carryOverSat: carrySat,
            balanced: balanced
        });
    });

    // Settled-but-empty splits: the reward was recorded as undistributed.
    var undistributedSat = 0;
    store.blocks.filter(isEmptySplit).forEach(function (block) {
        undistributedSat += Math.round(Number(block.reward) || 0);
        discrepancy('block', 'undistributed-reward', block.algo, block.height,
            0, Math.round(Number(block.reward) || 0),
            'block ' + block.height + ' (' + block.algo + ') settled with NO recorded shares: reward of ' +
            block.reward + ' sat is undistributed (not paid, not fee, not carry-over)');
    });

    var payoutsSat = 0;
    sim.payouts.forEach(function (p) { payoutsSat += sumMap(p.amounts); });
    var unattributedSat = Object.keys(sim.unattributedByPayout)
        .reduce(function (s, k) { return s + sim.unattributedByPayout[k]; }, 0);

    var fifoPaidSat = 0, carryOverDeltaSat = 0;
    sim.lots.forEach(function (lot) {
        fifoPaidSat += lot.paidSat;
        carryOverDeltaSat += lot.amountSat - lot.paidSat;
    });

    sim.payouts.forEach(function (p) {
        var excess = sim.unattributedByPayout[p.id] || 0;
        if (excess > 0)
            discrepancy('payout', 'batch-exceeds-credits', p.algo, null,
                sumMap(p.amounts) - excess, sumMap(p.amounts),
                'payout batch ' + p.id + ' pays ' + excess + ' sat beyond all recorded block credits');
        var inFlight = !p.dryRun && (p.stage === 'created' || p.stage === 'processed' || p.stage === 'finalized');
        if (inFlight)
            discrepancy('payout', 'batch-in-flight', p.algo, null,
                sumMap(p.amounts), sumMap(p.amounts),
                'payout batch ' + p.id + ' is recorded at PSBT stage "' + p.stage +
                '" and not yet broadcast; its amounts are not yet moved to paid balances', 'notice');
    });

    // Cross-check FIFO against the recorded balances (independent books).
    var balancesPendingSat = 0, balancesPaidSat = 0;
    Object.keys(store.balances).forEach(function (algo) {
        Object.keys(store.balances[algo] || {}).forEach(function (addr) {
            var e = store.balances[algo][addr] || {};
            balancesPendingSat += Math.round(Number(e.pending) || 0);
            balancesPaidSat += Math.round(Number(e.paid) || 0);
        });
    });
    if (balancesPendingSat !== carryOverDeltaSat)
        discrepancy('aggregate', 'balances-pending-mismatch', null, null,
            carryOverDeltaSat, balancesPendingSat,
            'recorded balances.pending total ' + balancesPendingSat +
            ' sat != FIFO carry-over from settled blocks ' + carryOverDeltaSat + ' sat');
    if (balancesPaidSat !== fifoPaidSat)
        discrepancy('aggregate', 'balances-paid-mismatch', null, null,
            fifoPaidSat, balancesPaidSat,
            'recorded balances.paid total ' + balancesPaidSat +
            ' sat != FIFO-consumed credits ' + fifoPaidSat + ' sat');

    /* The full aggregate identity. rewardInSat here counts settled
     * blocks only; empty-split rewards ride in undistributedSat, and
     * batch amounts beyond recorded credits in unattributedSat:
     *   rewardIn + undistributed == payouts - unattributed + fees
     *                               + carryOverDelta + undistributed
     * i.e. rewardIn == payouts + fees + carryOverDelta - unattributed.
     * When there are no empty splits and no excess batch amounts this
     * reduces to the headline equation in `equation`. */
    var totalRewardInSat = rewardInSat + undistributedSat;
    var equationHolds =
        (totalRewardInSat === payoutsSat + feeSatTotal + carryOverDeltaSat + undistributedSat - unattributedSat) &&
        discrepancies.every(function (d) { return d.severity !== 'error'; });

    return {
        generatedAt: Math.floor(Date.now() / 1000),
        settledBlocks: perBlock.length,
        perBlock: perBlock,
        aggregate: {
            rewardInSat: totalRewardInSat,
            rewardInCoins: verifySplit.satToCoins(totalRewardInSat),
            settledRewardSat: rewardInSat,
            creditedSat: creditedSatTotal,
            payoutsSat: payoutsSat,
            payoutsCoins: verifySplit.satToCoins(payoutsSat),
            feeSat: feeSatTotal,
            feeCoins: verifySplit.satToCoins(feeSatTotal),
            carryOverDeltaSat: carryOverDeltaSat,
            carryOverDeltaCoins: verifySplit.satToCoins(carryOverDeltaSat),
            undistributedSat: undistributedSat,
            unattributedPayoutSat: unattributedSat,
            balancesPendingSat: balancesPendingSat,
            balancesPaidSat: balancesPaidSat,
            equation: 'rewardInSat == payoutsSat + feeSat + carryOverDeltaSat',
            holds: equationHolds
        },
        discrepancies: discrepancies,
        balanced: discrepancies.every(function (d) { return d.severity !== 'error'; })
    };
}

module.exports = {
    reconcile: reconcile,
    simulate: simulate,
    carryConsumedByBlockBatch: carryConsumedByBlockBatch,
    storeOf: storeOf,
    isSettled: isSettled
};
