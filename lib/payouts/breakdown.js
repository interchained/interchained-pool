'use strict';
/*
 * breakdown.js -- per-block payout breakdown: the public, auditable
 * answer to "exactly where did this block's reward go?".
 *
 * Pure JS + Node builtins. Integer satoshis (coins = sat / 1e8).
 * Reads the payouts ledger store through reconcile.storeOf(), so it
 * accepts a Ledger instance, a ledger.data object, or a parsed store
 * JSON (which is exactly what the API layer loads from disk). It never
 * edits ledger.js and never mutates the store.
 *
 * For every block it reports the RECORDED split (block.amounts /
 * block.feeSat, written by the payments processor at settle time) AND
 * an independent RECOMPUTE from the raw shares via verifySplit.js
 * (which delegates to schemes.js itself). `matchesRecorded` is true
 * only when the two agree to the satoshi.
 *
 * Carry-over fields per miner (FIFO model, see reconcile.js):
 * - carryOverInSat: pending credit from EARLIER blocks still unpaid
 *   when this block was credited.
 * - payoutAmountSat / amountSat: this block's split credit to the miner.
 * - paidOutSat: how much of THIS block's credit recorded payout batches
 *   have since paid out (FIFO consumption of this block's lot).
 * - carryOverCreatedSat: amountSat - paidOutSat -- the part of this
 *   block's credit still carried as pending balance.
 * - carryOverConsumedSat: how much of the miner's OLDER carry-over the
 *   payout batch that settled this block paid out.
 *
 * options: { feePercent, windowN / pplnsWindow, minPayoutSat,
 *            schemes: { algo: { scheme, pplnsWindow } } }
 * feePercent defaults per block to the effective recorded rate when no
 * configured rate is supplied; windowN falls back to the per-algo
 * scheme config when present.
 */

var verifySplit = require('./verifySplit');
var reconcile = require('./reconcile');

function sumMap(map) {
    return Object.keys(map || {}).reduce(function (s, k) { return s + (Number(map[k]) || 0); }, 0);
}

function windowNFor(options, algo) {
    if (typeof options.windowN === 'number') return options.windowN;
    if (typeof options.pplnsWindow === 'number') return options.pplnsWindow;
    var s = options.schemes && options.schemes[algo];
    if (s && typeof s.pplnsWindow === 'number') return s.pplnsWindow;
    return null;
}

function findBlocks(store, height, algo) {
    return store.blocks.filter(function (b) {
        return b && Number(b.height) === Number(height) &&
            (!algo || b.algo === algo);
    });
}

function buildBreakdown(rawStore, block, options, sim) {
    options = options || {};
    var store = reconcile.storeOf(rawStore);
    sim = sim || reconcile.simulate(store);
    var algoShares = store.shares.filter(function (s) { return s && s.algo === block.algo; });

    var prevBlockTime = verifySplit.prevBlockTimeFor(store.blocks, block);
    var feePercent = (typeof options.feePercent === 'number') ? options.feePercent
        : (block.reward > 0 && typeof block.feeSat === 'number'
            ? (block.feeSat * 100 / block.reward) : 0);
    var split = verifySplit.computeSplit(algoShares, block, {
        feePercent: feePercent,
        prevBlockTime: prevBlockTime,
        windowN: windowNFor(options, block.algo)
    });

    var recordedAmounts = (block.amounts && typeof block.amounts === 'object') ? block.amounts : null;
    var recordedFeeSat = (typeof block.feeSat === 'number') ? block.feeSat : null;
    var recomputedMatches = recordedAmounts !== null &&
        verifySplit.diffAmountMaps('recorded', recordedAmounts, 'recomputed', split.amounts).length === 0 &&
        recordedFeeSat === split.feeSat;

    var key = sim.blockKey(block);
    var fifo = sim.perBlock[key] || {};
    var pendingBefore = sim.pendingBefore[key] || {};
    var batchCarryConsumed = reconcile.carryConsumedByBlockBatch(sim, block);
    var batch = null;
    if (block.payoutId) {
        for (var i = 0; i < store.payouts.length; i++)
            if (store.payouts[i].id === block.payoutId) { batch = store.payouts[i]; break; }
    }

    var addresses = {};
    [split.amounts, recordedAmounts || {}, fifo].forEach(function (map) {
        Object.keys(map).forEach(function (a) { addresses[a] = true; });
    });
    if (block.scheme === 'solo' && block.finder) addresses[block.finder] = true;

    var miners = Object.keys(addresses).sort().map(function (addr) {
        var f = fifo[addr] || { creditedSat: 0, paidSat: 0, carrySat: 0 };
        var amountSat = (recordedAmounts && typeof recordedAmounts[addr] === 'number')
            ? recordedAmounts[addr]
            : (typeof split.amounts[addr] === 'number' ? split.amounts[addr] : 0);
        if (block.scheme === 'solo' && !recordedAmounts) amountSat = (addr === block.finder) ? block.reward : 0;
        return {
            address: addr,
            shareCount: split.shareCounts[addr] || 0,
            weight: split.weights[addr] || 0,
            weightPercent: split.totalWeight > 0
                ? Math.round((split.weights[addr] || 0) / split.totalWeight * 10000) / 100 : 0,
            payoutAmountSat: amountSat,
            payoutAmountCoins: verifySplit.satToCoins(amountSat),
            amountSat: amountSat,
            recomputedAmountSat: (typeof split.amounts[addr] === 'number') ? split.amounts[addr] : 0,
            carryOverInSat: pendingBefore[addr] || 0,
            carryOverCreatedSat: f.carrySat,
            carryOverConsumedSat: batchCarryConsumed[addr] || 0,
            paidOutSat: f.paidSat
        };
    });

    var creditedSat = recordedAmounts ? sumMap(recordedAmounts) : split.distributableSat;
    return {
        height: block.height,
        algo: block.algo,
        hash: block.hash,
        finder: block.finder || null,
        time: block.time,
        status: block.status || 'pending',
        scheme: block.scheme || 'solo',
        settled: reconcile.isSettled(block),
        rewardSat: Math.round(Number(block.reward) || 0),
        rewardCoins: verifySplit.satToCoins(block.reward),
        feePercent: feePercent,
        feeSat: recordedFeeSat !== null ? recordedFeeSat : split.feeSat,
        feeCoins: verifySplit.satToCoins(recordedFeeSat !== null ? recordedFeeSat : split.feeSat),
        recomputedFeeSat: split.feeSat,
        creditedSat: creditedSat,
        creditedCoins: verifySplit.satToCoins(creditedSat),
        balanced: (Math.round(Number(block.reward) || 0) === creditedSat +
            (recordedFeeSat !== null ? recordedFeeSat : split.feeSat)) || block.scheme === 'solo',
        shareWindow: {
            scheme: split.window.scheme,
            definition: split.window.definition,
            prevBlockTime: split.window.prevBlockTime,
            windowN: split.window.windowN,
            fromTime: split.window.fromTime,
            fromExclusive: split.window.fromExclusive,
            toTime: split.window.toTime,
            toInclusive: split.window.toInclusive,
            shareCount: split.window.shareCount,
            firstShareTime: split.window.shares.length ? split.window.shares[0].time : null,
            lastShareTime: split.window.shares.length
                ? split.window.shares[split.window.shares.length - 1].time : null
        },
        totalWeight: split.totalWeight,
        miners: miners,
        recorded: recordedAmounts ? { amounts: recordedAmounts, feeSat: recordedFeeSat } : null,
        recomputed: { amounts: split.amounts, feeSat: split.feeSat },
        matchesRecorded: recordedAmounts ? recomputedMatches : null,
        payoutBatch: batch ? {
            id: batch.id, time: batch.time, dryRun: !!batch.dryRun,
            stage: batch.stage || null, txid: batch.txid || null,
            amounts: batch.amounts || {}, feeSat: batch.fee || 0,
            blocks: batch.blocks || []
        } : null,
        minPayoutSat: (typeof options.minPayoutSat === 'number') ? options.minPayoutSat : null
    };
}

/* Breakdown for one height. Returns a single breakdown object, an
 * array when several algos share the height, or null when unknown. */
function breakdownForHeight(rawStore, height, options) {
    var store = reconcile.storeOf(rawStore);
    var matches = findBlocks(store, height, options && options.algo);
    if (matches.length === 0) return null;
    var sim = reconcile.simulate(store);
    var out = matches.map(function (b) { return buildBreakdown(store, b, options, sim); });
    return out.length === 1 ? out[0] : out;
}

/* Summary list for every recorded block, newest first. */
function listBreakdowns(rawStore, options) {
    var store = reconcile.storeOf(rawStore);
    var sim = reconcile.simulate(store);
    return store.blocks.filter(function (b) { return !!b; })
        .sort(function (a, b) { return (b.time - a.time) || (b.height - a.height); })
        .map(function (b) {
            var bd = buildBreakdown(store, b, options, sim);
            return {
                height: bd.height, algo: bd.algo, hash: bd.hash, time: bd.time,
                status: bd.status, scheme: bd.scheme, settled: bd.settled,
                rewardSat: bd.rewardSat, rewardCoins: bd.rewardCoins,
                feeSat: bd.feeSat, feePercent: bd.feePercent,
                creditedSat: bd.creditedSat, balanced: bd.balanced,
                matchesRecorded: bd.matchesRecorded,
                miners: bd.miners.length,
                shareCount: bd.shareWindow.shareCount,
                breakdownUrl: '/api/blocks/' + bd.height + '/breakdown?algo=' + bd.algo,
                ledgerUrl: '/api/blocks/' + bd.height + '/ledger?algo=' + bd.algo
            };
        });
}

/*
 * Raw ledger export for one block: everything an independent verifier
 * needs, and nothing it has to trust -- the raw share entries for the
 * block's algo, the block record as stored, the recorded split, the
 * recorded payout batch (with its PSBT), and the parameters the split
 * was computed under (prevBlockTime, windowN, feePercent, minPayoutSat,
 * plus each miner's carry-in before this block).
 */
function ledgerExport(rawStore, height, options) {
    options = options || {};
    var store = reconcile.storeOf(rawStore);
    var matches = findBlocks(store, height, options.algo);
    if (matches.length === 0) return null;
    var block = matches[0];
    var sim = reconcile.simulate(store);
    var bd = buildBreakdown(store, block, options, sim);
    var batch = null;
    if (block.payoutId) {
        for (var i = 0; i < store.payouts.length; i++)
            if (store.payouts[i].id === block.payoutId) { batch = store.payouts[i]; break; }
    }
    if (!batch && options.includeBatch !== false) {
        // Fall back to a batch that lists this height (defensive: the
        // block's payoutId link is the primary key, this is a cross-check).
        for (var j = 0; j < store.payouts.length; j++) {
            var p = store.payouts[j];
            if (p.algo === block.algo && (p.blocks || []).indexOf(block.height) !== -1) { batch = p; break; }
        }
    }
    var carryIn = {};
    var pendingBefore = sim.pendingBefore[sim.blockKey(block)] || {};
    Object.keys(pendingBefore).forEach(function (a) {
        if (pendingBefore[a] > 0) carryIn[a] = pendingBefore[a];
    });
    return {
        format: 'itc-pool-payout-export',
        version: 1,
        exportedAt: Math.floor(Date.now() / 1000),
        block: block,
        shares: store.shares.filter(function (s) { return s && s.algo === block.algo; }),
        windowShares: bd.shareWindow ? verifySplit.computeWindow(
            store.shares, block, {
                prevBlockTime: bd.shareWindow.prevBlockTime,
                windowN: bd.shareWindow.windowN
            }).shares : [],
        prevBlockTime: bd.shareWindow.prevBlockTime,
        windowN: bd.shareWindow.windowN,
        feePercent: bd.feePercent,
        minPayoutSat: (typeof options.minPayoutSat === 'number') ? options.minPayoutSat : null,
        carryIn: carryIn,
        recorded: bd.recorded,
        breakdown: bd,
        batch: batch
    };
}

module.exports = {
    buildBreakdown: buildBreakdown,
    breakdownForHeight: breakdownForHeight,
    listBreakdowns: listBreakdowns,
    ledgerExport: ledgerExport
};
