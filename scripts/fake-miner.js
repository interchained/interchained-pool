'use strict';
/*
 * fake-miner.js — minimal classic-stratum miner for the boot proof.
 *
 * Flow: TCP connect -> mining.subscribe -> mining.authorize ->
 * mining.notify -> brute-force extranonce2/nonce at the received
 * difficulty -> mining.submit. Exits 0 as soon as the pool answers a
 * submit with result=true; exits 1 on timeout.
 *
 * Header construction replicates lib/blockTemplate.js serializeHeader()
 * and lib/jobManager.js processShare() EXACTLY (verified byte-for-byte
 * against the real BlockTemplate during development):
 *   coinbase = coinbase1 + extranonce1 + extranonce2 + coinbase2
 *   merkleRoot = reverse( fold sha256d over merkleBranch from sha256d(coinbase) )
 *   header(pre) = nonce|bits|nTime|merkleRoot|prevhash|version(BE), then reversed
 *   hash = sha256d(header)            (sha256 / ethash-classic probe)
 *        | multi-hashing.yespower(header)  (yespower; the fork's yespower
 *          ignores the extra nTime argument jobManager passes — verified)
 *   shareDiff = diff1 / littleEndianValue(hash) * algoMultiplier
 *
 * Usage:
 *   node scripts/fake-miner.js --port 13333 --algo sha256  --user <ITC address>[.worker]
 *   node scripts/fake-miner.js --port 13334 --algo yespower --user <address> --timeout 300
 *   --algo ethash  = classic-stratum probe of the ethash port (phase-1 code
 *                    serves the classic listener there; shares are sha256d
 *                    classic shares, NOT hashimoto verification).
 */
var net = require('net');
var crypto = require('crypto');
var path = require('path');

function arg(name, dflt) {
    var i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
var PORT = parseInt(arg('port', '13333'), 10);
var ALGO = arg('algo', 'sha256');
var USER = arg('user', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
var TIMEOUT_MS = parseInt(arg('timeout', '180'), 10) * 1000;

var DIFF1 = BigInt('0x00000fffff000000000000000000000000000000000000000000000000000000');
var MULTIPLIER = (ALGO === 'yespower') ? 256 : 1;

var multiHashing = null;
if (ALGO === 'yespower') {
    try { multiHashing = require(path.join(__dirname, '..', 'node_modules', 'multi-hashing')); }
    catch (e) {
        try { multiHashing = require('multi-hashing'); }
        catch (e2) { console.error('MINER_FATAL cannot load multi-hashing: ' + e2.message); process.exit(2); }
    }
    if (typeof multiHashing.yespower !== 'function') {
        console.error('MINER_FATAL multi-hashing has no yespower export');
        process.exit(2);
    }
}

function sha256(buf) { var h = crypto.createHash('sha256'); h.update(buf); return h.digest(); }
function sha256d(buf) { return sha256(sha256(buf)); }
function reverseBuffer(b) { return Buffer.from(b).reverse(); }
function reverseByteOrder(buff) {
    var b = Buffer.from(buff);
    for (var i = 0; i < 8; i++) b.writeUInt32LE(b.readUInt32BE(i * 4), i * 4);
    return reverseBuffer(b);
}
function hashLittleEndianValue(hashBuf) {
    return BigInt('0x' + reverseBuffer(hashBuf).toString('hex'));
}
function shareDiffOf(hashBuf) {
    var v = hashLittleEndianValue(hashBuf);
    if (v === 0n) return Infinity;
    // float approximation via top 53 bits is unnecessary: Number(BigInt) is fine here
    return Number(DIFF1) / Number(v) * MULTIPLIER;
}
function hashHeader(headerBuf, nTimeInt) {
    if (ALGO === 'yespower') return multiHashing.yespower(headerBuf, nTimeInt);
    return sha256d(headerBuf);
}

/* ---- stratum client ---- */
var sock = net.createConnection(PORT, '127.0.0.1');
var buf = '';
var nextId = 1;
var extraNonce1 = null, extraNonce2Size = 4;
var difficulty = null;
var currentJob = null;
var authorized = false;
var submitIds = {};   // id -> true while awaiting result
var hashesTried = 0;
var deadline = Date.now() + TIMEOUT_MS;
var done = false;

function send(obj) { sock.write(JSON.stringify(obj) + '\n'); }
function finish(code, msg) {
    if (done) return; done = true;
    console.log(msg);
    try { sock.destroy(); } catch (e) {}
    process.exit(code);
}
setTimeout(function () { finish(1, 'MINER_TIMEOUT algo=' + ALGO + ' hashesTried=' + hashesTried); }, TIMEOUT_MS);

sock.on('connect', function () {
    console.log('MINER_CONNECTED port=' + PORT + ' algo=' + ALGO);
    send({ id: nextId++, method: 'mining.subscribe', params: ['itc-boot-proof/1.0'] });
    send({ id: nextId++, method: 'mining.authorize', params: [USER, 'x'] });
});
sock.on('error', function (e) { finish(1, 'MINER_SOCKET_ERROR ' + e.message); });
sock.on('close', function () { if (!done) finish(1, 'MINER_SOCKET_CLOSED'); });
sock.on('data', function (d) {
    buf += d.toString('utf8');
    var lines = buf.split('\n'); buf = lines.pop();
    lines.forEach(function (line) {
        if (!line.trim()) return;
        var msg; try { msg = JSON.parse(line); } catch (e) { return; }
        handle(msg);
    });
});

function handle(msg) {
    if (msg.method === 'mining.set_difficulty') {
        difficulty = msg.params[0];
        console.log('MINER_DIFFICULTY ' + difficulty);
        return;
    }
    if (msg.method === 'mining.notify') {
        currentJob = msg.params;
        console.log('MINER_NOTIFY jobId=' + currentJob[0] + ' algo=' + ALGO);
        if (authorized && extraNonce1) mineCurrentJob();
        return;
    }
    if (msg.id != null && submitIds[msg.id]) {
        delete submitIds[msg.id];
        if (msg.result === true) {
            finish(0, 'MINER_SHARE_ACCEPTED algo=' + ALGO + ' hashesTried=' + hashesTried);
        } else {
            console.log('MINER_SHARE_REJECTED ' + JSON.stringify(msg.error) + ' — continuing');
            if (currentJob) mineCurrentJob();
        }
        return;
    }
    if (msg.id != null && msg.result && Array.isArray(msg.result) && msg.result[1]) {
        extraNonce1 = msg.result[1];
        extraNonce2Size = msg.result[2];
        console.log('MINER_SUBSCRIBED extranonce1=' + extraNonce1 + ' extranonce2Size=' + extraNonce2Size);
        if (currentJob && authorized) mineCurrentJob();
        return;
    }
    if (msg.id != null && msg.result === true && !authorized) {
        authorized = true;
        console.log('MINER_AUTHORIZED user=' + USER);
        if (currentJob && extraNonce1) mineCurrentJob();
    }
}

var mining = false;
function mineCurrentJob() {
    if (mining || done) return;
    mining = true;
    var job = currentJob;
    var jobId = job[0], prevHashRev = job[1], cb1 = job[2], cb2 = job[3],
        merkleBranch = job[4], versionHex = job[5], bits = job[6], nTime = job[7];
    var prevOrig = reverseByteOrder(Buffer.from(prevHashRev, 'hex')).toString('hex');
    var nTimeInt = parseInt(nTime, 16);
    var diff = (difficulty == null ? 8 : difficulty);
    var en2Counter = 0;

    (function scanEn2() {
        if (done || currentJob !== job) { mining = false; return; }
        var en2 = Buffer.alloc(extraNonce2Size);
        en2.writeUInt32BE(en2Counter++, 0);
        var en2Hex = en2.toString('hex');
        var coinbase = Buffer.concat([Buffer.from(cb1, 'hex'), Buffer.from(extraNonce1, 'hex'), en2, Buffer.from(cb2, 'hex')]);
        var h = sha256d(coinbase);
        for (var i = 0; i < merkleBranch.length; i++) {
            h = sha256d(Buffer.concat([h, Buffer.from(merkleBranch[i], 'hex')]));
        }
        var merkleRoot = reverseBuffer(h).toString('hex');
        var nonce = 0;
        (function scanNonce() {
            if (done || currentJob !== job) { mining = false; return; }
            var BATCH = (ALGO === 'yespower') ? 200 : 20000;
            for (var k = 0; k < BATCH; k++, nonce++) {
                var nonceHex = nonce.toString(16).padStart(8, '0');
                var hdr = Buffer.alloc(80);
                hdr.write(nonceHex, 0, 4, 'hex');
                hdr.write(bits, 4, 4, 'hex');
                hdr.write(nTime, 8, 4, 'hex');
                hdr.write(merkleRoot, 12, 32, 'hex');
                hdr.write(prevOrig, 44, 32, 'hex');
                hdr.writeUInt32BE(parseInt(versionHex, 16), 76);
                var header = reverseBuffer(hdr);
                var hash = hashHeader(header, nTimeInt);
                hashesTried++;
                if (shareDiffOf(hash) >= diff) {
                    var id = nextId++;
                    submitIds[id] = true;
                    console.log('MINER_SUBMIT shareDiff>=' + diff + ' jobId=' + jobId +
                        ' en2=' + en2Hex + ' nonce=' + nonceHex + ' hashesTried=' + hashesTried);
                    send({ id: id, method: 'mining.submit', params: [USER, jobId, en2Hex, nTime, nonceHex] });
                    mining = false;
                    return;
                }
                if (nonce >= 0xffffffff) break;
            }
            if (Date.now() > deadline) { finish(1, 'MINER_TIMEOUT algo=' + ALGO + ' hashesTried=' + hashesTried); return; }
            if (nonce >= 0xffffffff) { setImmediate(scanEn2); return; }
            setImmediate(scanNonce);
            return;
        })();
    })();
}
