'use strict';
/*
 * test-payouts.js -- self-contained verification for lib/payouts/.
 * Run: node lib/payouts/test-payouts.js   (exit code non-zero on failure)
 *
 * Uses a FAKE daemon implementing the lib/daemon.js cmd() contract:
 * callback receives [{ error, response, instance }]. No real daemon,
 * no native deps.
 *
 * Hand-computed expectations
 * --------------------------
 * sha256 PROP block: reward 500,000,000 sat, fee 2% -> fee 10,000,000,
 * distributable 490,000,000. Round = (prev block t=1000, block t=2000].
 * In-round weights: A=10, B=40, C=10 (total 60).
 *   A floor(490M*10/60)=81,666,666   B floor(490M*40/60)=326,666,666
 *   C floor(490M*10/60)=81,666,666   sum=489,999,998, remainder 2 -> B
 *   (largest weight) => B=326,666,668. Sum = 490,000,000 exactly.
 * yespower PPLNS block (window 3): reward 200,000,000, fee 2% -> 4,000,000,
 * distributable 196,000,000. Last 3 shares weights: B=10, A=20, C=30.
 *   B=32,666,666  A=65,333,333  C=98,000,000  sum=195,999,999,
 *   remainder 1 -> C (largest) => C=98,000,001. Sum = 196,000,000 exactly.
 * minPayout = 0.5 coins = 50,000,000 sat: yespower B (32,666,666) is
 * below threshold -> NOT paid, keeps its pending balance.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var events = require('events');

var Ledger = require('./ledger').Ledger;
var schemes = require('./schemes');
var createPaymentsProcessor = require('./payments').createPaymentsProcessor;
var attachPayouts = require('./attach').attachPayouts;

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('PASS  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sum(obj) { return Object.keys(obj || {}).reduce(function (s, k) { return s + obj[k]; }, 0); }

/* ---------------- fake daemon ----------------
 * Emulates the daemon's PSBT wallet RPCs. `failOnceAt` names a method
 * whose FIRST call returns a transient error (for the resume scenario).
 * sendmany is recorded too -- the processor must never call it. */
function FakeDaemon() {
    this.blockInfo = {};   // hash -> confirmations
    this.blockErrors = {}; // hash -> error object
    this.calls = { getblock: [], walletcreatefundedpsbt: [], walletprocesspsbt: [], finalizepsbt: [], sendrawtransaction: [], sendmany: [] };
    this.failOnceAt = null;
    this._failedOnce = false;
    this._psbtSeq = 0;
}
FakeDaemon.prototype.cmd = function (method, params, callback) {
    var self = this;
    process.nextTick(function () {
        function ok(response) { return callback([{ error: null, response: response, instance: { index: 0 } }]); }
        function err(e) { return callback([{ error: e, response: undefined, instance: { index: 0 } }]); }
        if (method !== 'getblock' && self.failOnceAt === method && !self._failedOnce) {
            self._failedOnce = true;
            if (self.calls[method]) self.calls[method].push(params);
            return err({ code: -1, message: 'injected transient failure at ' + method });
        }
        if (method === 'getblock') {
            self.calls.getblock.push(params);
            var hash = params[0];
            if (self.blockErrors[hash])
                return err(self.blockErrors[hash]);
            if (typeof self.blockInfo[hash] === 'number')
                return ok({ hash: hash, confirmations: self.blockInfo[hash], tx: ['coinbase'] });
            return err({ code: -5, message: 'Block not found' });
        }
        if (method === 'walletcreatefundedpsbt') {
            self.calls.walletcreatefundedpsbt.push(params);
            self._psbtSeq++;
            var psbt = Buffer.from('psbt-' + self._psbtSeq + ':' + JSON.stringify(params[1] || {})).toString('base64');
            return ok({ psbt: psbt, fee: 0.0001, changepos: -1 });
        }
        if (method === 'walletprocesspsbt') {
            self.calls.walletprocesspsbt.push(params);
            return ok({ psbt: params[0] + '|signed', complete: true });
        }
        if (method === 'finalizepsbt') {
            self.calls.finalizepsbt.push(params);
            return ok({ hex: 'deadbeef' + params[0].length, complete: true });
        }
        if (method === 'sendrawtransaction') {
            self.calls.sendrawtransaction.push(params);
            return ok('faketxid123');
        }
        if (method === 'sendmany') {
            self.calls.sendmany.push(params);
            return ok('faketxid123');
        }
        err({ code: -32601, message: 'Method not found' });
    });
};

function makeLogger() {
    var lines = [];
    var fn = function (severity, message) { lines.push(severity + ': ' + message); };
    fn.lines = lines;
    return fn;
}

function baseConfig(dryRun) {
    var c = {
        enabled: true,
        feePercent: 2,
        minPayout: 0.5,       // coins
        confirmations: 5,
        intervalSeconds: 3600,
        schemes: {
            sha256: { scheme: 'prop' },
            yespower: { scheme: 'pplns', pplnsWindow: 3 },
            ethash: { scheme: 'solo' }
        }
    };
    if (typeof dryRun !== 'undefined') c.dryRun = dryRun;
    return c;
}

/* Feed the standard scenario into a ledger. */
function feed(ledger) {
    // Previous sha256 block at t=1000 (orphaned afterwards) opens the PROP round.
    ledger.recordBlock({ algo: 'sha256', height: 99, hash: 'hashPrev', reward: 500000000, finder: 'addrA', time: 1000, scheme: 'prop' });
    ledger.updateBlockStatus('hashPrev', 'orphaned', 0);

    // sha256 shares
    ledger.recordShare({ algo: 'sha256', worker: 'addrA', difficulty: 10, time: 900, height: 100 });   // before round: excluded
    ledger.recordShare({ algo: 'sha256', worker: 'addrA.rig1', difficulty: 10, time: 1500, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrB', difficulty: 30, time: 1600, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrC', difficulty: 10, time: 1700, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrB', difficulty: 10, time: 2000, height: 100 });   // at block time: included
    ledger.recordShare({ algo: 'sha256', worker: 'addrA', difficulty: 100, time: 2100, height: 101 });  // after block: excluded
    ledger.recordBlock({ algo: 'sha256', height: 100, hash: 'hashProp', reward: 500000000, finder: 'addrB.rig9', time: 2000, scheme: 'prop' });

    // yespower shares
    ledger.recordShare({ algo: 'yespower', worker: 'addrA', difficulty: 100, time: 1000, height: 50 }); // outside PPLNS window of 3
    ledger.recordShare({ algo: 'yespower', worker: 'addrB', difficulty: 10, time: 1100, height: 50 });
    ledger.recordShare({ algo: 'yespower', worker: 'addrA', difficulty: 20, time: 1200, height: 50 });
    ledger.recordShare({ algo: 'yespower', worker: 'addrC', difficulty: 30, time: 1300, height: 50 });
    ledger.recordBlock({ algo: 'yespower', height: 50, hash: 'hashPplns', reward: 200000000, finder: 'addrC', time: 1400, scheme: 'pplns' });
}

var EXPECTED_SHA_AMOUNTS = { addrA: 81666666, addrB: 326666668, addrC: 81666666 };
var EXPECTED_YES_CREDITED = { addrB: 32666666, addrA: 65333333, addrC: 98000001 };
var EXPECTED_YES_PAID = { addrA: 65333333, addrC: 98000001 }; // B below min payout

function scenarioUnits() {
    console.log('--- unit: schemes + ledger shape ---');
    var w = schemes.splitReward(100000001, { x: 1, y: 1 }, 0, null);
    check('splitReward remainder to lexicographically-first on tie', eq(w.amounts, { x: 50000001, y: 50000000 }), JSON.stringify(w));
    var w2 = schemes.splitReward(100000001, { x: 1, y: 1 }, 0, 'y');
    check('splitReward remainder to finder on tie', eq(w2.amounts, { x: 50000000, y: 50000001 }), JSON.stringify(w2));
    var w3 = schemes.splitReward(500000000, { a: 60 }, 2);
    check('splitReward fee deducted first', w3.feeSat === 10000000 && w3.amounts.a === 490000000);
    check('splitReward empty weights -> zero amounts and zero fee', eq(schemes.splitReward(1000, {}, 5), { amounts: {}, feeSat: 0 }));

    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-payouts-'));
    var file = path.join(dir, 'ledger.json');
    var l1 = new Ledger({ dataFile: file });
    l1.recordShare({ algo: 'sha256', worker: 'addrZ.rig7', difficulty: 4, time: 1, height: 1 });
    var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('persisted shape keys', eq(Object.keys(raw).sort(), ['balances', 'blocks', 'payouts', 'shares', 'version']) && raw.version === 1);
    check('worker suffix stripped, workerName kept', raw.shares[0].worker === 'addrZ' && raw.shares[0].workerName === 'rig7');
    var l2 = new Ledger({ dataFile: file });
    check('ledger reloads from disk', l2.getShares('sha256').length === 1);
    fs.rmSync(dir, { recursive: true, force: true });
}

function scenarioDryRun(done) {
    console.log('--- scenario 1: dry-run (dryRun omitted -> defaults to TRUE) ---');
    var ledger = new Ledger({}); // in-memory
    feed(ledger);
    var daemon = new FakeDaemon();
    daemon.blockInfo = { hashProp: 10, hashPplns: 10 };
    var logger = makeLogger();
    var proc = createPaymentsProcessor({ daemon: daemon, ledger: ledger, config: baseConfig(undefined), logger: logger });
    proc.runOnce(function (err, summary) {
        check('dry-run runOnce no error', !err, err && err.message);
        var shaBlock = ledger.getBlockByHash('hashProp');
        var yesBlock = ledger.getBlockByHash('hashPplns');
        check('prop block confirmed then paid', shaBlock.status === 'paid' && shaBlock.confirmations === 10, shaBlock.status);
        check('prop split exact', eq(shaBlock.amounts, EXPECTED_SHA_AMOUNTS), JSON.stringify(shaBlock.amounts));
        check('prop split sums to reward-fee exactly', sum(shaBlock.amounts) + shaBlock.feeSat === 500000000);
        check('prop fee correct', shaBlock.feeSat === 10000000);
        check('pplns split exact (window applied)', eq(yesBlock.amounts, EXPECTED_YES_CREDITED), JSON.stringify(yesBlock.amounts));
        check('pplns split sums to reward-fee exactly', sum(yesBlock.amounts) + yesBlock.feeSat === 200000000);
        check('finder stripped to address', shaBlock.finder === 'addrB');

        check('DRY-RUN: PSBT built for both paying algos', daemon.calls.walletcreatefundedpsbt.length === 2, 'calls=' + daemon.calls.walletcreatefundedpsbt.length);
        check('DRY-RUN: signing stages NEVER called (process/finalize/broadcast)',
            daemon.calls.walletprocesspsbt.length === 0 && daemon.calls.finalizepsbt.length === 0 && daemon.calls.sendrawtransaction.length === 0,
            'process=' + daemon.calls.walletprocesspsbt.length + ' finalize=' + daemon.calls.finalizepsbt.length + ' send=' + daemon.calls.sendrawtransaction.length);
        check('DRY-RUN: sendmany never used anywhere', daemon.calls.sendmany.length === 0);
        var psbtCall = daemon.calls.walletcreatefundedpsbt[0];
        check('PSBT call shape: [[], outputs] with exact 8-decimal amounts',
            Array.isArray(psbtCall[0]) && psbtCall[0].length === 0 &&
            eq(psbtCall[1], { addrA: '0.81666666', addrB: '3.26666668', addrC: '0.81666666' }),
            JSON.stringify(psbtCall));
        var payouts = ledger.getPayouts();
        check('dry-run recorded 2 payouts', payouts.length === 2, 'n=' + payouts.length);
        check('dry-run payouts have txid null and dryRun true', payouts.every(function (p) { return p.txid === null && p.dryRun === true; }));
        check('dry-run payouts carry the recorded PSBT at stage created', payouts.every(function (p) { return typeof p.psbt === 'string' && p.psbt.length > 0 && p.stage === 'created'; }),
            JSON.stringify(payouts.map(function (p) { return { stage: p.stage, psbt: typeof p.psbt }; })));
        var shaPayout = payouts.filter(function (p) { return p.algo === 'sha256'; })[0];
        var yesPayout = payouts.filter(function (p) { return p.algo === 'yespower'; })[0];
        check('dry-run sha payout amounts exact', eq(shaPayout.amounts, EXPECTED_SHA_AMOUNTS), JSON.stringify(shaPayout.amounts));
        check('dry-run sha payout fee + blocks', shaPayout.fee === 10000000 && eq(shaPayout.blocks, [100]));
        check('min-payout carry-over: yespower B NOT paid', eq(yesPayout.amounts, EXPECTED_YES_PAID), JSON.stringify(yesPayout.amounts));
        var balances = ledger.getBalances();
        check('min-payout carry-over: B keeps pending 32666666', balances.yespower.addrB.pending === 32666666 && balances.yespower.addrB.paid === 0, JSON.stringify(balances.yespower.addrB));
        check('dry-run moved paid amounts pending->paid (documented semantics)', balances.sha256.addrB.paid === 326666668 && balances.sha256.addrB.pending === 0);
        check('dry-run logged PSBT-not-signed', logger.lines.some(function (l) { return l.indexOf('NOT signed, NOT broadcast') !== -1; }));
        check('summary counts', summary.blocksConfirmed === 2 && summary.payouts.length === 2, JSON.stringify(summary));
        done();
    });
}

function scenarioLive(done) {
    console.log('--- scenario 2: live PSBT stages + orphan rules + empty split ---');
    var ledger = new Ledger({});
    feed(ledger);
    var daemon = new FakeDaemon();
    daemon.blockInfo = { hashProp: 10, hashPplns: 10, hashEmpty: 10 };
    var proc = createPaymentsProcessor({ daemon: daemon, ledger: ledger, config: baseConfig(false), logger: makeLogger() });
    proc.runOnce(function (err) {
        check('live runOnce no error', !err, err && err.message);
        check('live: PSBT stage chain called exactly twice per stage (once per paying algo)',
            daemon.calls.walletcreatefundedpsbt.length === 2 && daemon.calls.walletprocesspsbt.length === 2 &&
            daemon.calls.finalizepsbt.length === 2 && daemon.calls.sendrawtransaction.length === 2,
            JSON.stringify({ create: daemon.calls.walletcreatefundedpsbt.length, process: daemon.calls.walletprocesspsbt.length, finalize: daemon.calls.finalizepsbt.length, send: daemon.calls.sendrawtransaction.length }));
        check('live: sendmany never used', daemon.calls.sendmany.length === 0);
        var shaPsbt = daemon.calls.walletcreatefundedpsbt[0];
        var yesPsbt = daemon.calls.walletcreatefundedpsbt[1];
        check('PSBT sha outputs exact, 8 decimals', eq(shaPsbt[1], { addrA: '0.81666666', addrB: '3.26666668', addrC: '0.81666666' }), JSON.stringify(shaPsbt[1]));
        check('PSBT yespower outputs exact (B below threshold excluded)', eq(yesPsbt[1], { addrA: '0.65333333', addrC: '0.98000001' }), JSON.stringify(yesPsbt[1]));
        var payouts = ledger.getPayouts();
        check('live payouts sent: txid recorded, stage sent, hex kept, dryRun false',
            payouts.length === 2 && payouts.every(function (p) { return p.txid === 'faketxid123' && p.dryRun === false && p.stage === 'sent' && typeof p.hex === 'string' && typeof p.psbt === 'string'; }),
            JSON.stringify(payouts.map(function (p) { return { stage: p.stage, txid: p.txid }; })));

        // Second run: orphan (definitive -5), transient error (stays
        // pending), and a confirmed block with no shares (empty split).
        ledger.recordBlock({ algo: 'sha256', height: 101, hash: 'hashGone', reward: 500000000, finder: 'addrA', time: 3000, scheme: 'prop' });
        ledger.recordBlock({ algo: 'sha256', height: 102, hash: 'hashFlaky', reward: 500000000, finder: 'addrA', time: 3100, scheme: 'prop' });
        ledger.recordBlock({ algo: 'ethash', height: 7, hash: 'hashEmpty', reward: 100000000, finder: 'addrA', time: 3200, scheme: 'pplns' });
        daemon.blockErrors['hashFlaky'] = { code: -1, message: 'daemon busy' };
        // hashGone: no blockInfo and no scripted error -> fake answers -5.
        // hashEmpty is 'pplns' on an otherwise-solo algo to prove the empty
        // split path; override its stored scheme is what the processor reads.
        proc.runOnce(function (err2) {
            check('second runOnce no error', !err2, err2 && err2.message);
            check('definitive not-found -> orphaned', ledger.getBlockByHash('hashGone').status === 'orphaned');
            check('transient daemon error -> stays pending', ledger.getBlockByHash('hashFlaky').status === 'pending');
            var empty = ledger.getBlockByHash('hashEmpty');
            check('empty split -> confirmed, no crash', !!empty && empty.status === 'confirmed' && eq(empty.amounts, {}), empty && empty.status);
            check('no extra PSBT work on second run',
                daemon.calls.walletcreatefundedpsbt.length === 2 && daemon.calls.sendrawtransaction.length === 2,
                'create=' + daemon.calls.walletcreatefundedpsbt.length + ' send=' + daemon.calls.sendrawtransaction.length);
            check('B yespower pending still carried after live runs', ledger.getBalances().yespower.addrB.pending === 32666666);
            done();
        });
    });
}

function scenarioResume(done) {
    console.log('--- scenario 2b: live stage failure leaves a resumable batch ---');
    var ledger = new Ledger({});
    // sha256 PROP block only (same round math as scenario 1).
    ledger.recordBlock({ algo: 'sha256', height: 99, hash: 'hashPrev', reward: 500000000, finder: 'addrA', time: 1000, scheme: 'prop' });
    ledger.updateBlockStatus('hashPrev', 'orphaned', 0);
    ledger.recordShare({ algo: 'sha256', worker: 'addrA', difficulty: 10, time: 1500, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrB', difficulty: 30, time: 1600, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrC', difficulty: 10, time: 1700, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: 'addrB', difficulty: 10, time: 2000, height: 100 });
    ledger.recordBlock({ algo: 'sha256', height: 100, hash: 'hashProp', reward: 500000000, finder: 'addrB', time: 2000, scheme: 'prop' });

    var daemon = new FakeDaemon();
    daemon.blockInfo = { hashProp: 10 };
    daemon.failOnceAt = 'finalizepsbt';
    var proc = createPaymentsProcessor({ daemon: daemon, ledger: ledger, config: baseConfig(false), logger: makeLogger() });
    proc.runOnce(function (err) {
        check('resume run 1 no error', !err, err && err.message);
        var payouts = ledger.getPayouts();
        check('resume run 1: one batch, stuck at processed with error recorded',
            payouts.length === 1 && payouts[0].stage === 'processed' && typeof payouts[0].error === 'string',
            JSON.stringify(payouts.map(function (p) { return { stage: p.stage, error: p.error }; })));
        check('resume run 1: balances NOT moved', ledger.getBalances().sha256.addrB.pending === 326666668,
            JSON.stringify(ledger.getBalances().sha256.addrB));
        check('resume run 1: block confirmed (not paid), linked to batch',
            ledger.getBlockByHash('hashProp').status === 'confirmed' && ledger.getBlockByHash('hashProp').payoutId === payouts[0].id);
        check('resume run 1: stage call counts', daemon.calls.walletcreatefundedpsbt.length === 1 && daemon.calls.walletprocesspsbt.length === 1 && daemon.calls.finalizepsbt.length === 1 && daemon.calls.sendrawtransaction.length === 0);
        proc.runOnce(function (err2) {
            check('resume run 2 no error', !err2, err2 && err2.message);
            var after = ledger.getPayouts();
            check('resume run 2: SAME batch sent (no second PSBT created)',
                after.length === 1 && after[0].stage === 'sent' && after[0].txid === 'faketxid123' && daemon.calls.walletcreatefundedpsbt.length === 1,
                JSON.stringify(after.map(function (p) { return { stage: p.stage, txid: p.txid }; })) + ' creates=' + daemon.calls.walletcreatefundedpsbt.length);
            check('resume run 2: finalize retried, broadcast once', daemon.calls.finalizepsbt.length === 2 && daemon.calls.sendrawtransaction.length === 1);
            check('resume run 2: balances settled', ledger.getBalances().sha256.addrB.pending === 0 && ledger.getBalances().sha256.addrB.paid === 326666668);
            check('resume run 2: block paid', ledger.getBlockByHash('hashProp').status === 'paid');
            done();
        });
    });
}

function scenarioAttach(done) {
    console.log('--- scenario 3: attachPayouts against a fake pool ---');
    var ledger = new Ledger({});
    var pool = new events.EventEmitter();
    pool.options = {};
    var detach = attachPayouts(pool, 'sha256', ledger, 'prop');
    pool.emit('share', true, false, { worker: 'addrA.rig1', algo: 'sha256', height: 5, difficulty: 8, blockReward: 500000000 });
    pool.emit('share', false, false, { worker: 'addrB', algo: 'sha256', height: 5, difficulty: 8, blockReward: 500000000 });
    pool.emit('share', true, true, { worker: 'addrB.rig2', algo: 'sha256', height: 6, difficulty: 8, blockReward: 500000000, blockHash: 'hashAttach' });
    check('attach: only valid shares recorded (2)', ledger.getShares('sha256').length === 2, 'n=' + ledger.getShares('sha256').length);
    var blocks = ledger.getBlocks('sha256');
    check('attach: block recorded once with scheme/reward/finder',
        blocks.length === 1 && blocks[0].scheme === 'prop' && blocks[0].reward === 500000000 &&
        blocks[0].finder === 'addrB' && blocks[0].hash === 'hashAttach' && blocks[0].status === 'pending',
        JSON.stringify(blocks));
    detach();
    pool.emit('share', true, false, { worker: 'addrA', algo: 'sha256', height: 7, difficulty: 8 });
    check('attach: detach stops recording', ledger.getShares('sha256').length === 2);
    done();
}

scenarioUnits();
scenarioDryRun(function () {
    scenarioLive(function () {
        scenarioResume(function () {
            scenarioAttach(function () {
                console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
                process.exit(failures === 0 ? 0 : 1);
            });
        });
    });
});
