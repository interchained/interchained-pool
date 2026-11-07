'use strict';
/*
 * verifySplit.js -- shared, pure recompute logic for payout fairness.
 *
 * Used by lib/payouts/breakdown.js, lib/payouts/reconcile.js, the API
 * fairness endpoints and the standalone scripts/verify-payout.js CLI, so
 * the pool's own published numbers and a miner's independent check are
 * produced by EXACTLY the same code path -- and that code path is the
 * pool's actual splitting code (lib/payouts/schemes.js), not a copy of
 * its formulas. If schemes.js semantics ever change, every consumer of
 * this module changes with it.
 *
 * Pure JS + Node builtins only. All amounts are INTEGER satoshis.
 *
 * Semantics (inherited verbatim from schemes.js / payments.js):
 * - PROP: shares of the block's algo with prevBlockTime < time <=
 *   block.time share the reward, weighted by share `difficulty` (the
 *   ACCEPTED difficulty recorded in the ledger -- never shareDiff).
 * - PPLNS: the last `windowN` shares of the block's algo with
 *   time <= block.time, same weighting.
 * - Fee is deducted FIRST: feeSat = floor(reward * feePercent / 100).
 * - Each miner gets floor(distributable * weight / totalWeight); the
 *   rounding remainder goes to the largest-weight miner (finder wins
 *   ties, then lexicographically first address), so
 *   sum(amounts) + feeSat === rewardSat exactly for non-empty splits.
 * - Empty / zero-weight splits produce no amounts and NO fee.
 * - Min-payout carry-over (payments.js): a miner is paid by a batch only
 *   when their pending balance (carry-in + credited amounts) reaches
 *   minPayoutSat; otherwise the whole balance carries over.
 */

var schemes = require('./schemes');

var SAT_PER_COIN = 100000000;

function satToCoins(sat) { return (Number(sat) || 0) / SAT_PER_COIN; }

/*
 * prevBlockTimeFor(blocks, block) -- the PROP round boundary: the time of
 * the previous recorded block of the same algo, strictly before `block`.
 * Any status counts (a round is defined by when blocks were found, not
 * by their payout fate). Mirrors payments.js prevBlockTime() exactly.
 * Returns null when there is no previous block (round starts at -inf).
 */
function prevBlockTimeFor(blocks, block) {
    var prev = null;
    (blocks || []).forEach(function (b) {
        if (!b || b.hash === block.hash || b.algo !== block.algo) return;
        if (b.time < block.time && (prev === null || b.time > prev)) prev = b.time;
        else if (b.time === block.time && b.height < block.height && prev === null) prev = b.time;
    });
    return prev;
}

/*
 * computeWindow(shares, block, options) -> {
 *   scheme, definition,
 *   prevBlockTime,          // PROP only (null = beginning of time)
 *   windowN,                // PPLNS only (null = all eligible shares)
 *   fromTime, toTime,       // inclusive/exclusive bounds actually applied
 *   shares,                 // the share entries in the window, time-ordered
 *   shareCount
 * }
 * options: { prevBlockTime, windowN } -- when prevBlockTime is undefined
 * the caller must supply it via options.allBlocks (handled by callers
 * that have the whole store); computeSplit below takes it explicitly.
 */
function computeWindow(shares, block, options) {
    options = options || {};
    var algoShares = (shares || []).filter(function (s) { return s && s.algo === block.algo; });
    var scheme = block.scheme || 'solo';
    if (scheme === 'prop') {
        var from = (typeof options.prevBlockTime === 'number') ? options.prevBlockTime : -Infinity;
        var inRound = algoShares.filter(function (s) {
            return s.time > from && s.time <= block.time;
        });
        inRound.sort(function (a, b) { return a.time - b.time; });
        return {
            scheme: 'prop',
            definition: 'PROP round: all ' + block.algo + ' shares with prevBlockTime < time <= block.time',
            prevBlockTime: (typeof options.prevBlockTime === 'number') ? options.prevBlockTime : null,
            windowN: null,
            fromTime: (typeof options.prevBlockTime === 'number') ? options.prevBlockTime : null,
            fromExclusive: true,
            toTime: block.time,
            toInclusive: true,
            shares: inRound,
            shareCount: inRound.length
        };
    }
    if (scheme === 'pplns') {
        var eligible = algoShares.filter(function (s) { return s.time <= block.time; });
        eligible.sort(function (a, b) { return a.time - b.time; });
        var windowN = (typeof options.windowN === 'number' && options.windowN > 0)
            ? Math.floor(options.windowN) : null;
        var used = (windowN !== null && eligible.length > windowN)
            ? eligible.slice(eligible.length - windowN) : eligible;
        return {
            scheme: 'pplns',
            definition: 'PPLNS: last ' + (windowN === null ? 'N (unbounded: all eligible)' : windowN) +
                ' ' + block.algo + ' shares with time <= block.time, by count',
            prevBlockTime: null,
            windowN: windowN,
            fromTime: used.length ? used[0].time : null,
            fromExclusive: false,
            toTime: block.time,
            toInclusive: true,
            shares: used,
            shareCount: used.length
        };
    }
    // solo (or unknown): no shared window -- the coinbase pays the finder.
    return {
        scheme: scheme,
        definition: 'solo: no share window; the coinbase pays the finder directly',
        prevBlockTime: null,
        windowN: null,
        fromTime: null,
        fromExclusive: false,
        toTime: block.time,
        toInclusive: true,
        shares: [],
        shareCount: 0
    };
}

/*
 * computeSplit(shares, block, options) -> {
 *   scheme, window, weights, shareCounts, totalWeight,
 *   feeSat, amounts, distributableSat
 * }
 * options: { feePercent, prevBlockTime, windowN }
 * Weights/shareCounts are built from the SAME window shares, counting
 * each share once and weighting by its recorded `difficulty`.
 */
function computeSplit(shares, block, options) {
    options = options || {};
    var win = computeWindow(shares, block, options);
    var weights = {};
    var shareCounts = {};
    win.shares.forEach(function (s) {
        var addr = s.worker || s.address || null;
        if (!addr) return;
        weights[addr] = (weights[addr] || 0) + (Number(s.difficulty) || 0);
        shareCounts[addr] = (shareCounts[addr] || 0) + 1;
    });
    var totalWeight = Object.keys(weights).reduce(function (sum, a) { return sum + weights[a]; }, 0);
    var amounts = {};
    var feeSat = 0;
    var distributableSat = 0;
    if (win.scheme === 'prop' || win.scheme === 'pplns') {
        var split = schemes.splitReward(block.reward, weights, options.feePercent, block.finder);
        amounts = split.amounts;
        feeSat = split.feeSat;
        distributableSat = Object.keys(amounts).reduce(function (s, a) { return s + amounts[a]; }, 0);
    }
    return {
        scheme: win.scheme,
        window: win,
        weights: weights,
        shareCounts: shareCounts,
        totalWeight: totalWeight,
        feeSat: feeSat,
        amounts: amounts,
        distributableSat: distributableSat
    };
}

/*
 * expectedBatchAmounts(creditedList, carryIn, minPayoutSat) -> amounts
 * The min-payout carry-over rule of payments.js, applied to a sequence
 * of credited amount-maps (oldest first) plus a carry-in balance map:
 * a miner appears in the batch iff their total pending reaches
 * minPayoutSat (and is > 0); the batch pays their FULL pending.
 * Miners below threshold are absent -- their balance carries over.
 */
function expectedBatchAmounts(creditedList, carryIn, minPayoutSat) {
    var pending = {};
    Object.keys(carryIn || {}).forEach(function (a) { pending[a] = Math.round(Number(carryIn[a]) || 0); });
    (creditedList || []).forEach(function (amounts) {
        Object.keys(amounts || {}).forEach(function (a) {
            pending[a] = (pending[a] || 0) + Math.round(Number(amounts[a]) || 0);
        });
    });
    var threshold = (typeof minPayoutSat === 'number') ? minPayoutSat : 0;
    var out = {};
    Object.keys(pending).forEach(function (a) {
        if (pending[a] > 0 && pending[a] >= threshold) out[a] = pending[a];
    });
    return out;
}

/* ---------------- PSBT output extraction (BIP174, pure JS) -------- */

var B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest(); }

function base58CheckEncode(versionByte, payload) {
    var body = Buffer.concat([Buffer.from([versionByte]), payload]);
    var checksum = sha256(sha256(body)).slice(0, 4);
    var full = Buffer.concat([body, checksum]);
    var zeros = 0;
    while (zeros < full.length && full[zeros] === 0) zeros++;
    var digits = [0];
    for (var i = zeros; i < full.length; i++) {
        var carry = full[i];
        for (var j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (var z = 0; z < zeros; z++) out += '1';
    for (var k = digits.length - 1; k >= 0; k--) out += B58_ALPHABET[digits[k]];
    return out;
}

/* scriptPubKey -> base58check address for the standard ITC/BTC forms:
 * P2PKH (pubKeyHash, default 0x00) and P2SH (scriptHash, default 0x05),
 * matching lib/interchained-network.js. Returns null for other scripts. */
function scriptToAddress(script, versions) {
    versions = versions || {};
    var pubKeyHash = (typeof versions.pubKeyHash === 'number') ? versions.pubKeyHash : 0x00;
    var scriptHash = (typeof versions.scriptHash === 'number') ? versions.scriptHash : 0x05;
    if (!Buffer.isBuffer(script)) script = Buffer.from(script);
    if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 &&
        script[23] === 0x88 && script[24] === 0xac)
        return base58CheckEncode(pubKeyHash, script.slice(3, 23));
    if (script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87)
        return base58CheckEncode(scriptHash, script.slice(2, 22));
    return null;
}

function readVarInt(buf, offset) {
    var first = buf[offset];
    if (first < 0xfd) return { value: first, size: 1 };
    if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 };
    if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 };
    var big = buf.readBigUInt64LE(offset + 1);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('varint too large');
    return { value: Number(big), size: 9 };
}

/* Parse the unsigned transaction inside a PSBT and return its outputs
 * as { address: satoshis }. Throws on anything unparseable -- callers
 * must treat a throw as "PSBT could not be verified", never as a pass. */
function parsePsbtOutputs(psbtBase64, versions) {
    var buf = Buffer.from(String(psbtBase64 || ''), 'base64');
    if (buf.length < 5 || buf.slice(0, 4).toString('latin1') !== 'psbt' || buf[4] !== 0xff)
        throw new Error('not a PSBT (bad magic)');
    var offset = 5;
    var unsignedTx = null;
    while (offset < buf.length && buf[offset] !== 0x00) {
        var klen = readVarInt(buf, offset); offset += klen.size;
        var key = buf.slice(offset, offset + klen.value); offset += klen.value;
        var vlen = readVarInt(buf, offset); offset += vlen.size;
        var value = buf.slice(offset, offset + vlen.value); offset += vlen.value;
        if (key.length === 1 && key[0] === 0x00) unsignedTx = value;
    }
    if (!unsignedTx) throw new Error('PSBT has no unsigned transaction');
    var tx = unsignedTx;
    var p = 4; // version
    var inCount = readVarInt(tx, p); p += inCount.size;
    // Segwit marker/flag, if present: unsigned PSBT txs are normally
    // non-segwit, but tolerate the marker so a witness tx still parses.
    var segwit = false;
    if (inCount.value === 0) {
        var flag = readVarInt(tx, p); p += flag.size;
        inCount = readVarInt(tx, p); p += inCount.size;
        segwit = true;
    }
    for (var i = 0; i < inCount.value; i++) {
        p += 32 + 4; // prev txid + vout
        var slen = readVarInt(tx, p); p += slen.size + slen.value; // scriptSig
        p += 4; // sequence
    }
    var outCount = readVarInt(tx, p); p += outCount.size;
    var outputs = {};
    var unmapped = 0;
    for (var o = 0; o < outCount.value; o++) {
        var sat = Number(tx.readBigUInt64LE(p)); p += 8;
        var olen = readVarInt(tx, p); p += olen.size;
        var script = tx.slice(p, p + olen.value); p += olen.value;
        var addr = scriptToAddress(script, versions);
        if (addr) outputs[addr] = (outputs[addr] || 0) + sat;
        else if (sat > 0) unmapped += sat;
    }
    if (segwit) { /* witness data follows; output parsing above is complete */ }
    if (unmapped > 0)
        throw new Error('PSBT has ' + unmapped + ' sat in outputs with non-standard scripts (cannot map to addresses)');
    return outputs;
}

/* Compare two {address: satoshis} maps; returns a list of human-readable
 * difference strings (empty when identical). */
function diffAmountMaps(labelA, a, labelB, b) {
    var diffs = [];
    var keys = {};
    Object.keys(a || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(b || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).sort().forEach(function (addr) {
        var av = (a && typeof a[addr] === 'number') ? a[addr] : null;
        var bv = (b && typeof b[addr] === 'number') ? b[addr] : null;
        if (av === bv) return;
        diffs.push(addr + ': ' + labelA + '=' + (av === null ? '(absent)' : av + ' sat') +
            ' vs ' + labelB + '=' + (bv === null ? '(absent)' : bv + ' sat'));
    });
    return diffs;
}

module.exports = {
    SAT_PER_COIN: SAT_PER_COIN,
    satToCoins: satToCoins,
    prevBlockTimeFor: prevBlockTimeFor,
    computeWindow: computeWindow,
    computeSplit: computeSplit,
    expectedBatchAmounts: expectedBatchAmounts,
    parsePsbtOutputs: parsePsbtOutputs,
    scriptToAddress: scriptToAddress,
    base58CheckEncode: base58CheckEncode,
    diffAmountMaps: diffAmountMaps
};
