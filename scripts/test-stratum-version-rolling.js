'use strict';
/**
 * scripts/test-stratum-version-rolling.js — BIP310 version-rolling.
 * Run:  node scripts/test-stratum-version-rolling.js
 *
 * Why this exists: on 2026-11-09 a third-party ASIC connected to the
 * public sha256 lane and had EVERY share rejected (0 accepted / 29
 * rejected) — the classic symptom of a miner whose firmware rolls
 * version bits (or expects to) against a pool whose stratum never
 * answers mining.configure and whose share validation can only rebuild
 * the header with the template's exact version. This test pins the
 * compatibility behaviour end to end at the unit level:
 *
 *   A. mining.configure (Antminer shape) is answered: version-rolling
 *      granted with the pool mask 1fff8000 (tri-PoW tag bits 13-14 are
 *      NOT rollable), and the client records the granted mask.
 *   B. A requested mask is intersected with the pool mask — a miner
 *      asking to roll ONLY the algo-tag bits gets nothing.
 *   C. A share ground over a version rolled inside the mask validates
 *      when the rolled version arrives as the submit's 6th parameter.
 *   D. The same share WITHOUT the version parameter is rejected [23]
 *      (proves the parameter is what carries the roll).
 *   E. A share rolled OUTSIDE the mask (algo-tag bit) is rejected even
 *      with the parameter present — the tag can never be rolled into
 *      acceptance.
 *   F. A plain unrolled share validates with no version arguments at
 *      all (legacy path unchanged).
 *   G. handleSubmit forwards params[5] as the submit event's version.
 */

var crypto = require('crypto');
var events = require('events');

require('../lib/algoProperties'); // installs global algos/diff1
var util = require('../lib/util.js');
var StratumClient = require('../lib/stratum.js').StratumClient;
var JobManager = require('../lib/jobManager.js');

var failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('ok   - ' + name); }
    else { failures++; console.log('FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}

function sha256(buf) { var h = crypto.createHash('sha256'); h.update(buf); return h.digest(); }
function sha256d(buf) { return sha256(sha256(buf)); }
var DIFF1 = BigInt('0x00000fffff000000000000000000000000000000000000000000000000000000');

/* ------------------------------------------------ A/B/G: stratum client */

function fakeSocket() {
    var s = new events.EventEmitter();
    s.remoteAddress = '127.0.0.1';
    s.localPort = 3333;
    s.written = [];
    s.setEncoding = function () {};
    s.setKeepAlive = function () {};
    s.write = function (str) { s.written.push(str); };
    s.destroy = function () { s.destroyed = true; };
    return s;
}
function makeClient() {
    var socket = fakeSocket();
    var client = new StratumClient({
        socket: socket,
        subscriptionId: 'testsub',
        authorizeFn: function (ip, port, user, pass, cb) { cb({ error: null, authorized: true, disconnect: false }); },
        banning: { enabled: false },
        tcpProxyProtocol: false
    });
    client.init();
    return { client: client, socket: socket };
}
function send(client, obj) { client.socket.emit('data', JSON.stringify(obj) + '\n'); }
function replies(socket) {
    return socket.written.join('').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}

(function testConfigure() {
    var t = makeClient();
    send(t.client, { id: 0, method: 'mining.configure', params: [['version-rolling'], { 'version-rolling.mask': 'ffffffff' }] });
    var r = replies(t.socket).filter(function (m) { return m.id === 0; })[0];
    check('A1 configure answered', !!r);
    check('A2 version-rolling granted', !!r && r.result && r.result['version-rolling'] === true, JSON.stringify(r));
    check('A3 granted mask is the pool mask (tag bits excluded)', !!r && r.result['version-rolling.mask'] === '1fff8000', r && r.result['version-rolling.mask']);
    check('A4 client recorded the mask', t.client.versionRollingMask === 0x1fff8000);

    var t2 = makeClient();
    send(t2.client, { id: 0, method: 'mining.configure', params: [['version-rolling'], { 'version-rolling.mask': '00006000' }] });
    var r2 = replies(t2.socket).filter(function (m) { return m.id === 0; })[0];
    check('B1 tag-only mask request grants nothing', !!r2 && r2.result['version-rolling'] === false && t2.client.versionRollingMask === 0, JSON.stringify(r2));

    var t3 = makeClient();
    var gotSubmit = null;
    t3.client.on('submit', function (params, cb) { gotSubmit = params; cb(null, true); });
    send(t3.client, { id: 1, method: 'mining.authorize', params: ['worker', 'x'] });
    t3.client.extraNonce1 = 'aabbccdd'; // as the subscription handler would set
    send(t3.client, { id: 2, method: 'mining.submit', params: ['worker', '1', '00000001', '6af217e0', '0000002a', '20008000'] });
    check('G1 submit event carries the 6th-param version', !!gotSubmit && gotSubmit.version === '20008000', JSON.stringify(gotSubmit));
})();

/* ------------------------------------------------ C/D/E/F: jobManager */

function wordReverse(buf) {
    var out = Buffer.alloc(buf.length);
    for (var i = 0; i < buf.length; i += 4) out.writeUInt32LE(buf.readUInt32BE(i), i);
    return out;
}

/* Build a share exactly the way a conforming stratum miner does
   (proven byte-for-byte against this pool in the 2026-11-09 harness):
   header = LE(version) | wordReversed(notifyPrevhash) | merkleRoot |
            LE(ntime) | LE(bits) | LE(nonce); submit nonce as BE hex. */
function grindShare(jm, versionInt) {
    var job = jm.currentJob;
    var params = job.getJobParams();
    var en1 = jm.extraNonceCounter.next();
    var en2 = '00000001';
    var coinbase = Buffer.concat([
        Buffer.from(params[2], 'hex'), Buffer.from(en1, 'hex'),
        Buffer.from(en2, 'hex'), Buffer.from(params[3], 'hex')
    ]);
    var root = sha256d(coinbase);
    params[4].forEach(function (step) { root = sha256d(Buffer.concat([root, Buffer.from(step, 'hex')])); });
    function le32(n) { var b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
    function leOfHex(hex) { return Buffer.from(hex, 'hex').reverse(); }
    var prefix = Buffer.concat([
        le32(versionInt),
        wordReverse(Buffer.from(params[1], 'hex')),
        root,
        leOfHex(params[7]),
        leOfHex(params[6])
    ]);
    for (var nonce = 0; nonce < 2000000; nonce++) {
        var header = Buffer.concat([prefix, le32(nonce)]);
        var h = sha256d(header);
        var val = BigInt('0x' + Buffer.from(h).reverse().toString('hex'));
        var shareDiff = Number(DIFF1 * 1000000n / val) / 1000000;
        if (shareDiff >= 0.002) {
            var nb = Buffer.alloc(4); nb.writeUInt32BE(nonce >>> 0, 0);
            return { en1: en1, en2: en2, nTime: params[7], nonceHex: nb.toString('hex'), jobId: params[0] };
        }
    }
    throw new Error('grind exhausted');
}

(function testProcessShare() {
    var poolScript = util.addressToScript('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    var jm = new JobManager({
        coin: { algorithm: 'sha256', symbol: 'ITC', name: 'Interchained', reward: 'POW', txMessages: [] },
        poolAddressScript: poolScript,
        recipients: [],
        instanceId: 7
    });
    var now = Math.floor(Date.now() / 1000);
    var target = (DIFF1 * 1000n).toString(16).padStart(64, '0');
    var rpcData = {
        version: 536870912, // 0x20000000, sha256 tag
        previousblockhash: '00000000000000000000000000000000000000000000000000000000deadbeef'.slice(-64),
        transactions: [],
        coinbaseaux: { flags: '' },
        coinbasevalue: 2408823100,
        bits: '1f0fffff',
        target: target,
        curtime: now - 10,
        mintime: now - 600,
        height: 914700
    };
    jm.processTemplate(rpcData);
    var DIFF = 0.001, MASK = 0x1fff8000;

    var baseVersion = 536870912;
    var rolledVersion = (baseVersion | (1 << 15)) >>> 0;

    // F: legacy unrolled share, no version arguments at all.
    var sF = grindShare(jm, baseVersion);
    var rF = jm.processShare(sF.jobId, null, DIFF, sF.en1, sF.en2, sF.nTime, sF.nonceHex, '127.0.0.1', 3333, 'w1');
    check('F unrolled share accepted (legacy path)', rF.result === true && !rF.error, JSON.stringify(rF.error));

    // C: rolled share + version parameter + negotiated mask.
    var sC = grindShare(jm, rolledVersion);
    var rC = jm.processShare(sC.jobId, null, DIFF, sC.en1, sC.en2, sC.nTime, sC.nonceHex, '127.0.0.1', 3333, 'w1', rolledVersion.toString(16), MASK);
    check('C rolled share accepted with version param', rC.result === true && !rC.error, JSON.stringify(rC.error));

    // D: the same rolled work WITHOUT the parameter -> cannot validate.
    var sD = grindShare(jm, rolledVersion);
    var rD = jm.processShare(sD.jobId, null, DIFF, sD.en1, sD.en2, sD.nTime, sD.nonceHex, '127.0.0.1', 3333, 'w1');
    check('D rolled share without param rejected [23]', !!rD.error && rD.error[0] === 23, JSON.stringify(rD.error));

    // E: a roll into the algo-tag bit must never validate, param or not.
    var tagVersion = (baseVersion | (1 << 13)) >>> 0;
    var sE = grindShare(jm, tagVersion);
    var rE = jm.processShare(sE.jobId, null, DIFF, sE.en1, sE.en2, sE.nTime, sE.nonceHex, '127.0.0.1', 3333, 'w1', tagVersion.toString(16), MASK);
    check('E tag-bit roll rejected even with param', !!rE.error && rE.error[0] === 23, JSON.stringify(rE.error));
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
