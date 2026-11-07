'use strict';
/**
 * scripts/test-ethash-stratum-conformance.js — protocol-shape conformance
 * for the pool's Ethash stratum dialect (lib/ethash/ethashStratum.js),
 * beyond the phase-1 smoke test. Run:
 *     node scripts/test-ethash-stratum-conformance.js
 *
 * Drives the STANDALONE server over real TCP (like the phase-1 smoke)
 * and asserts the wire conventions the dialect documents in the
 * ethashStratum.js header. Every check names the convention it pins:
 *
 *   C1 subscribe result shape: [[set_difficulty sub, notify sub],
 *      extranonce1, extranonce2Size=0] — Ethash has no extranonce;
 *      extranonce1 is a compatibility placeholder only.
 *   C2 mining.notify param layout: [jobId, seedHash(32B hex),
 *      headerHash(32B hex), shareTarget(32B hex), cleanFlag] — seed
 *      BEFORE header, target is the SHARE target, all hashes 32 bytes
 *      in display/ethash byte order.
 *   C3 mining.submit param layout: [worker, jobId, nonce(8B/16 hex),
 *      headerHash(32B), mixHash(32B)] — a conforming submit for a
 *      known test-vector share is accepted (result true).
 *   C4 nonce wire form is the uint64 VALUE in big-endian hex:
 *      nonce 123456789 travels as '00000000075bcd15' and the server
 *      reports nonce64='123456789', nonce64LeHex='15cd5b0700000000'
 *      (the little-endian storage form; see test-chain-vectors.js E).
 *   C5 difficulty conveyance: this dialect emits NO mining.set_difficulty
 *      and NO mining.set_target notifications — difficulty is fixed
 *      per job and conveyed ONLY by the notify target param (C2).
 *   C6 malformed submissions are rejected with [code, msg, null] and
 *      result false — unauthorized (24), bad sizes / header mismatch
 *      (20), unknown job (21), mix mismatch / low difficulty (23) —
 *      and the server neither crashes nor corrupts state: a valid
 *      share still verifies afterwards on a fresh connection.
 *   C7 a client that subscribes AFTER a job is installed receives the
 *      current job's notify immediately after its subscribe result.
 *
 * Share vectors are lib/ethash/test-vectors.js vectors (vendored C
 * library outputs) so acceptance is real hashimoto verification, not
 * a mock. First verification builds the epoch-0 light cache (~seconds).
 */

var net = require('net');
var EthashStratumServer = require('../lib/ethash/ethashStratum.js');
var vectors = require('../lib/ethash/test-vectors.js').vectors;

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}
function isHashHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s); }

/* Vector 0: headerHash 00..00, nonce 0, height 0.
 * Vector 4: headerHash 290d..., nonce 123456789, height 15000 (epoch 0). */
var V0 = vectors[0], V4 = vectors[4];
var EASY_NETWORK = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function Client(port) {
    this.socket = net.connect(port, '127.0.0.1');
    this.buffer = '';
    this.messages = [];      // every parsed message, in order
    this.waiters = [];
    this.nextId = 1;
    var self = this;
    this.socket.setEncoding('utf8');
    this.socket.on('data', function (d) {
        self.buffer += d;
        var idx;
        while ((idx = self.buffer.indexOf('\n')) !== -1) {
            var line = self.buffer.slice(0, idx); self.buffer = self.buffer.slice(idx + 1);
            if (!line) continue;
            var msg; try { msg = JSON.parse(line); } catch (e) { continue; }
            self.messages.push(msg);
            self.waiters = self.waiters.filter(function (w) {
                if (w.pred(msg)) { clearTimeout(w.timer); w.resolve(msg); return false; }
                return true;
            });
        }
    });
}
Client.prototype.send = function (method, params) {
    var id = this.nextId++;
    this.socket.write(JSON.stringify({ id: id, method: method, params: params }) + '\n');
    return id;
};
Client.prototype.sendRaw = function (line) { this.socket.write(line + '\n'); };
Client.prototype.waitFor = function (pred, what, timeoutMs) {
    var self = this;
    for (var i = 0; i < this.messages.length; i++)
        if (pred(this.messages[i])) return Promise.resolve(this.messages[i]);
    return new Promise(function (resolve, reject) {
        var w = { pred: pred, resolve: resolve, timer: setTimeout(function () {
            reject(new Error('timeout waiting for ' + what));
        }, timeoutMs || 30000) };
        self.waiters.push(w);
    });
};
Client.prototype.responseTo = function (id, what) {
    return this.waitFor(function (m) { return m.id === id && ('result' in m); }, what || ('response ' + id));
};
Client.prototype.close = function () { try { this.socket.destroy(); } catch (e) {} };

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
    var server = new EthashStratumServer({});
    var shareEvents = [];
    server.on('share', function (worker, jobId, isValid, isBlock, data) {
        shareEvents.push({ worker: worker, jobId: jobId, isValid: isValid, isBlock: isBlock, data: data });
    });
    await new Promise(function (res) { server.listen(0, res); });
    var port = server.server.address().port;
    console.log('ethash stratum conformance on 127.0.0.1:' + port);

    server.setJob({
        jobId: 'job-v0', headerHashHex: V0.headerHash, nBitsTargetHex: EASY_NETWORK,
        shareTargetHex: V0.finalHash, height: V0.height, clean: true
    });

    /* ---- C7 + C1 + C2: late subscriber gets job; shapes ------------- */
    var c1 = new Client(port);
    var subId = c1.send('mining.subscribe', ['conformance-test/1.0']);
    var sub = await c1.responseTo(subId, 'subscribe result');
    check('C1 subscribe: result is [subscriptions, extranonce1, 0]',
        Array.isArray(sub.result) && sub.result.length === 3 && sub.result[2] === 0 &&
        typeof sub.result[1] === 'string' && /^[0-9a-f]{8}$/.test(sub.result[1]),
        JSON.stringify(sub.result));
    check('C1 subscribe: subscriptions name set_difficulty + notify with one subscription id',
        Array.isArray(sub.result[0]) && sub.result[0].length === 2 &&
        sub.result[0][0][0] === 'mining.set_difficulty' && sub.result[0][1][0] === 'mining.notify' &&
        sub.result[0][0][1] === sub.result[0][1][1] && typeof sub.result[0][0][1] === 'string');
    check('C1 subscribe: error is null', sub.error === null);

    var notify = await c1.waitFor(function (m) { return m.method === 'mining.notify'; }, 'notify after subscribe');
    check('C7 late subscriber: notify follows subscribe without authorize', !!notify);
    check('C2 notify: param layout is [jobId, seedHash, headerHash, shareTarget, clean] (5 params)',
        Array.isArray(notify.params) && notify.params.length === 5, JSON.stringify(notify.params));
    check('C2 notify: jobId first', notify.params[0] === 'job-v0');
    check('C2 notify: seedHash is 32-byte hex and equals epoch-0 seed (all zero)',
        isHashHex(notify.params[1]) && notify.params[1] === '0'.repeat(64));
    check('C2 notify: headerHash is 32-byte hex and equals the job header hash',
        isHashHex(notify.params[2]) && notify.params[2] === V0.headerHash);
    check('C2 notify: target param is the 32-byte SHARE target',
        isHashHex(notify.params[3]) && notify.params[3] === V0.finalHash.toLowerCase());
    check('C2 notify: clean flag true for a clean job', notify.params[4] === true);

    /* ---- authorize -------------------------------------------------- */
    var authId = c1.send('mining.authorize', ['addrWorker1.rig1', 'x']);
    var auth = await c1.responseTo(authId, 'authorize result');
    check('authorize: result true, error null (no authorizeFn -> accepted)',
        auth.result === true && auth.error === null);

    /* ---- C6: unauthorized submit (fresh, never authorized) ---------- */
    var cAnon = new Client(port);
    cAnon.send('mining.subscribe', ['conformance-test/1.0']);
    await sleep(150);
    var anonId = cAnon.send('mining.submit', ['addrAnon', 'job-v0', '0000000000000000', V0.headerHash, V0.mixHash]);
    var anonResp = await cAnon.responseTo(anonId, 'unauthorized submit response');
    check('C6 unauthorized submit: result false, error code 24',
        anonResp.result === false && Array.isArray(anonResp.error) && anonResp.error[0] === 24,
        JSON.stringify(anonResp.error));
    cAnon.close();

    /* ---- C3: conforming submit accepted ------------------------------ */
    var okId = c1.send('mining.submit', ['addrWorker1.rig1', 'job-v0', '0000000000000000', V0.headerHash, V0.mixHash]);
    var okResp = await c1.responseTo(okId, 'valid submit response', 60000);
    check('C3 submit layout [worker, jobId, nonce16, headerHash, mixHash]: accepted (result true, error null)',
        okResp.result === true && okResp.error === null, JSON.stringify(okResp));
    var ev0 = shareEvents.filter(function (e) { return e.jobId === 'job-v0' && e.isValid; })[0];
    check('C3 share event: valid, and block-candidate under the easy network target',
        !!ev0 && ev0.isValid === true && ev0.isBlock === true);
    check('C3 share event: finalHash equals the vector final hash',
        !!ev0 && ev0.data.finalHash === V0.finalHash);

    /* ---- C4: nonce big-endian value convention ----------------------- */
    server.setJob({
        jobId: 'job-v4', headerHashHex: V4.headerHash, nBitsTargetHex: EASY_NETWORK,
        shareTargetHex: V4.finalHash, height: V4.height, clean: false
    });
    await c1.waitFor(function (m) {
        return m.method === 'mining.notify' && m.params[0] === 'job-v4';
    }, 'notify for job-v4');
    var nonceHex42 = BigInt(V4.nonce).toString(16).padStart(16, '0'); // '00000000075bcd15'
    var ok2Id = c1.send('mining.submit', ['addrWorker1.rig1', 'job-v4', nonceHex42, V4.headerHash, V4.mixHash]);
    var ok2Resp = await c1.responseTo(ok2Id, 'vector-4 submit response', 60000);
    check('C4 nonce as big-endian VALUE hex (' + nonceHex42 + '): accepted',
        ok2Resp.result === true, JSON.stringify(ok2Resp));
    var ev4 = shareEvents.filter(function (e) { return e.jobId === 'job-v4' && e.isValid; })[0];
    check('C4 share event: nonce64 decimal string is the value', !!ev4 && ev4.data.nonce64 === V4.nonce,
        ev4 && ev4.data.nonce64);
    check('C4 share event: nonce64LeHex is the little-endian storage form',
        !!ev4 && ev4.data.nonce64LeHex === '15cd5b0700000000', ev4 && ev4.data.nonce64LeHex);

    /* ---- C5: no set_difficulty / set_target notifications ------------ */
    var badMethods = c1.messages.filter(function (m) {
        return m.method === 'mining.set_difficulty' || m.method === 'mining.set_target';
    });
    check('C5 dialect: no mining.set_difficulty / mining.set_target notifications emitted',
        badMethods.length === 0, 'seen=' + badMethods.length);

    /* ---- C6: malformed submissions ----------------------------------- */
    async function expectReject(name, params, code) {
        var id = c1.send('mining.submit', params);
        var resp = await c1.responseTo(id, name, 60000);
        check(name, resp.result === false && Array.isArray(resp.error) && resp.error[0] === code &&
            resp.error[2] === null, JSON.stringify(resp.error));
    }
    await expectReject('C6 reject: nonce too short (need 16 hex) -> code 20',
        ['addrWorker1.rig1', 'job-v0', '00', V0.headerHash, V0.mixHash], 20);
    await expectReject('C6 reject: headerHash wrong size -> code 20',
        ['addrWorker1.rig1', 'job-v0', '0000000000000000', 'abcd', V0.mixHash], 20);
    await expectReject('C6 reject: mixHash wrong size -> code 20',
        ['addrWorker1.rig1', 'job-v0', '0000000000000000', V0.headerHash, 'abcd'], 20);
    await expectReject('C6 reject: unknown jobId -> code 21',
        ['addrWorker1.rig1', 'job-nope', '0000000000000000', V0.headerHash, V0.mixHash], 21);
    await expectReject('C6 reject: headerHash does not match job -> code 20',
        ['addrWorker1.rig1', 'job-v0', '0000000000000000', V4.headerHash, V0.mixHash], 20);
    await expectReject('C6 reject: empty params -> code 20 (no crash)',
        [], 20);
    var badMix = (V0.mixHash[0] === '0' ? '1' : '0') + V0.mixHash.slice(1);
    await expectReject('C6 reject: mix hash mismatch -> code 23',
        ['addrWorker1.rig1', 'job-v0', '0000000000000000', V0.headerHash, badMix], 23);

    // Low difficulty: same valid share, job whose share target is final-1.
    var belowTarget = (BigInt('0x' + V0.finalHash) - 1n).toString(16).padStart(64, '0');
    server.setJob({
        jobId: 'job-tight', headerHashHex: V0.headerHash, nBitsTargetHex: EASY_NETWORK,
        shareTargetHex: belowTarget, height: V0.height, clean: false
    });
    await c1.waitFor(function (m) { return m.method === 'mining.notify' && m.params[0] === 'job-tight'; }, 'notify job-tight');
    await expectReject('C6 reject: valid mix but below share target -> code 23 (low difficulty)',
        ['addrWorker1.rig1', 'job-tight', '0000000000000000', V0.headerHash, V0.mixHash], 23);

    /* ---- C6: garbage line kills only that connection ------------------ */
    var cBad = new Client(port);
    cBad.sendRaw('this is not json at all');
    await sleep(300);
    check('C6 garbage line: offending connection closed by server',
        cBad.socket.destroyed === true || cBad.socket.readable === false);
    cBad.close();

    /* ---- C6: server alive — fresh client, valid share still verifies -- */
    var c2 = new Client(port);
    var s2 = c2.send('mining.subscribe', ['conformance-test/1.0']);
    await c2.responseTo(s2, 'post-garbage subscribe');
    var a2 = c2.send('mining.authorize', ['addrWorker2', 'x']);
    await c2.responseTo(a2, 'post-garbage authorize');
    var v2 = c2.send('mining.submit', ['addrWorker2', 'job-v0', '0000000000000000', V0.headerHash, V0.mixHash]);
    var v2Resp = await c2.responseTo(v2, 'post-garbage valid submit', 60000);
    check('C6 server survives malformed traffic: valid share still accepted',
        v2Resp.result === true, JSON.stringify(v2Resp));

    c1.close(); c2.close();
    await new Promise(function (res) { server.close(res); });
    console.log(failures === 0 ? 'ALL STRATUM CONFORMANCE CHECKS PASSED' : failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.log('FAIL  conformance run aborted: ' + (e && e.message));
    process.exit(1);
});
