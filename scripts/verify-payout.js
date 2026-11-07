#!/usr/bin/env node
'use strict';
/*
 * verify-payout.js -- independent payout verification for miners.
 *
 * Zero trust in the operator required: this script uses ONLY Node.js
 * builtins and this repository's pure-JS payout modules
 * (lib/payouts/verifySplit.js -> lib/payouts/schemes.js). It makes no
 * network calls and reads no pool state beyond the files you give it.
 *
 * Usage:
 *   node scripts/verify-payout.js <export.json> [recorded.json]
 *
 * <export.json> is a ledger export as served by
 *   GET /api/blocks/<height>/ledger
 * (or a saved copy of it). It carries the raw share entries, the block
 * record, and the parameters the split claims to use (feePercent,
 * prevBlockTime, windowN, minPayoutSat, carryIn).
 *
 * [recorded.json] is optional: a separate recorded breakdown/batch file
 * ({ amounts, feeSat } or { breakdown } or { recorded, batch }). When
 * omitted, the recorded split and batch embedded in the export are used.
 *
 * Checks (all must pass for exit 0):
 *   1. The split recomputed from the RAW SHARES equals the recorded
 *      per-miner payout amounts and the recorded fee, to the satoshi.
 *   2. When a payout batch is recorded: the batch amounts equal the
 *      expected payments under the pool's min-payout carry-over rule
 *      (carry-in + this block's credits; miners below minPayoutSat are
 *      carried over, not paid).
 *   3. When the batch carries a PSBT: the PSBT's actual outputs
 *      (parsed from the BIP174 unsigned transaction) equal the batch
 *      amounts -- i.e. the transaction the operator built really pays
 *      what the books say. An unparseable PSBT is a FAILURE, not a pass.
 *
 * Exit codes: 0 = verified, 1 = mismatch (readable diff on stdout),
 *             2 = usage / unreadable input.
 */

var fs = require('fs');
var path = require('path');
var verifySplit = require(path.join(__dirname, '..', 'lib', 'payouts', 'verifySplit'));

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.error('error: cannot read JSON from ' + file + ': ' + e.message);
        process.exit(2);
    }
}

function main(argv) {
    if (argv.length < 1 || argv.length > 2) {
        console.error('usage: node scripts/verify-payout.js <export.json> [recorded.json]');
        return 2;
    }
    var exp = readJson(argv[0]);
    var separate = argv.length === 2 ? readJson(argv[1]) : null;

    if (!exp || typeof exp !== 'object' || !exp.block || !Array.isArray(exp.shares)) {
        console.error('error: export must be an object with { block, shares[] } ' +
            '(see GET /api/blocks/<height>/ledger)');
        return 2;
    }
    var block = exp.block;

    // Recorded split + batch: separate file wins, then export fields.
    var recorded = (separate && separate.recorded) || exp.recorded ||
        (separate && separate.breakdown && separate.breakdown.recorded) ||
        (exp.breakdown && exp.breakdown.recorded) || null;
    var recordedAmounts = recorded && recorded.amounts ? recorded.amounts
        : (separate && separate.amounts) || (block.amounts && typeof block.amounts === 'object' ? block.amounts : null);
    var recordedFeeSat = recorded && typeof recorded.feeSat === 'number' ? recorded.feeSat
        : (separate && typeof separate.feeSat === 'number' ? separate.feeSat
            : (typeof block.feeSat === 'number' ? block.feeSat : null));
    var batch = (separate && separate.batch) || exp.batch || null;

    var feePercent = (typeof exp.feePercent === 'number') ? exp.feePercent
        : (block.reward > 0 && recordedFeeSat !== null ? recordedFeeSat * 100 / block.reward : 0);

    var split = verifySplit.computeSplit(exp.shares, block, {
        feePercent: feePercent,
        prevBlockTime: (typeof exp.prevBlockTime === 'number') ? exp.prevBlockTime : null,
        windowN: (typeof exp.windowN === 'number') ? exp.windowN : null
    });

    var failures = [];
    console.log('block ' + block.height + ' (' + block.algo + ', scheme ' + split.scheme + ')' +
        ' reward ' + block.reward + ' sat');
    console.log('window: ' + split.window.definition);
    console.log('  shares in window: ' + split.window.shareCount +
        ', total weight ' + split.totalWeight);
    console.log('recomputed: fee ' + split.feeSat + ' sat (' + feePercent + '%), distributable ' +
        split.distributableSat + ' sat to ' + Object.keys(split.amounts).length + ' miner(s)');

    // -- check 1: recomputed vs recorded split -------------------------
    if (!recordedAmounts) {
        failures.push('no recorded payout amounts found in the export/recorded file -- nothing to verify against');
    } else {
        var splitDiffs = verifySplit.diffAmountMaps('recomputed', split.amounts, 'recorded', recordedAmounts);
        splitDiffs.forEach(function (d) { failures.push('split mismatch: ' + d); });
        if (recordedFeeSat !== null && recordedFeeSat !== split.feeSat)
            failures.push('fee mismatch: recomputed=' + split.feeSat + ' sat vs recorded=' + recordedFeeSat + ' sat');
        if (splitDiffs.length === 0 && (recordedFeeSat === null || recordedFeeSat === split.feeSat))
            console.log('check 1 OK: recomputed split == recorded amounts + fee');
    }

    // -- check 2 + 3: batch amounts and PSBT outputs -------------------
    if (batch) {
        var batchAmounts = batch.amounts || {};
        if (typeof exp.minPayoutSat === 'number') {
            var expected = verifySplit.expectedBatchAmounts(
                [split.amounts], exp.carryIn || {}, exp.minPayoutSat);
            var batchDiffs = verifySplit.diffAmountMaps('expected (carry-over rule)', expected, 'batch', batchAmounts);
            batchDiffs.forEach(function (d) { failures.push('batch mismatch: ' + d); });
            if (batchDiffs.length === 0)
                console.log('check 2 OK: batch amounts == min-payout carry-over rule ' +
                    '(minPayout ' + exp.minPayoutSat + ' sat; below-threshold miners carried over)');
        } else {
            console.log('check 2 SKIPPED: export carries no minPayoutSat, so batch amounts ' +
                'cannot be re-derived (batch may aggregate several blocks)');
        }
        if (typeof batch.psbt === 'string' && batch.psbt.length > 0) {
            try {
                var psbtOutputs = verifySplit.parsePsbtOutputs(batch.psbt);
                var psbtDiffs = verifySplit.diffAmountMaps('batch amounts', batchAmounts, 'PSBT outputs', psbtOutputs);
                psbtDiffs.forEach(function (d) { failures.push('PSBT mismatch: ' + d); });
                if (psbtDiffs.length === 0)
                    console.log('check 3 OK: PSBT outputs == batch amounts');
            } catch (e) {
                failures.push('PSBT could not be verified: ' + e.message);
            }
        } else {
            console.log('check 3 SKIPPED: batch carries no PSBT');
        }
    } else {
        console.log('no payout batch recorded for this block yet (checks 2-3 skipped)');
    }

    if (failures.length > 0) {
        console.log('\nVERIFICATION FAILED (' + failures.length + '):');
        failures.forEach(function (f) { console.log('  - ' + f); });
        return 1;
    }
    console.log('\nVERIFIED: recorded payout matches an independent recompute from the raw shares.');
    return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main: main };
