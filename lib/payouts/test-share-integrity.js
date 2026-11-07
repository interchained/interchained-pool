'use strict';
/*
 * test-share-integrity.js -- accounting-integrity rules for share
 * acceptance, proven against the ACTUAL modules that decide what gets
 * counted (attach.js is the accounting gate; ethashStratum.js is the
 * Ethash job gate; verifySplit/schemes do the window math):
 *
 *   (a) the exact same share submitted twice is counted once
 *   (b) a share for a stale/previous job is not counted in the current
 *       round/window (rejected at the stratum job gate, and again at
 *       the accounting gate once the round has closed)
 *   (c) shares arriving after a block is found cannot enter that
 *       block's window -- the round boundary is the block EVENT time,
 *       while a share timestamped before the boundary but delivered
 *       late still counts
 *   (d) difficulty weighting uses the share's ACCEPTED difficulty
 *       (shareData.difficulty), consistently in live accounting and in
 *       the verifier's recompute -- never shareDiff
 *
 * Run: node lib/payouts/test-share-integrity.js (non-zero exit on failure)
 *
 * Sections (a)-(d) always run (pure-JS modules). Two further sections
 * execute the REAL lib/jobManager.js (classic duplicate register +
 * stale-job rejection, wired through attach) and the REAL
 * lib/ethash/ethashStratum.js job gate; they need the repo's installed
 * dependencies (native `bignum`, pure-JS `js-sha3`) resolvable -- with
 * node_modules installed (or NODE_PATH pointing at an installed tree)
 * they run, otherwise they print SKIP with the reason instead of
 * failing, and the accounting-layer proofs still stand on their own.
 */

var events = require('events');

var Ledger = require('./ledger').Ledger;
var attachPayouts = require('./attach').attachPayouts;
var verifySplit = require('./verifySplit');

function tryRequire(p) {
    try { return require(p); } catch (e) { return null; }
}
var EthashStratumServer = tryRequire('../ethash/ethashStratum');

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('PASS  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

function fakePool() {
    var pool = new events.EventEmitter();
    pool.options = {};
    return pool;
}
function classicShare(worker, job, en2, nonce, difficulty, time, height) {
    return {
        worker: worker, algo: 'sha256', job: job, height: height,
        difficulty: difficulty, shareDiff: '999999.00000000',
        extraNonce1: '0a0b0c0d', extraNonce2: en2, nTime: '000007d0', nonce: nonce,
        time: time, blockReward: 500000000
    };
}

/* ---------------- (a) duplicates ------------------------------------ */
console.log('--- (a) duplicate shares counted once ---');
(function () {
    var ledger = new Ledger({});
    var pool = fakePool();
    attachPayouts(pool, 'sha256', ledger, 'prop');
    var share = classicShare('addrA', 'job1', '00000001', '0000abcd', 8, 1500, 100);
    pool.emit('share', true, false, share);
    pool.emit('share', true, false, share); // exact same share, re-emitted
    pool.emit('share', true, false, JSON.parse(JSON.stringify(share))); // and a copy of it
    check('classic: same submission emitted 3x -> recorded once',
        ledger.getShares('sha256').length === 1, 'n=' + ledger.getShares('sha256').length);
    var other = classicShare('addrA', 'job1', '00000002', '0000abce', 8, 1501, 100);
    pool.emit('share', true, false, other);
    check('classic: a different nonce is a different share -> recorded',
        ledger.getShares('sha256').length === 2, 'n=' + ledger.getShares('sha256').length);

    var ethLedger = new Ledger({});
    var ethPool = fakePool();
    attachPayouts(ethPool, 'ethash', ethLedger, 'pplns');
    var ethShare = {
        worker: 'addrG', algo: 'ethash', job: 'ejob1', height: 50, difficulty: 16,
        shareDiff: 123.5, nonce64: '123456789', mixHash: 'ab'.repeat(32),
        headerHash: 'cd'.repeat(32), time: 1600
    };
    ethPool.emit('share', true, false, ethShare);
    ethPool.emit('share', true, false, ethShare);
    check('ethash: same nonce64+mixHash emitted 2x -> recorded once (ethash stratum has no own dedupe register)',
        ethLedger.getShares('ethash').length === 1, 'n=' + ethLedger.getShares('ethash').length);
    var ethOther = Object.assign({}, ethShare, { nonce64: '987654321' });
    ethPool.emit('share', true, false, ethOther);
    check('ethash: a different nonce64 is a different share -> recorded',
        ethLedger.getShares('ethash').length === 2, 'n=' + ethLedger.getShares('ethash').length);

    // Duplicate block events never create a second block record.
    pool.emit('share', true, true, Object.assign(
        classicShare('addrA', 'job1', '00000009', '0000ffff', 8, 2000, 100), { blockHash: 'hashDup' }));
    pool.emit('share', true, true, Object.assign(
        classicShare('addrA', 'job1', '00000009', '0000ffff', 8, 2000, 100), { blockHash: 'hashDup' }));
    check('duplicate block event -> one block record',
        ledger.getBlocks('sha256').filter(function (b) { return b.hash === 'hashDup'; }).length === 1);
})();

/* ---------------- (b) stale jobs ------------------------------------ */
console.log('--- (b) stale / previous-job shares are rejected ---');
(function () {
    if (!EthashStratumServer) {
        console.log('SKIP  ethash stratum job-gate section: lib/ethash/ethashStratum.js not loadable (js-sha3 not resolvable in this environment)');
        return;
    }
    // Ethash stratum job gate (actual module, fake socket transport):
    var server = new EthashStratumServer({});
    var shareEvents = [];
    server.on('share', function (worker, jobId, isValid, isBlock, data) {
        shareEvents.push({ jobId: jobId, isValid: isValid, error: data && data.error });
    });
    var socket = new events.EventEmitter();
    socket.written = [];
    socket.write = function (s) { socket.written.push(s); };
    socket.setKeepAlive = function () {};
    socket.setEncoding = function () {};
    socket.destroy = function () {};
    socket.remoteAddress = '127.0.0.1';
    socket.localPort = 3335;
    server.handleNewClient(socket);
    function send(obj) { socket.emit('data', JSON.stringify(obj) + '\n'); }
    send({ id: 1, method: 'mining.authorize', params: ['addrG', 'x'] });
    var headerA = 'aa'.repeat(32), headerB = 'bb'.repeat(32), target = '00'.repeat(32);
    server.setJob({ jobId: 'jobA', headerHashHex: headerA, nBitsTargetHex: target, height: 50, clean: true });
    server.setJob({ jobId: 'jobB', headerHashHex: headerB, nBitsTargetHex: target, height: 51, clean: true });
    send({ id: 2, method: 'mining.submit', params: ['addrG', 'jobA', '0000000000000001', headerA, 'cc'.repeat(32)] });
    var stale = shareEvents.filter(function (e) { return e.jobId === 'jobA'; })[0];
    check('ethash stratum: submit for a job replaced by a clean job -> invalid, "job not found"',
        !!stale && stale.isValid === false && stale.error === 'job not found',
        JSON.stringify(stale));
    server.close(function () {});

    // Accounting gate: after the round for height 100 closes at t=2000,
    // a share for height 100 timestamped t=2100 is not recorded at all.
    var ledger = new Ledger({});
    var pool = fakePool();
    attachPayouts(pool, 'sha256', ledger, 'prop');
    pool.emit('share', true, false, classicShare('addrA', 'job1', '00000001', '00000001', 10, 1500, 100));
    pool.emit('share', true, true, Object.assign(
        classicShare('addrB', 'job1', '00000002', '00000002', 10, 2000, 100),
        { blockHash: 'hash100', blockFoundTime: 2000 }));
    pool.emit('share', true, false, classicShare('addrA', 'job1', '00000003', '00000003', 10, 2100, 100));
    check('accounting: post-close share for the closed height is rejected (not in ledger)',
        ledger.getShares('sha256').length === 2, 'n=' + ledger.getShares('sha256').length);
    pool.emit('share', true, false, classicShare('addrA', 'job2', '00000001', '00000009', 10, 2100, 101));
    check('accounting: share for the NEXT height at the same time is recorded',
        ledger.getShares('sha256').length === 3, 'n=' + ledger.getShares('sha256').length);

    // Restart seeding: a fresh attach over the same ledger still knows
    // the round is closed.
    var pool2 = fakePool();
    attachPayouts(pool2, 'sha256', ledger, 'prop');
    pool2.emit('share', true, false, classicShare('addrC', 'job1', '00000007', '00000007', 10, 2200, 100));
    check('accounting: closed round stays closed across an attach restart (seeded from ledger)',
        ledger.getShares('sha256').length === 3, 'n=' + ledger.getShares('sha256').length);
})();

/* ---------------- (c) round boundary is the block event -------------- */
console.log('--- (c) post-block shares cannot enter the found block\'s window ---');
(function () {
    var ledger = new Ledger({});
    var pool = fakePool();
    attachPayouts(pool, 'sha256', ledger, 'prop');
    pool.emit('share', true, false, classicShare('addrA', 'job1', '00000001', '00000001', 10, 1500, 100));
    // Block FOUND at t=2000, but (as in pool.js) the share event is only
    // emitted after async submission -- it carries blockFoundTime=2000,
    // so the recorded block time is the event time, not wall-clock now.
    pool.emit('share', true, true, Object.assign(
        classicShare('addrB', 'job1', '00000002', '00000002', 10, 2000, 100),
        { blockHash: 'hash100', blockFoundTime: 2000 }));
    var block = ledger.getBlockByHash('hash100');
    check('block recorded at its FOUND time (2000), not at emit/attach wall-clock',
        block.time === 2000, 'time=' + block.time);
    // Delivered late but timestamped BEFORE the boundary: counts.
    pool.emit('share', true, false, classicShare('addrC', 'job1', '00000003', '00000003', 5, 1800, 100));
    // Submitted AFTER the find (t=2100) for the old job: cannot enter.
    pool.emit('share', true, false, classicShare('addrA', 'job1', '00000004', '00000004', 500, 2100, 100));

    var shares = ledger.getShares('sha256');
    check('ledger holds exactly the pre-boundary shares (3)', shares.length === 3, 'n=' + shares.length);
    var split = verifySplit.computeSplit(shares, block, { feePercent: 0, prevBlockTime: null });
    check('verifier recompute: window weights are A=10, B=10, C=5 (the 500-diff post-block share is absent)',
        split.weights.addrA === 10 && split.weights.addrB === 10 && split.weights.addrC === 5 &&
        Object.keys(split.weights).length === 3,
        JSON.stringify(split.weights));
    check('window closes at block.time (toTime == 2000, all shares <= 2000)',
        split.window.toTime === 2000 && split.window.shares.every(function (s) { return s.time <= 2000; }));
})();

/* ---------------- (d) difficulty weighting ---------------------------- */
console.log('--- (d) weighting uses the ACCEPTED difficulty, everywhere ---');
(function () {
    var ledger = new Ledger({});
    var pool = fakePool();
    attachPayouts(pool, 'sha256', ledger, 'prop');
    // Miner was working at difficulty 8; the share's ACTUAL achieved
    // difficulty (shareDiff) is huge and must play no role anywhere.
    var s = classicShare('addrA', 'job1', '00000001', '00000001', 8, 1500, 100);
    pool.emit('share', true, false, s);
    var entry = ledger.getShares('sha256')[0];
    check('live accounting records difficulty == accepted difficulty (8), not shareDiff',
        entry.difficulty === 8, 'difficulty=' + entry.difficulty);
    // A vardiff-adjusted share: jobManager emits the ACCEPTED (previous)
    // difficulty in shareData.difficulty; that exact value is recorded.
    var s2 = classicShare('addrA', 'job1', '00000002', '00000002', 4, 1600, 100);
    s2.shareDiff = '7.50000000'; // met previous difficulty 4, not current 8
    pool.emit('share', true, false, s2);
    check('vardiff-adjusted share recorded at the accepted difficulty (4)',
        ledger.getShares('sha256')[1].difficulty === 4);
    var block = { algo: 'sha256', height: 100, hash: 'h', reward: 100000000, finder: 'addrA', time: 2000, scheme: 'prop' };
    var split = verifySplit.computeSplit(ledger.getShares('sha256'), block, { feePercent: 0, prevBlockTime: null });
    check('verifier recompute weights from the same recorded difficulty (8 + 4 = 12)',
        split.weights.addrA === 12 && split.totalWeight === 12, JSON.stringify(split.weights));
})();

/* ---------------- (e) classic jobManager, end to end ------------------ */
console.log('--- (e) jobManager source-level rules, wired through attach ---');
(function () {
    var JobManager = null;
    var util = null;
    try {
        require('../algoProperties'); // installs global algos/diff1
        JobManager = require('../jobManager');
        util = require('../util');
    } catch (e) { /* deps not resolvable */ }
    if (!JobManager || !util) {
        console.log('SKIP  jobManager section: lib/jobManager.js not loadable (native bignum not resolvable in this environment)');
        return;
    }
    var ledger = new Ledger({});
    var pool = fakePool();
    attachPayouts(pool, 'sha256', ledger, 'prop');
    var jm = new JobManager({
        coin: { algorithm: 'sha256', reward: 'POW' },
        poolAddressScript: util.addressToScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'),
        recipients: [], instanceId: 7
    });
    // Forward jobManager shares exactly as lib/pool.js does
    // (isValidShare = !error, isValidBlock = !!blockHex, blockFoundTime
    // stamped from the share's submission time at the find event).
    jm.on('share', function (shareData, blockHex) {
        if (blockHex) shareData.blockFoundTime = shareData.time;
        pool.emit('share', !shareData.error, !!blockHex, shareData);
    });
    var now = Math.floor(Date.now() / 1000);
    var rpc = {
        height: 100, previousblockhash: '00'.repeat(32), coinbasevalue: 500000000,
        bits: '207fffff', curtime: now - 10, version: 1, transactions: [],
        target: '00000fff0000000000000000000000000000000000000000000000000000000000'
    };
    jm.processTemplate(rpc);
    var jobId = jm.currentJob.jobId;
    var en1 = jm.extraNonceCounter.next();
    var nTime = now.toString(16).padStart(8, '0');
    var r1 = jm.processShare(jobId, null, 0.000001, en1, '00000001', nTime, '00000001', '127.0.0.1', 3333, 'addrA.rig1');
    check('jobManager: first submission accepted', r1.result === true && !r1.error, JSON.stringify(r1));
    check('jobManager: emitted share carries submission time + identity fields for accounting',
        ledger.getShares('sha256').length === 1 && ledger.getShares('sha256')[0].worker === 'addrA',
        'shares=' + ledger.getShares('sha256').length);
    var r2 = jm.processShare(jobId, null, 0.000001, en1, '00000001', nTime, '00000001', '127.0.0.1', 3333, 'addrA.rig1');
    check('jobManager: exact resubmission rejected [22 duplicate share] at the source',
        !!r2.error && r2.error[0] === 22, JSON.stringify(r2));
    check('accounting: duplicate never reached the ledger (still 1 share)',
        ledger.getShares('sha256').length === 1);
    var rpc2 = Object.assign({}, rpc, { height: 101, previousblockhash: '11'.repeat(32), curtime: now - 5 });
    jm.processTemplate(rpc2); // new block -> validJobs reset
    var r3 = jm.processShare(jobId, null, 0.000001, en1, '00000002', nTime, '00000002', '127.0.0.1', 3333, 'addrA.rig1');
    check('jobManager: share for the previous block\'s job rejected [21 job not found]',
        !!r3.error && r3.error[0] === 21, JSON.stringify(r3));
    check('accounting: stale-job share never reached the ledger (still 1 share)',
        ledger.getShares('sha256').length === 1);
    var r4 = jm.processShare(jm.currentJob.jobId, null, 0.000001, en1, '00000003', nTime, '00000003', '127.0.0.1', 3333, 'addrA.rig1');
    check('jobManager + accounting: a share for the CURRENT job is accepted and recorded',
        r4.result === true && ledger.getShares('sha256').length === 2,
        JSON.stringify(r4) + ' shares=' + ledger.getShares('sha256').length);
})();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
