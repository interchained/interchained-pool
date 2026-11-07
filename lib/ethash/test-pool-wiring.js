'use strict';
/**
 * lib/ethash/test-pool-wiring.js — self-contained verification for
 * lib/ethash/ethashPool.js (attachEthash). Run:
 *     node lib/ethash/test-pool-wiring.js
 * (needs js-sha3 resolvable — a normal `npm install` provides it; the file
 * itself exercises no native modules.)
 *
 * WHY FAKES: the real BlockTemplate / JobManager cannot be require()d in
 * this environment — lib/blockTemplate.js needs the `bignum` native addon
 * (bindings not built; the node-gyp failure predates this lane and is
 * documented in phase-1 evidence) and lib/util.js needs bs58check /
 * bitcoinjs-lib, which are not installed here. The fake template below is
 * FAITHFUL: its serializeCoinbase / serializeHeader / serializeBlock copy
 * lib/blockTemplate.js's algorithms statement-for-statement, its jobManager
 * carries the same extraNonceCounter/extraNonce2Size surface, and its daemon
 * records cmd() calls with the DaemonInterface callback shape
 * ([{error, response, instance}]).
 *
 * DRIVES: job feed -> raw TCP stratum client -> subscribe/authorize ->
 * notify -> invalid share -> the KNOWN test-vector share (job constructed
 * from test-vectors.js vector 0 via handle.registerJob) -> block candidate
 * -> submitblock assertion -> authorize rejection. Exits non-zero on any
 * failure. Epoch-0 cache generation makes the first share take seconds.
 */
var net = require('net');
var crypto = require('crypto');
var events = require('events');
var attachEthash = require('./ethashPool.js');
var vectors = require('./test-vectors.js').vectors;

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}
function sha256d(buf) {
    return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
}
function reversedHex(buf) { return Buffer.from(buf).reverse().toString('hex'); }
function varIntBuffer(n) {
    if (n < 0xfd) return Buffer.from([n]);
    var b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b;
}

// ---- faithful fake BlockTemplate -------------------------------------------
function FakeTemplate(jobId, rpcData) {
    this.jobId = jobId;
    this.rpcData = rpcData;
    this.algo = 'ethash';
    // difficulty like BlockTemplate: diff1 / target
    var target = BigInt('0x' + attachEthash.targetHexFromBits(rpcData.bits));
    this.difficulty = Number(BigInt('0x' + attachEthash.DIFF1_HEX)) / Number(target);
    this.transactionData = Buffer.concat(rpcData.transactions.map(function (tx) { return Buffer.from(tx.data, 'hex'); }));
    var gen0 = Buffer.from('gen-p1-h' + rpcData.height + '-', 'utf8');
    var gen1 = Buffer.from('-gen-p2', 'utf8');
    this.serializeCoinbase = function (extraNonce1, extraNonce2) {
        return Buffer.concat([gen0, extraNonce1, extraNonce2, gen1]);
    };
    this.merkleTree = { withFirst: function (f) { return f; } }; // no non-coinbase txs: no steps
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
        return Buffer.concat([header, varIntBuffer(rpcData.transactions.length + 1), coinbase, this.transactionData]);
    };
}

// ---- fake pool ---------------------------------------------------------------
var rpcDataA = {
    height: 0, bits: '207fffff', coinbasevalue: 5000000000, transactions: [],
    previousblockhash: '1111111111111111111111111111111111111111111111111111111111111111',
    version: 0x20004000, // 0x20000000 | ethash tag (2 << 13)
    curtime: 1700000000
};
var templateA = new FakeTemplate('1', rpcDataA);

var jobManager = new events.EventEmitter();
var enCounter = 0;
jobManager.extraNonceCounter = { next: function () { return (++enCounter).toString(16).padStart(8, '0'); } };
jobManager.extraNonce2Size = 4;
jobManager.currentJob = undefined;

var daemonCalls = [];
var fakeDaemon = {
    cmd: function (method, params, callback) {
        daemonCalls.push({ method: method, params: params });
        if (callback) callback([{ error: null, response: null, instance: { index: 0 } }]);
    }
};

var pool = new events.EventEmitter();
pool.jobManager = jobManager;
pool.daemon = fakeDaemon;
var poolShares = [];
pool.on('share', function (isValid, isBlock, data) { poolShares.push({ isValid: isValid, isBlock: isBlock, data: data }); });
var poolLogs = [];

var authorizeCalls = [];
function authorizeFn(ip, port, workerName, password, callback) {
    authorizeCalls.push({ ip: ip, port: port, workerName: workerName, password: password });
    var payout = (typeof workerName === 'string') ? workerName.trim().split('.')[0] : '';
    if (!payout) {
        callback({ error: [20, 'a payout address is required as the username', null], authorized: false, disconnect: false });
        return;
    }
    callback({ error: null, authorized: true, disconnect: false });
}

// ---- raw stratum client --------------------------------------------------------
function StratumClient(port) {
    this.socket = net.connect(port, '127.0.0.1');
    this.buffer = '';
    this.waiters = {};   // id -> resolve
    this.notifies = [];
    this.notifyWaiters = [];
    var _this = this;
    this.socket.setEncoding('utf8');
    this.socket.on('data', function (d) {
        _this.buffer += d;
        var lines = _this.buffer.split('\n');
        _this.buffer = lines.pop();
        lines.forEach(function (line) {
            if (!line) return;
            var msg = JSON.parse(line);
            if (msg.method === 'mining.notify') {
                _this.notifies.push(msg.params);
                _this.notifyWaiters = _this.notifyWaiters.filter(function (w) { return !w(msg.params); });
            } else if (msg.id !== null && msg.id !== undefined && _this.waiters[msg.id]) {
                var w = _this.waiters[msg.id]; delete _this.waiters[msg.id]; w(msg);
            }
        });
    });
}
StratumClient.prototype.send = function (id, method, params) {
    var _this = this;
    return new Promise(function (resolve) {
        _this.waiters[id] = resolve;
        _this.socket.write(JSON.stringify({ id: id, method: method, params: params }) + '\n');
    });
};
StratumClient.prototype.waitNotify = function (jobId) {
    var _this = this;
    var found = this.notifies.filter(function (p) { return p[0] === jobId; })[0];
    if (found) return Promise.resolve(found);
    return new Promise(function (resolve) {
        _this.notifyWaiters.push(function (params) { if (params[0] === jobId) { resolve(params); return true; } return false; });
    });
};

async function main() {
    var handle = attachEthash(pool, {
        port: 0,
        authorizeFn: authorizeFn,
        logger: function (sev, text) { poolLogs.push(sev + ': ' + text); }
    });
    await handle.started;
    var port = handle.port();
    check('ethash stratum server listening on ephemeral port', typeof port === 'number' && port > 0, 'port=' + port);

    // 1) job feed from jobManager 'newBlock'
    jobManager.emit('newBlock', templateA);
    var entry = handle.jobs.get('1');
    check('job map holds template job 1', !!entry);
    check('network target = bits 207fffff expansion', entry && entry.networkTargetHex === '7fffff' + '0'.repeat(58), entry && entry.networkTargetHex);
    check('stored header is 80 bytes', entry && entry.headerBuffer.length === 80);
    check('headerHashHex = display-order sha256d(header)', entry && entry.headerHashHex === reversedHex(sha256d(entry.headerBuffer)), entry && entry.headerHashHex);

    // 2) stratum round trip
    var client = new StratumClient(port);
    var sub = await client.send(1, 'mining.subscribe', []);
    check('subscribe result carries extranonce size 0', !!sub.result && sub.result[2] === 0);
    var auth = await client.send(2, 'mining.authorize', ['ITCpayout.worker1', 'x']);
    check('authorize accepted via authorizeFn', auth.result === true);
    check('authorizeFn called with classic (ip, port, worker, password)',
        authorizeCalls.length >= 1 && authorizeCalls[0].workerName === 'ITCpayout.worker1' &&
        authorizeCalls[0].password === 'x' && authorizeCalls[0].port === port && !!authorizeCalls[0].ip,
        JSON.stringify(authorizeCalls[0]));
    var notify = await client.waitNotify('1');
    check('notify seedHash is epoch-0 seed', notify[1] === '0'.repeat(64));
    check('notify headerHash matches built job', notify[2] === entry.headerHashHex);
    check('notify clean flag true for newBlock', notify[4] === true);

    // 3) invalid share (wrong mix) on the fed job
    var bad = await client.send(3, 'mining.submit', ['ITCpayout.worker1', '1', '0000000000000000', entry.headerHashHex, '0'.repeat(64)]);
    check('wrong-mix share rejected by stratum', bad.result === false && !!bad.error);
    var badShare = poolShares.filter(function (s) { return s.data.job === '1'; }).pop();
    check('pool share event for invalid share', !!badShare && badShare.isValid === false && badShare.isBlock === false && badShare.data.error === 'mix hash mismatch');
    check('invalid shareData carries algo/height/reward', !!badShare && badShare.data.algo === 'ethash' && badShare.data.height === 0 && badShare.data.blockReward === 5000000000);

    // 4) known test-vector job + share -> block candidate -> submitblock
    var v = vectors[0]; // header 00..00, nonce 0, height 0
    var vecHeader = Buffer.alloc(80, 0xab);
    var vecCoinbase = Buffer.from('deadbeef', 'hex');
    handle.registerJob({
        jobId: 'vec0', headerHashHex: v.headerHash, height: 0,
        nBitsTargetHex: v.finalHash, shareTargetHex: v.finalHash, clean: false
    }, templateA, { headerBuffer: vecHeader, coinbaseBuffer: vecCoinbase });
    var vecNotify = await client.waitNotify('vec0');
    check('vector job notify received (clean=false)', vecNotify[2] === v.headerHash && vecNotify[4] === false);

    var good = await client.send(4, 'mining.submit', ['ITCpayout.worker1', 'vec0',
        BigInt(v.nonce).toString(16).padStart(16, '0'), v.headerHash, v.mixHash]);
    check('known vector share accepted by stratum', good.result === true);
    var share = poolShares.filter(function (s) { return s.data.job === 'vec0'; }).pop();
    check('pool share event: valid + block candidate', !!share && share.isValid === true && share.isBlock === true);
    check('shareData classic shape', !!share && share.data.algo === 'ethash' && share.data.height === 0 &&
        share.data.blockReward === 5000000000 && share.data.worker === 'ITCpayout.worker1' && !!share.data.ip && share.data.port === port);
    check('shareData ethash fields', !!share && share.data.nonce64 === '0' && share.data.nonce64LeHex === '0000000000000000' &&
        share.data.mixHash === v.mixHash && share.data.finalHash === v.finalHash);
    var expectedFullHeader = Buffer.concat([vecHeader, Buffer.alloc(8), Buffer.from(v.mixHash, 'hex').reverse()]);
    var expectedBlockHash = reversedHex(sha256d(expectedFullHeader));
    check('shareData blockHash = display sha256d(120-byte header)', !!share && share.data.blockHash === expectedBlockHash, share && share.data.blockHash);
    check('shareData difficulty convention (share target == final => difficulty == shareDiff)',
        !!share && Math.abs(share.data.difficulty - share.data.shareDiff) < 1e-12 && share.data.shareDiff > 0,
        share && ('difficulty=' + share.data.difficulty + ' shareDiff=' + share.data.shareDiff));

    check('daemon submitblock called exactly once', daemonCalls.length === 1 && daemonCalls[0].method === 'submitblock', JSON.stringify(daemonCalls.map(function (c) { return c.method; })));
    var expectedBlockHex = Buffer.concat([expectedFullHeader, varIntBuffer(1), vecCoinbase]).toString('hex');
    check('submitblock hex = 120B header + varInt(1) + coinbase (125 bytes)',
        daemonCalls.length === 1 && daemonCalls[0].params[0] === expectedBlockHex && daemonCalls[0].params[0].length === 250,
        daemonCalls.length && daemonCalls[0].params[0].length + ' hex chars');
    check('shareData blockHex matches submitted hex', !!share && share.data.blockHex === expectedBlockHex);

    // 5) authorize rejection through the hook (empty username, start.js semantics)
    var client2 = new StratumClient(port);
    await client2.send(1, 'mining.subscribe', []);
    var denied = await client2.send(2, 'mining.authorize', ['', 'x']);
    check('empty username rejected by authorizeFn hook', denied.result === false && !!denied.error);
    client2.socket.destroy();

    client.socket.destroy();
    handle.close(function () {
        console.log(failures === 0 ? 'ALL WIRING CHECKS PASSED' : failures + ' WIRING CHECK(S) FAILED');
        process.exit(failures === 0 ? 0 : 1);
    });
}

var watchdog = setTimeout(function () { console.log('FAIL  watchdog timeout'); process.exit(2); }, 90000);
watchdog.unref();
main().catch(function (e) { console.log('FAIL  exception: ' + (e && e.stack || e)); process.exit(1); });
