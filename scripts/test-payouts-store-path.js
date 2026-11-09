'use strict';
/*
 * test-payouts-store-path.js — payouts store READER COHERENCE.
 *
 * Live bug (2026-11-09): the pool settled block 914572 on chain while
 * the standalone-served dashboard reconciled an empty store (all
 * zeros, no breakdowns). The writer and the readers resolved the
 * store path with different knobs:
 *   writer (start.js):  config.payments.dataFile / env
 *                       ITC_PAYMENTS_DATA_FILE / api/data/payouts.json
 *   reader (server.js): options.payoutsFile / env ITC_PAYOUTS_FILE /
 *                       api/data/payouts.json
 * Setting the documented writer knob moved the ledger and left every
 * standalone reader behind. lib/payouts/storePath.js is now the one
 * resolver both sides call; these checks pin the precedence and prove
 * the end-to-end property: a store written through the pool-side
 * resolution is the store a standalone createServer (NO explicit
 * payoutsFile) reads back.
 *
 * Run: node scripts/test-payouts-store-path.js
 */

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var storePath = require('../lib/payouts/storePath.js');
var Ledger = require('../lib/payouts/ledger.js').Ledger;
var createServer = require('../api/server.js').createServer;

var failures = 0;
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
    if (!cond) failures++;
}

var BLOCK_HASH = '029f4cf376f1fab02066917a9bf8051bef770f24c405c01a1dcaaae54837a210';
var BLOCK_HEIGHT = 914572;
var BLOCK_REWARD_SAT = 24088231;

function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
        }).on('error', reject);
    });
}

/* Write a store the pool-side way: resolve with the writer's inputs,
   then record through the real Ledger (synchronous save). */
function writeStoreViaPoolSide(resolveOpts) {
    var file = storePath.resolvePayoutsStorePath(resolveOpts);
    var ledger = new Ledger({ dataFile: file });
    ledger.recordShare({ algo: 'ethash', worker: 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu.v100', difficulty: 16, time: Date.now(), height: BLOCK_HEIGHT });
    ledger.recordBlock({ algo: 'ethash', height: BLOCK_HEIGHT, hash: BLOCK_HASH, reward: BLOCK_REWARD_SAT, finder: 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu.v100', scheme: 'solo' });
    ledger.close();
    return file;
}

async function boot(opts) {
    var server = createServer(opts);
    await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
    return { server: server, port: server.address().port };
}

async function main() {
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-storepath-'));
    var savedEnv = {
        ITC_PAYMENTS_DATA_FILE: process.env.ITC_PAYMENTS_DATA_FILE,
        ITC_PAYOUTS_FILE: process.env.ITC_PAYOUTS_FILE
    };
    function setEnv(paymentsDataFile, payoutsFile) {
        if (paymentsDataFile == null) delete process.env.ITC_PAYMENTS_DATA_FILE;
        else process.env.ITC_PAYMENTS_DATA_FILE = paymentsDataFile;
        if (payoutsFile == null) delete process.env.ITC_PAYOUTS_FILE;
        else process.env.ITC_PAYOUTS_FILE = payoutsFile;
    }

    try {
        console.log('— resolver precedence (one source of truth)');
        var R = storePath.resolvePayoutsStorePath;
        var cfg = { payments: { dataFile: path.join(tmp, 'from-config.json') } };
        check('explicit wins over everything',
            R({ explicit: path.join(tmp, 'explicit.json'), config: cfg, env: { ITC_PAYMENTS_DATA_FILE: path.join(tmp, 'a.json'), ITC_PAYOUTS_FILE: path.join(tmp, 'b.json') } }) === path.join(tmp, 'explicit.json'));
        check('ITC_PAYMENTS_DATA_FILE (writer knob) beats config + legacy env',
            R({ config: cfg, env: { ITC_PAYMENTS_DATA_FILE: path.join(tmp, 'a.json'), ITC_PAYOUTS_FILE: path.join(tmp, 'b.json') } }) === path.join(tmp, 'a.json'));
        check('config.payments.dataFile beats legacy env',
            R({ config: cfg, env: { ITC_PAYOUTS_FILE: path.join(tmp, 'b.json') } }) === path.join(tmp, 'from-config.json'));
        check('legacy ITC_PAYOUTS_FILE still honoured',
            R({ env: { ITC_PAYOUTS_FILE: path.join(tmp, 'b.json') } }) === path.join(tmp, 'b.json'));
        check('default is <repo>/api/data/payouts.json',
            R({}) === path.join(__dirname, '..', 'api', 'data', 'payouts.json'),
            R({}));

        console.log('— writer knob set: pool writes, standalone reads (no explicit payoutsFile)');
        var writerFile = path.join(tmp, 'pool-ledger.json');
        setEnv(writerFile, null);
        var written = writeStoreViaPoolSide({ config: { payments: { enabled: true } }, env: process.env });
        check('pool-side resolution follows ITC_PAYMENTS_DATA_FILE', written === writerFile, written);
        check('store file exists with the block',
            fs.existsSync(writerFile) && JSON.parse(fs.readFileSync(writerFile, 'utf8')).blocks.length === 1);

        var s1 = await boot({ dataFile: path.join(tmp, 'stats1.json') });
        check('standalone createServer resolves the same file', s1.server.payoutsFile === writerFile, s1.server.payoutsFile);
        var blocks1 = JSON.parse((await httpGet(s1.port, '/api/payouts/blocks')).body);
        check('block visible via /api/payouts/blocks',
            Array.isArray(blocks1) && blocks1.some(function (b) { return b.height === BLOCK_HEIGHT && b.hash === BLOCK_HASH; }),
            JSON.stringify(blocks1).slice(0, 140));
        var storeBlocks = JSON.parse((await httpGet(s1.port, '/api/blocks?source=store')).body);
        check('block visible via /api/blocks?source=store',
            Array.isArray(storeBlocks) && storeBlocks.some(function (b) { return b.height === BLOCK_HEIGHT; }));
        var rec = JSON.parse((await httpGet(s1.port, '/api/reconcile')).body);
        check('/api/reconcile runs against the same store (responds with its report)',
            !!rec && typeof rec.generatedAt === 'number' && rec.aggregate && typeof rec.aggregate === 'object',
            JSON.stringify(rec).slice(0, 100));
        s1.server.close();

        console.log('— config-only: payments.dataFile in the pool config, no env knobs');
        setEnv(null, null);
        var cfgFile = path.join(tmp, 'cfg-ledger.json');
        var poolConfig = { payments: { enabled: true, dataFile: cfgFile } };
        var written2 = writeStoreViaPoolSide({ config: poolConfig, env: process.env });
        check('pool-side resolution follows config.payments.dataFile', written2 === cfgFile, written2);
        var s2 = await boot({ dataFile: path.join(tmp, 'stats2.json'), storeConfig: poolConfig });
        check('standalone with storeConfig resolves the same file', s2.server.payoutsFile === cfgFile, s2.server.payoutsFile);
        var blocks2 = JSON.parse((await httpGet(s2.port, '/api/payouts/blocks')).body);
        check('block visible via /api/payouts/blocks (config-only)',
            Array.isArray(blocks2) && blocks2.some(function (b) { return b.height === BLOCK_HEIGHT; }));
        s2.server.close();
    } finally {
        setEnv(savedEnv.ITC_PAYMENTS_DATA_FILE, savedEnv.ITC_PAYOUTS_FILE);
    }

    console.log(failures ? failures + ' STORE PATH CHECK(S) FAILED' : 'ALL STORE PATH CHECKS PASSED');
    process.exit(failures ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
