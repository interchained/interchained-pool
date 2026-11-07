'use strict';
/*
 * test-fairness.js -- verification for the phase-3 fairness core:
 * per-block breakdown, reconciliation, ledger export and the standalone
 * verifier CLI (scripts/verify-payout.js) run end-to-end as a child
 * process against a synthetic settled pool.
 * Run: node lib/payouts/test-fairness.js  (exit non-zero on failure)
 *
 * The synthetic pool reuses the phase-2 scenario math (see
 * test-payouts.js): sha256 PROP and yespower PPLNS(window 3), fee 2%,
 * minPayout 0.5 ITC. Differences: miners use REAL base58check P2PKH
 * addresses and the fake daemon returns REAL BIP174 PSBTs (built below
 * with pure JS), so the verifier's PSBT-output check is genuinely
 * exercised -- a tampered payout amount must fail verification.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var childProcess = require('child_process');

var Ledger = require('./ledger').Ledger;
var createPaymentsProcessor = require('./payments').createPaymentsProcessor;
var verifySplit = require('./verifySplit');
var breakdown = require('./breakdown');
var reconcile = require('./reconcile');
var apiServer = require('../../api/server');

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('PASS  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sum(obj) { return Object.keys(obj || {}).reduce(function (s, k) { return s + obj[k]; }, 0); }

/* ---------------- real addresses + a pure-JS PSBT builder ---------- */
function makeAddress(fillByte) {
    return verifySplit.base58CheckEncode(0x00, Buffer.alloc(20, fillByte));
}
var ADDR_A = makeAddress(0x11);
var ADDR_B = makeAddress(0x22);
var ADDR_C = makeAddress(0x33);

var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
    var bytes = [0];
    for (var i = 0; i < str.length; i++) {
        var carry = B58.indexOf(str[i]);
        if (carry < 0) throw new Error('bad base58 char');
        for (var j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry >>= 8;
        }
        while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    var zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros++;
    var out = Buffer.alloc(zeros + bytes.length);
    for (var k = 0; k < bytes.length; k++) out[zeros + bytes.length - 1 - k] = bytes[k];
    return out;
}
function addressToScript(addr) {
    var raw = base58Decode(addr); // version(1) + hash160(20) + checksum(4)
    var hash160 = raw.slice(1, 21);
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash160, Buffer.from([0x88, 0xac])]);
}
function varInt(n) {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) { var b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
    var c = Buffer.alloc(5); c[0] = 0xfe; c.writeUInt32LE(n, 1); return c;
}
function kv(keyBuf, valBuf) { return Buffer.concat([varInt(keyBuf.length), keyBuf, varInt(valBuf.length), valBuf]); }

/* Build a real (minimal, unsigned) BIP174 PSBT paying `outputsSat`. */
function buildPsbt(outputsSat) {
    var addrs = Object.keys(outputsSat).sort();
    var txParts = [];
    var version = Buffer.alloc(4); version.writeUInt32LE(2, 0); txParts.push(version);
    txParts.push(varInt(1));                       // 1 input
    txParts.push(Buffer.alloc(32));                // prev txid (dummy)
    var vout = Buffer.alloc(4); vout.writeUInt32LE(0, 0); txParts.push(vout);
    txParts.push(varInt(0));                       // empty scriptSig
    var seq = Buffer.alloc(4); seq.writeUInt32LE(0xffffffff, 0); txParts.push(seq);
    txParts.push(varInt(addrs.length));
    addrs.forEach(function (addr) {
        var val = Buffer.alloc(8); val.writeBigUInt64LE(BigInt(outputsSat[addr]), 0);
        var script = addressToScript(addr);
        txParts.push(val, varInt(script.length), script);
    });
    var locktime = Buffer.alloc(4); txParts.push(locktime);
    var unsignedTx = Buffer.concat(txParts);
    var psbt = Buffer.concat([
        Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]), // 'psbt' + 0xff
        kv(Buffer.from([0x00]), unsignedTx),
        Buffer.from([0x00]),                          // end global map
        Buffer.from([0x00])                           // end input map (1 input)
    ]);
    addrs.forEach(function () { psbt = Buffer.concat([psbt, Buffer.from([0x00])]); }); // output maps
    return psbt.toString('base64');
}

/* ---------------- fake daemon (real PSBTs) ------------------------- */
function FakeDaemon() {
    this.blockInfo = {};
    this.calls = { walletcreatefundedpsbt: 0, walletprocesspsbt: 0, sendrawtransaction: 0 };
}
FakeDaemon.prototype.cmd = function (method, params, callback) {
    var self = this;
    process.nextTick(function () {
        function ok(response) { callback([{ error: null, response: response, instance: { index: 0 } }]); }
        function err(e) { callback([{ error: e, response: undefined, instance: { index: 0 } }]); }
        if (method === 'getblock') {
            var hash = params[0];
            if (typeof self.blockInfo[hash] === 'number')
                return ok({ hash: hash, confirmations: self.blockInfo[hash], tx: ['coinbase'] });
            return err({ code: -5, message: 'Block not found' });
        }
        if (method === 'walletcreatefundedpsbt') {
            self.calls.walletcreatefundedpsbt++;
            var outputsSat = {};
            Object.keys(params[1] || {}).forEach(function (a) {
                outputsSat[a] = Math.round(parseFloat(params[1][a]) * 1e8);
            });
            return ok({ psbt: buildPsbt(outputsSat), fee: 0.0001, changepos: -1 });
        }
        return err({ code: -32601, message: 'Method not found' });
    });
};

function feed(ledger) {
    var A = {}; A[ADDR_A] = true;
    ledger.recordBlock({ algo: 'sha256', height: 99, hash: 'hashPrev', reward: 500000000, finder: ADDR_A, time: 1000, scheme: 'prop' });
    ledger.updateBlockStatus('hashPrev', 'orphaned', 0);
    ledger.recordShare({ algo: 'sha256', worker: ADDR_A, difficulty: 10, time: 1500, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: ADDR_B, difficulty: 30, time: 1600, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: ADDR_C, difficulty: 10, time: 1700, height: 100 });
    ledger.recordShare({ algo: 'sha256', worker: ADDR_B, difficulty: 10, time: 2000, height: 100 });
    ledger.recordBlock({ algo: 'sha256', height: 100, hash: 'hashProp', reward: 500000000, finder: ADDR_B, time: 2000, scheme: 'prop' });

    ledger.recordShare({ algo: 'yespower', worker: ADDR_A, difficulty: 100, time: 1000, height: 50 });
    ledger.recordShare({ algo: 'yespower', worker: ADDR_B, difficulty: 10, time: 1100, height: 50 });
    ledger.recordShare({ algo: 'yespower', worker: ADDR_A, difficulty: 20, time: 1200, height: 50 });
    ledger.recordShare({ algo: 'yespower', worker: ADDR_C, difficulty: 30, time: 1300, height: 50 });
    ledger.recordBlock({ algo: 'yespower', height: 50, hash: 'hashPplns', reward: 200000000, finder: ADDR_C, time: 1400, scheme: 'pplns' });
}

var EXPECTED_YES = {}; EXPECTED_YES[ADDR_B] = 32666666; EXPECTED_YES[ADDR_A] = 65333333; EXPECTED_YES[ADDR_C] = 98000001;

function runVerifier(exportObj, tmpDir, name) {
    var file = path.join(tmpDir, name);
    fs.writeFileSync(file, JSON.stringify(exportObj, null, 2));
    return childProcess.spawnSync(process.execPath,
        [path.join(__dirname, '..', '..', 'scripts', 'verify-payout.js'), file],
        { encoding: 'utf8' });
}

function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var body = '';
            res.on('data', function (d) { body += d; });
            res.on('end', function () {
                try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

/* ---------------- scenario ---------------------------------------- */
console.log('--- unit: PSBT output parsing ---');
check('parsePsbtOutputs round-trips a built PSBT',
    eq(verifySplit.parsePsbtOutputs(buildPsbt({})), {}) &&
    eq(verifySplit.parsePsbtOutputs(buildPsbt((function () { var o = {}; o[ADDR_A] = 12345; o[ADDR_B] = 678; return o; })())),
        (function () { var o = {}; o[ADDR_A] = 12345; o[ADDR_B] = 678; return o; })()));
var threwOnGarbage = false;
try { verifySplit.parsePsbtOutputs(Buffer.from('not a psbt').toString('base64')); } catch (e) { threwOnGarbage = true; }
check('parsePsbtOutputs throws on garbage (never a silent pass)', threwOnGarbage);

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-fairness-'));
var ledgerFile = path.join(tmpDir, 'payouts.json');
var ledger = new Ledger({ dataFile: ledgerFile });
feed(ledger);
var daemon = new FakeDaemon();
daemon.blockInfo = { hashProp: 10, hashPplns: 10 };
var proc = createPaymentsProcessor({
    daemon: daemon, ledger: ledger,
    config: {
        enabled: true, dryRun: true, feePercent: 2, minPayout: 0.5, confirmations: 5,
        intervalSeconds: 3600,
        schemes: { sha256: { scheme: 'prop' }, yespower: { scheme: 'pplns', pplnsWindow: 3 } }
    },
    logger: function () {}
});

proc.runOnce(function (err) {
    check('settle runOnce no error', !err, err && err.message);
    var yesBlock = ledger.getBlockByHash('hashPplns');
    check('yespower block settled with expected split', eq(yesBlock.amounts, EXPECTED_YES), JSON.stringify(yesBlock.amounts));

    console.log('--- breakdown ---');
    var bdSha = breakdown.breakdownForHeight(ledger, 100, { feePercent: 2, minPayoutSat: 50000000 });
    check('breakdown sha: reward/fee exact', bdSha.rewardSat === 500000000 && bdSha.feeSat === 10000000 &&
        bdSha.feePercent === 2, JSON.stringify({ fee: bdSha.feeSat, pct: bdSha.feePercent }));
    check('breakdown sha: PROP window (prevBlockTime 1000, 4 shares, 1500..2000)',
        bdSha.shareWindow.prevBlockTime === 1000 && bdSha.shareWindow.shareCount === 4 &&
        bdSha.shareWindow.firstShareTime === 1500 && bdSha.shareWindow.lastShareTime === 2000,
        JSON.stringify(bdSha.shareWindow));
    var minerB = bdSha.miners.filter(function (m) { return m.address === ADDR_B; })[0];
    check('breakdown sha: miner B shares/weight/payout', minerB.shareCount === 2 && minerB.weight === 40 &&
        minerB.payoutAmountSat === 326666668, JSON.stringify(minerB));
    check('breakdown sha: recompute matches recorded + balanced', bdSha.matchesRecorded === true && bdSha.balanced === true);
    var bdYes = breakdown.breakdownForHeight(ledger, 50, { feePercent: 2, windowN: 3, minPayoutSat: 50000000 });
    var yesB = bdYes.miners.filter(function (m) { return m.address === ADDR_B; })[0];
    var yesA = bdYes.miners.filter(function (m) { return m.address === ADDR_A; })[0];
    check('breakdown yespower: PPLNS window definition carries windowN 3 + range',
        bdYes.shareWindow.windowN === 3 && bdYes.shareWindow.shareCount === 3 &&
        bdYes.shareWindow.firstShareTime === 1100 && bdYes.shareWindow.lastShareTime === 1300,
        JSON.stringify(bdYes.shareWindow));
    check('breakdown yespower: B credited 32666666, paid 0, carry-over created 32666666',
        yesB.payoutAmountSat === 32666666 && yesB.paidOutSat === 0 && yesB.carryOverCreatedSat === 32666666,
        JSON.stringify(yesB));
    check('breakdown yespower: A paid out in full, no carry created',
        yesA.paidOutSat === 65333333 && yesA.carryOverCreatedSat === 0, JSON.stringify(yesA));

    console.log('--- reconciliation ---');
    var rec = reconcile.reconcile(ledger);
    check('reconcile: balanced on the settled pool', rec.balanced === true && rec.discrepancies.length === 0,
        JSON.stringify(rec.discrepancies));
    check('reconcile: aggregate identity 700M == payouts + fees + carry-over',
        rec.aggregate.rewardInSat === 700000000 &&
        rec.aggregate.payoutsSat + rec.aggregate.feeSat + rec.aggregate.carryOverDeltaSat === 700000000 &&
        rec.aggregate.carryOverDeltaSat === 32666666 && rec.aggregate.feeSat === 14000000 &&
        rec.aggregate.holds === true,
        JSON.stringify(rec.aggregate));
    var tamperedStore = JSON.parse(JSON.stringify(ledger.data));
    tamperedStore.blocks.forEach(function (b) { if (b.hash === 'hashProp') b.amounts[ADDR_A] += 1000; });
    var recBad = reconcile.reconcile(tamperedStore);
    check('reconcile: tampered credit surfaces as discrepancy, never force-balanced',
        recBad.balanced === false && recBad.discrepancies.some(function (d) { return d.kind === 'reward-mismatch'; }),
        JSON.stringify(recBad.discrepancies.map(function (d) { return d.kind; })));

    console.log('--- export + standalone verifier CLI (child process) ---');
    var exp = breakdown.ledgerExport(ledger, 50, { feePercent: 2, windowN: 3, minPayoutSat: 50000000, algo: 'yespower' });
    check('export carries raw shares, recorded split and batch with PSBT',
        exp.shares.length === 4 && !!exp.recorded && !!exp.batch && typeof exp.batch.psbt === 'string');
    var okRun = runVerifier(exp, tmpDir, 'export-ok.json');
    check('verifier CLI exits 0 on the honest export', okRun.status === 0,
        'status=' + okRun.status + '\n' + okRun.stdout + okRun.stderr);
    check('verifier CLI reports all three checks OK',
        /check 1 OK/.test(okRun.stdout) && /check 2 OK/.test(okRun.stdout) && /check 3 OK/.test(okRun.stdout),
        okRun.stdout);
    var tamperedBatch = JSON.parse(JSON.stringify(exp));
    tamperedBatch.batch.amounts[ADDR_A] += 1;
    var badRun = runVerifier(tamperedBatch, tmpDir, 'export-tampered-batch.json');
    check('verifier CLI exits non-zero when one payout amount is tampered (+1 sat)',
        badRun.status === 1 && /mismatch/.test(badRun.stdout),
        'status=' + badRun.status + '\n' + badRun.stdout);
    var tamperedRecorded = JSON.parse(JSON.stringify(exp));
    tamperedRecorded.recorded.amounts[ADDR_C] -= 500;
    var badRun2 = runVerifier(tamperedRecorded, tmpDir, 'export-tampered-recorded.json');
    check('verifier CLI exits non-zero when a recorded split amount is tampered',
        badRun2.status === 1 && /split mismatch/.test(badRun2.stdout),
        'status=' + badRun2.status + '\n' + badRun2.stdout);

    console.log('--- API endpoints ---');
    var collector = new apiServer.StatsCollector({ dataFile: null });
    var server = apiServer.createServer({
        collector: collector,
        payoutsFile: ledgerFile,
        poolConfig: {
            payments: { feePercent: 2, minPayout: 0.5, dryRun: true, confirmations: 5 },
            algos: { sha256: { scheme: 'prop' }, yespower: { scheme: 'pplns', pplnsWindow: 3 }, ethash: { scheme: 'solo' } }
        }
    });
    server.listen(0, '127.0.0.1', function () {
        var port = server.address().port;
        Promise.all([
            httpGet(port, '/api/blocks/50/breakdown?algo=yespower'),
            httpGet(port, '/api/blocks/50/ledger?algo=yespower'),
            httpGet(port, '/api/reconcile'),
            httpGet(port, '/api/breakdowns'),
            httpGet(port, '/api/stats'),
            httpGet(port, '/api/blocks/999999/breakdown')
        ]).then(function (r) {
            check('API breakdown endpoint: 200 + exact fee/window',
                r[0].status === 200 && r[0].json.feeSat === 4000000 && r[0].json.shareWindow.windowN === 3,
                'status=' + r[0].status);
            check('API ledger export endpoint: 200 + raw shares + batch PSBT',
                r[1].status === 200 && r[1].json.shares.length === 4 && typeof r[1].json.batch.psbt === 'string');
            // The API export must verify standalone, exactly as a miner would run it.
            var apiRun = runVerifier(r[1].json, tmpDir, 'export-from-api.json');
            check('API ledger export verifies with the CLI (exit 0)', apiRun.status === 0,
                'status=' + apiRun.status + '\n' + apiRun.stdout);
            check('API reconcile endpoint: balanced aggregate',
                r[2].status === 200 && r[2].json.balanced === true && r[2].json.aggregate.rewardInSat === 700000000);
            check('API breakdowns list: both settled blocks present',
                r[3].status === 200 && r[3].json.filter(function (b) { return b.settled; }).length === 2);
            check('API existing /api/stats untouched (200)', r[4].status === 200 && !!r[4].json.algos);
            check('API breakdown for unknown height -> 404', r[5].status === 404);
            server.close(function () {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
                process.exit(failures === 0 ? 0 : 1);
            });
        }).catch(function (e) {
            check('API requests complete', false, e.message);
            server.close(function () {
                console.log('\n' + failures + ' CHECK(S) FAILED');
                process.exit(1);
            });
        });
    });
});
