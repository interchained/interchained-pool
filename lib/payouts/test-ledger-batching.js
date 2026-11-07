'use strict';
/*
 * test-ledger-batching.js -- verification for the phase-3 share batching
 * in lib/payouts/ledger.js. Run: node lib/payouts/test-ledger-batching.js
 *
 * Contract under test (see ledger.js header):
 *  - shares persist with bounded write-behind batching: leading-edge
 *    save when the flush window has elapsed, trailing timer flush at
 *    the window end, cap flush at batchMaxShares pending;
 *  - a hard kill between flushes loses AT MOST batchMaxShares-1 shares
 *    (and only shares from the current window);
 *  - blocks and payout batches are NEVER batched: they are on disk
 *    synchronously when recordBlock/recordPayout return, and they
 *    flush any pending shares with them;
 *  - flush()/close() drain pending shares (clean shutdown path);
 *  - the on-disk format is unchanged (a default Ledger reads it back).
 *
 * "Kill-sim" = abandon the writer instance WITHOUT flush()/close() and
 * read the file fresh (direct parse + a new Ledger), exactly what a
 * restart after kill -9 would see.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var Ledger = require('./ledger').Ledger;

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('PASS  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function readRaw(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function shareTimesOnDisk(file, algo) {
    return readRaw(file).shares.filter(function (s) { return s.algo === algo; })
        .map(function (s) { return s.time; });
}

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-ledger-batch-'));
var file = path.join(dir, 'ledger.json');
var MAX = 5, WINDOW = 60000; // long window: only cap/leading flushes fire here

/* --- 1. bounded batching + kill-sim loss bound -------------------- */
var l1 = new Ledger({ dataFile: file, batchMaxShares: MAX, batchFlushMs: WINDOW });
for (var i = 0; i < 12; i++)
    l1.recordShare({ algo: 'sha256', worker: 'addrA', difficulty: 1, time: 1000 + i, height: 100 });

check('in-memory ledger sees all 12 shares', l1.getShares('sha256').length === 12);
// Deterministic flush points: share #1 leading-edge (no prior save),
// #6 and #11 at the pending cap of 5 -> 11 shares durable, #12 pending.
var diskTimes = shareTimesOnDisk(file, 'sha256');
check('kill-sim: exactly the 11 flushed shares are on disk', diskTimes.length === 11,
    'onDisk=' + diskTimes.length);
check('kill-sim: on-disk shares are the flushed prefix (times 1000..1010)',
    JSON.stringify(diskTimes) === JSON.stringify(
        [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010]),
    JSON.stringify(diskTimes));
var lost = 12 - diskTimes.length;
check('kill-sim: loss bound holds (lost ' + lost + ' <= batchMaxShares-1 = ' + (MAX - 1) + ')',
    lost <= MAX - 1 && lost >= 0);

var l2 = new Ledger({ dataFile: file }); // restart view, default options
check('kill-sim: fresh Ledger reloads the flushed shares', l2.getShares('sha256').length === 11);
check('on-disk shape unchanged (keys + version)',
    JSON.stringify(Object.keys(readRaw(file)).sort()) ===
    JSON.stringify(['balances', 'blocks', 'payouts', 'shares', 'version']) && readRaw(file).version === 1);
l2.close();

/* --- 2. money events flush synchronously -------------------------- */
l1.recordBlock({ algo: 'sha256', height: 100, hash: 'hashBatch', reward: 500000000, finder: 'addrA', time: 2000, scheme: 'prop' });
var raw2 = readRaw(file); // no flush() called: the block write itself must have landed
check('block event flushes pending share too (12 shares on disk)',
    raw2.shares.filter(function (s) { return s.algo === 'sha256'; }).length === 12);
check('block present on disk immediately after recordBlock',
    raw2.blocks.length === 1 && raw2.blocks[0].hash === 'hashBatch');

l1.recordShare({ algo: 'sha256', worker: 'addrA', difficulty: 1, time: 1012, height: 101 }); // pending again
l1.recordPayout({ id: 'batch1', algo: 'sha256', time: 2100, dryRun: true, txid: null, amounts: { addrA: 1000 }, blocks: [100], fee: 10 });
var raw3 = readRaw(file);
check('payout batch present on disk immediately after recordPayout',
    raw3.payouts.length === 1 && raw3.payouts[0].id === 'batch1');
check('payout event also flushed the pending share (13 shares)',
    raw3.shares.filter(function (s) { return s.algo === 'sha256'; }).length === 13);

var l3 = new Ledger({ dataFile: file });
check('kill-sim after money events: block + payout + all shares survive',
    l3.getBlocks('sha256').length === 1 && l3.getPayouts().length === 1 && l3.getShares('sha256').length === 13);
l3.close();
l1.close();
check('close() leaves nothing pending', l1._pendingShares === 0 && l1._exitHook === null);

/* --- 3. trailing interval flush ----------------------------------- */
var file2 = path.join(dir, 'ledger2.json');
var li = new Ledger({ dataFile: file2, batchMaxShares: 1000, batchFlushMs: 60 });
li.recordShare({ algo: 'ethash', worker: 'addrB', difficulty: 2, time: 1, height: 1 }); // leading-edge
li.recordShare({ algo: 'ethash', worker: 'addrB', difficulty: 2, time: 2, height: 1 }); // pending
li.recordShare({ algo: 'ethash', worker: 'addrB', difficulty: 2, time: 3, height: 1 }); // pending
check('interval: only the leading-edge share is durable immediately',
    shareTimesOnDisk(file2, 'ethash').length === 1);

setTimeout(function () {
    check('interval: trailing timer flushed the pending shares',
        shareTimesOnDisk(file2, 'ethash').length === 3,
        'onDisk=' + shareTimesOnDisk(file2, 'ethash').length);
    li.close();

    /* --- 4. flush() drains on demand ------------------------------ */
    var file3 = path.join(dir, 'ledger3.json');
    var lf = new Ledger({ dataFile: file3, batchMaxShares: 1000, batchFlushMs: 60000 });
    lf.recordShare({ algo: 'yespower', worker: 'addrC', difficulty: 1, time: 1, height: 1 });
    lf.recordShare({ algo: 'yespower', worker: 'addrC', difficulty: 1, time: 2, height: 1 });
    lf.recordShare({ algo: 'yespower', worker: 'addrC', difficulty: 1, time: 3, height: 1 });
    check('flush(): shares pending before flush', shareTimesOnDisk(file3, 'yespower').length === 1);
    lf.flush();
    check('flush(): all shares durable after flush', shareTimesOnDisk(file3, 'yespower').length === 3);
    lf.close();

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL BATCHING CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
}, 250);
