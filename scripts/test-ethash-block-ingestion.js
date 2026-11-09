'use strict';
/*
 * test-ethash-block-ingestion.js — a found block's road into the
 * payouts store, end to end, for the classic lanes AND the Ethash lane.
 *
 * The live gap (2026-11-09): the Ethash lane found block 914572, the
 * daemon accepted it — and the payouts store never saw it.
 * /api/breakdowns (which lists EVERY recorded block, solo included)
 * stayed [] and /api/reconcile read an empty book.
 *
 * Root cause: start.setupPayments gated the LEDGER ATTACH behind
 * payments.enabled together with the PSBT processor, and the shipped
 * config defaults payments.enabled to false. With payments disabled
 * NO pool was wired into the ledger at all — attach.js never got the
 * 'share' events — so no shares and no blocks from any lane were
 * recorded. Recording is accounting (the fairness surface reads this
 * store); only moving money is opt-in. setupPayments now always
 * attaches recording and gates only the processor.
 *
 * This suite proves, through the production entry points:
 *   1. setupPayments with payments DISABLED still records a classic
 *      block share and an Ethash block share into the store file.
 *   2. The full Ethash chain — stratum submit of the known test
 *      vector through attachEthash, whose pool 'share' event carries
 *      the classic time/blockFoundTime stamps — lands in the ledger
 *      via attachPayouts, exactly like a classic block.
 *   3. setupPayments with payments ENABLED still builds the processor
 *      (and recording works the same).
 *
 * Run: node scripts/test-ethash-block-ingestion.js
 * (needs the repo's installed deps resolvable, like the other suites)
 */

var events = require('events');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var start = require('../start.js');
var attachEthash = require('../lib/ethash/ethashPool.js');
var attachPayouts = require('../lib/payouts/attach.js').attachPayouts;
var Ledger = require('../lib/payouts/ledger.js').Ledger;
var vectors = require('../lib/ethash/test-vectors.js').vectors;

var failures = 0;
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
    if (!cond) failures++;
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-ingest-'));

function fakePool(algo) {
    var p = new events.EventEmitter();
    p.poolAlgo = algo;
    p.options = {};
    return p;
}
function soloConfig(dataFile, enabled) {
    return {
        algos: [
            { algorithm: 'sha256', scheme: 'solo' },
            { algorithm: 'yespower', scheme: 'solo' },
            { algorithm: 'ethash', scheme: 'solo' }
        ],
        payments: { enabled: enabled, dataFile: dataFile, dryRun: true },
        daemon: { host: '127.0.0.1', port: 1, user: 'u', password: 'p' }
    };
}

/* The classic block share exactly as lib/pool.js emits it after the
   daemon accepted the block (isValidBlock already means accepted). */
function classicBlockShare(pool) {
    pool.emit('share', true, true, {
        job: 'c1', ip: '127.0.0.1', port: 3333, worker: 'itc1qclassicminer.w1',
        height: 914500, blockReward: 24088231, difficulty: 2048,
        shareDiff: 99999, blockDiff: 1.09, blockHash: 'classicblockhash',
        time: 1794230000, blockFoundTime: 1794230000,
        extraNonce1: '01000000', extraNonce2: '00000000', nTime: '6a000000', nonce: '00000000'
    });
}

/* ---------------- 1. recording survives payments.enabled = false -------- */
console.log('— setupPayments: ledger recording is not gated by payments.enabled');
var file1 = path.join(tmp, 'payouts-disabled.json');
var shaPool = fakePool('sha256');
var ethPool = fakePool('ethash');
var handle1 = start.setupPayments(soloConfig(file1, false), [shaPool, ethPool]);
check('disabled payments -> ledger returned, no processor',
    !!handle1 && !!handle1.ledger && handle1.processor === null);
classicBlockShare(shaPool);
ethPool.emit('share', true, true, {
    job: '1', ip: '::ffff:131.226.25.220', port: 3335,
    worker: 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu.v100',
    algo: 'ethash', height: 914572, blockReward: 24088231,
    difficulty: 16, shareDiff: 13785.00572247054, blockDiff: 1.0909099421240063,
    blockHash: '029f4cf376f1fab02066917a9bf8051bef770f24c405c01a1dcaaae54837a210',
    time: 1794235946, blockFoundTime: 1794235946,
    nonce64: '3717433173674652830', mixHash: '0e012d1ea7bca7479fd822ed186d99c82dbecc5a7e676833eade1440e8d20dff'
});
var blocks1 = handle1.ledger.getBlocks();
check('classic block recorded with payments disabled',
    blocks1.some(function (b) { return b.algo === 'sha256' && b.height === 914500 && b.status === 'pending'; }),
    JSON.stringify(blocks1));
var ethBlock = blocks1.filter(function (b) { return b.algo === 'ethash'; })[0];
check('ethash block 914572 recorded with payments disabled',
    !!ethBlock && ethBlock.height === 914572 && ethBlock.reward === 24088231 &&
    ethBlock.finder === 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu' && ethBlock.scheme === 'solo',
    JSON.stringify(ethBlock));
var onDisk = JSON.parse(fs.readFileSync(file1, 'utf8'));
check('ethash block is in the store FILE (what /api/breakdowns reads)',
    onDisk.blocks.some(function (b) { return b.algo === 'ethash' && b.height === 914572; }),
    JSON.stringify(onDisk.blocks.map(function (b) { return b.algo + '@' + b.height; })));

/* ---------------- 2. full Ethash chain: stratum -> adapter -> ledger ---- */
console.log('— attachEthash end to end into the ledger');
function FakeTemplate(jobId, rpcData) {
    this.jobId = jobId;
    this.rpcData = rpcData;
    this.algo = 'ethash';
    var target = BigInt('0x' + attachEthash.targetHexFromBits(rpcData.bits));
    this.difficulty = Number(BigInt('0x' + attachEthash.DIFF1_HEX)) / Number(target);
    this.transactionData = Buffer.alloc(0);
    var gen0 = Buffer.from('gen-p1-h' + rpcData.height + '-', 'utf8');
    var gen1 = Buffer.from('-gen-p2', 'utf8');
    this.serializeCoinbase = function (en1, en2) { return Buffer.concat([gen0, en1, en2, gen1]); };
    this.merkleTree = { withFirst: function (f) { return f; } };
    this.serializeHeader = function (merkleRoot, nTime, nonce) {
        var header = Buffer.alloc(80);
        var position = 0;
        header.write(nonce, position, 4, 'hex');
        header.write(rpcData.bits, position += 4, 4, 'hex');
        header.write(nTime, position += 4, 4, 'hex');
        header.write(merkleRoot, position += 4, 32, 'hex');
        header.write(rpcData.previousblockhash, position += 32, 32, 'hex');
        header.writeUInt32BE(rpcData.version, position + 32);
        return Buffer.from(header).reverse();
    };
    this.serializeBlock = function (header, coinbase) {
        return Buffer.concat([header, Buffer.from([1]), coinbase]);
    };
}
var rpcData = {
    height: 0, bits: '207fffff', coinbasevalue: 5000000000, transactions: [],
    previousblockhash: '1111111111111111111111111111111111111111111111111111111111111111',
    version: 0x20004000, curtime: 1700000000
};
var template = new FakeTemplate('1', rpcData);
var jobManager = new events.EventEmitter();
var enCounter = 0;
jobManager.extraNonceCounter = { next: function () { return (++enCounter).toString(16).padStart(8, '0'); } };
jobManager.extraNonce2Size = 4;
jobManager.currentJob = undefined;
var daemonCalls = [];
var pool2 = new events.EventEmitter();
pool2.jobManager = jobManager;
pool2.daemon = {
    cmd: function (method, params, callback) {
        daemonCalls.push(method);
        if (callback) callback([{ error: null, response: null, instance: { index: 0 } }]);
    }
};
var poolShareData = null;
pool2.on('share', function (isValid, isBlock, data) { if (isBlock) poolShareData = data; });
var ledger2 = new Ledger({ dataFile: path.join(tmp, 'payouts-ethash-e2e.json') });
attachPayouts(pool2, 'ethash', ledger2, { schemes: { ethash: { scheme: 'solo' } } });

function stratumClient(port) {
    var c = { socket: net.connect(port, '127.0.0.1'), buffer: '', waiters: {}, notifies: [], notifyWaiters: [] };
    c.socket.setEncoding('utf8');
    c.socket.on('data', function (d) {
        c.buffer += d;
        var lines = c.buffer.split('\n');
        c.buffer = lines.pop();
        lines.forEach(function (line) {
            if (!line) return;
            var msg = JSON.parse(line);
            if (msg.method === 'mining.notify') {
                c.notifies.push(msg.params);
                c.notifyWaiters = c.notifyWaiters.filter(function (w) { return !w(msg.params); });
            } else if (msg.id != null && c.waiters[msg.id]) {
                var w = c.waiters[msg.id]; delete c.waiters[msg.id]; w(msg);
            }
        });
    });
    c.send = function (id, method, params) {
        return new Promise(function (resolve) {
            c.waiters[id] = resolve;
            c.socket.write(JSON.stringify({ id: id, method: method, params: params }) + '\n');
        });
    };
    c.waitNotify = function (jobId) {
        var found = c.notifies.filter(function (p) { return p[0] === jobId; })[0];
        if (found) return Promise.resolve(found);
        return new Promise(function (resolve) {
            c.notifyWaiters.push(function (params) { if (params[0] === jobId) { resolve(params); return true; } return false; });
        });
    };
    return c;
}

async function ethashEndToEnd() {
    var handle = attachEthash(pool2, {
        port: 0,
        authorizeFn: function (ip, port, workerName, password, callback) {
            callback({ error: null, authorized: true, disconnect: false });
        },
        logger: function () {}
    });
    await handle.started;
    var port = handle.port();
    var v = vectors[0];
    handle.registerJob({
        jobId: 'vec0', headerHashHex: v.headerHash, height: 0,
        nBitsTargetHex: v.finalHash, shareTargetHex: v.finalHash, clean: false
    }, template, { headerBuffer: Buffer.alloc(80, 0xab), coinbaseBuffer: Buffer.from('deadbeef', 'hex') });
    var client = stratumClient(port);
    await client.send(1, 'mining.subscribe', []);
    await client.send(2, 'mining.authorize', ['ITCpayout.worker1', 'x']);
    await client.waitNotify('vec0');
    var res = await client.send(3, 'mining.submit', ['ITCpayout.worker1', 'vec0',
        BigInt(v.nonce).toString(16).padStart(16, '0'), v.headerHash, v.mixHash]);
    check('vector block share accepted by stratum', res.result === true);
    check('adapter submitted the block to the daemon', daemonCalls.indexOf('submitblock') !== -1,
        JSON.stringify(daemonCalls));
    check('pool shareData carries classic time + blockFoundTime stamps',
        !!poolShareData && typeof poolShareData.time === 'number' &&
        poolShareData.blockFoundTime === poolShareData.time,
        poolShareData && ('time=' + poolShareData.time + ' blockFoundTime=' + poolShareData.blockFoundTime));
    var recorded = ledger2.getBlocks('ethash');
    check('ethash block landed in the ledger via attachPayouts',
        recorded.length === 1 && recorded[0].height === 0 && recorded[0].reward === 5000000000 &&
        recorded[0].finder === 'ITCpayout' && recorded[0].hash === poolShareData.blockHash,
        JSON.stringify(recorded));
    client.socket.destroy();
    await new Promise(function (res2) { handle.close(res2); });
}

/* ---------------- 3. payments enabled: processor still built ------------ */
console.log('— setupPayments: payments enabled still builds the processor');
var file3 = path.join(tmp, 'payouts-enabled.json');
var shaPool3 = fakePool('sha256');
var handle3 = start.setupPayments(soloConfig(file3, true), [shaPool3]);
check('enabled payments -> processor built', !!handle3 && !!handle3.processor);
classicBlockShare(shaPool3);
check('classic block recorded with payments enabled',
    handle3.ledger.getBlocks().some(function (b) { return b.algo === 'sha256' && b.height === 914500; }));
if (handle3.processor) handle3.processor.stop();
if (handle3.ledger && handle3.ledger.close) handle3.ledger.close();

ethashEndToEnd().then(function () {
    if (handle1.ledger.close) handle1.ledger.close();
    if (ledger2.close) ledger2.close();
    console.log(failures === 0 ? 'ALL INGESTION CHECKS PASSED' : failures + ' INGESTION CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
}).catch(function (e) {
    console.log('FAIL  exception: ' + (e && e.stack || e));
    process.exit(1);
});
var watchdog = setTimeout(function () { console.log('FAIL  watchdog timeout'); process.exit(2); }, 90000);
watchdog.unref();
