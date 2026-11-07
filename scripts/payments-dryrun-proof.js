'use strict';
/*
 * payments-dryrun-proof.js -- phase-2 integration proof for the PSBT
 * payments processor, over REAL HTTP JSON-RPC against the stub daemon.
 *
 *   1. spawns scripts/stub-daemon.js on a scratch port (it logs every
 *      RPC it receives to a JSONL call log)
 *   2. builds a ledger with a PROP round + one found sha256 block
 *   3. runs the REAL payments processor (lib/payouts/payments.js) with
 *      a REAL lib/daemon.js DaemonInterface, dryRun:true
 *   4. asserts: the block was confirmed + split; one payout batch was
 *      recorded carrying a base64 PSBT at stage 'created'; the stub's
 *      call log shows walletcreatefundedpsbt and NONE of the signing
 *      stages (walletprocesspsbt / finalizepsbt / sendrawtransaction)
 *      and no sendmany.
 *
 * Exit 0 = PASS. Run with the pinned Node 16 (see .nvmrc).
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var childProcess = require('child_process');

var Ledger = require('../lib/payouts/ledger').Ledger;
var createPaymentsProcessor = require('../lib/payouts/payments').createPaymentsProcessor;
var daemonModule = require('../lib/daemon');

var STUB_PORT = 18444;
var failures = 0;
function check(name, cond, detail) {
    if (cond) console.log('PASS  ' + name);
    else { failures++; console.log('FAIL  ' + name + (detail ? '  -- ' + detail : '')); }
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-payproof-'));
var callLog = path.join(tmp, 'stub-calls.jsonl');
var ledgerFile = path.join(tmp, 'payouts.json');

var stub = childProcess.spawn(process.execPath,
    [path.join(__dirname, 'stub-daemon.js'), String(STUB_PORT)],
    { env: Object.assign({}, process.env, { STUB_CALL_LOG: callLog }), stdio: 'ignore' });

function cleanup(code) {
    try { stub.kill('SIGKILL'); } catch (e) { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    console.log(failures === 0 && code === 0 ? 'PAYMENTS-DRYRUN-PROOF: PASS' : 'PAYMENTS-DRYRUN-PROOF: FAIL');
    process.exit(code);
}

function waitPort(port, tries, done) {
    var s = net.connect(port, '127.0.0.1');
    s.on('connect', function () { s.end(); done(true); });
    s.on('error', function () {
        if (tries <= 0) return done(false);
        setTimeout(function () { waitPort(port, tries - 1, done); }, 250);
    });
}

waitPort(STUB_PORT, 40, function (up) {
    check('stub daemon up', up);
    if (!up) return cleanup(1);

    // Ledger: PROP round for sha256 -- shares then one found block.
    var ledger = new Ledger({ dataFile: ledgerFile });
    var t = Math.floor(Date.now() / 1000);
    ledger.recordShare({ algo: 'sha256', worker: 'minerA', difficulty: 10, time: t - 300, height: 1000 });
    ledger.recordShare({ algo: 'sha256', worker: 'minerB', difficulty: 30, time: t - 200, height: 1000 });
    ledger.recordBlock({
        algo: 'sha256', height: 1000, hash: 'proofblockhash', reward: 500000000,
        finder: 'minerB', time: t - 100, scheme: 'prop'
    });

    var daemon = new daemonModule.interface(
        [{ host: '127.0.0.1', port: STUB_PORT, user: 'stubuser', password: 'stubpass' }],
        function () {});
    daemon.init();

    var proc = createPaymentsProcessor({
        daemon: daemon,
        ledger: ledger,
        config: {
            enabled: true, dryRun: true, feePercent: 1, minPayout: 0.01,
            confirmations: 5, intervalSeconds: 3600,
            schemes: { sha256: { scheme: 'prop' } }
        },
        logger: function (severity, message) { console.log('  [processor] ' + severity + ': ' + message); }
    });

    var onlineTimer = setTimeout(function () { run(); }, 3000); // fallback
    daemon.once('online', function () { clearTimeout(onlineTimer); run(); });

    var ran = false;
    function run() {
        if (ran) return;
        ran = true;
        proc.runOnce(function (err, summary) {
            check('processor runOnce no error', !err, err && err.message);
            var block = ledger.getBlockByHash('proofblockhash');
            check('block confirmed by stub getblock then paid (dry-run semantics)',
                !!block && block.status === 'paid', block && block.status);
            check('split exact: weights 10/30, fee 1%',
                !!block && block.amounts && block.amounts.minerA === 123750000 && block.amounts.minerB === 371250000,
                block && JSON.stringify(block.amounts));
            var payouts = ledger.getPayouts();
            check('one payout batch recorded', payouts.length === 1, 'n=' + payouts.length);
            var p = payouts[0] || {};
            check('batch is a dry-run PSBT at stage created',
                p.dryRun === true && typeof p.psbt === 'string' && p.psbt.length > 0 && p.stage === 'created' && p.txid === null,
                JSON.stringify({ dryRun: p.dryRun, stage: p.stage, psbt: typeof p.psbt, txid: p.txid }));
            check('summary reports the batch', !!summary && summary.payouts.length === 1);

            var calls = '';
            try { calls = fs.readFileSync(callLog, 'utf8'); } catch (e) { /* handled below */ }
            check('stub saw walletcreatefundedpsbt', calls.indexOf('walletcreatefundedpsbt') !== -1);
            check('stub saw NO signing stages in dry-run',
                calls.indexOf('walletprocesspsbt') === -1 && calls.indexOf('finalizepsbt') === -1 &&
                calls.indexOf('sendrawtransaction') === -1);
            check('stub saw NO sendmany', calls.indexOf('sendmany') === -1);
            cleanup(failures === 0 ? 0 : 1);
        });
    }
});
