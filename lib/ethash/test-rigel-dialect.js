'use strict';
/*
 * test-rigel-dialect.js — canonical EthereumStratum/1.0.0 (NiceHash)
 * dialect regression test for Rigel clients.
 *
 * Live failure this guards (2026-11-09): Rigel 1.23.2 on the V100
 * connected to the pool's Ethash port, GPU healthy, but never hashed:
 * pool table showed Latency n/a, Diff n/a, no job in the log. The
 * adapter spoke only its legacy hybrid dialect — Bitcoin-shaped
 * subscribe result, NO mining.set_difficulty anywhere, and a 5-param
 * mining.notify whose 4th slot carries the share target where the
 * canonical dialect puts the boolean clean flag. A strict
 * EthereumStratum/1.0.0 client cannot build a session from that.
 *
 * This test drives the standalone server over real TCP with a
 * Rigel-identified client and pins the canonical shapes:
 *   R1 subscribe result is exactly [ ["mining.notify", sessionId,
 *      "EthereumStratum/1.0.0"], extranonce ] with a 2-byte extranonce.
 *   R2 no mining.notify is sent before authorize.
 *   R3 after authorize, mining.set_difficulty arrives BEFORE the
 *      first mining.notify, carrying the exact difficulty double for
 *      the job's share target (spec diff-1 = 0x00000000ffff0000...).
 *   R4 mining.notify has exactly 4 params [jobId, seed, header, clean].
 *   R5 when a new job's share target changes, set_difficulty is resent
 *      (new value) before that job's notify.
 *   R6 a canonical 3-param submit [worker, jobId, nonceSegment] is
 *      verified: the pool reconstructs nonce = extranonce||segment,
 *      accepts a share that meets the target, and the 'share' event
 *      carries the full nonce64 / nonce64LeHex and the pool-computed
 *      mix hash — the exact fields ethashPool.js block assembly uses.
 *   R7 a legacy client on the same server is unaffected: historical
 *      subscribe result, 5-param notify, and NO set_difficulty (the
 *      conformance suite's C5 still holds).
 *
 * The expected share values are computed in-process with the same
 * ethash.js the server verifies with (epoch-0 job, so the first
 * hashimoto-light run builds the light cache — allow seconds).
 */

var net = require('net');
var EthashStratumServer = require('./ethashStratum');
var ethash = require('./ethash');

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var HEADER = '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563'; // test-vectors V4 header (epoch 0)
var HEIGHT = 15000;
var EASY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
var DEFAULT_TARGET = '000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
var ETH_DIFF1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
function expectedDiff(targetHex) { return Number(ETH_DIFF1) / Number(BigInt('0x' + targetHex)); }

function Client(port) {
    this.socket = net.connect(port, '127.0.0.1');
    this.buffer = '';
    this.messages = [];
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
Client.prototype.responseTo = function (id, what, timeoutMs) {
    return this.waitFor(function (m) { return m.id === id && ('result' in m); }, what || ('response ' + id), timeoutMs);
};
Client.prototype.close = function () { try { this.socket.destroy(); } catch (e) {} };

async function main() {
    var server = new EthashStratumServer({});
    var shareEvents = [];
    server.on('share', function (worker, jobId, isValid, isBlock, data) {
        shareEvents.push({ worker: worker, jobId: jobId, isValid: isValid, isBlock: isBlock, data: data });
    });
    await new Promise(function (res) { server.listen(0, res); });
    var port = server.server.address().port;
    console.log('rigel dialect test on 127.0.0.1:' + port);

    server.setJob({
        jobId: '2f', headerHashHex: HEADER, nBitsTargetHex: EASY,
        shareTargetHex: DEFAULT_TARGET, height: HEIGHT, clean: true
    });

    /* ---- Rigel client: subscribe shapes ------------------------------ */
    var rig = new Client(port);
    var subId = rig.send('mining.subscribe', ['Rigel/1.23.2', 'EthereumStratum/1.0.0']);
    var sub = await rig.responseTo(subId, 'rigel subscribe result');
    check('R1 subscribe result has exactly 2 elements',
        Array.isArray(sub.result) && sub.result.length === 2, JSON.stringify(sub.result));
    check('R1 result[0] is the flat [mining.notify, session, EthereumStratum/1.0.0] triple',
        Array.isArray(sub.result[0]) && sub.result[0].length === 3 &&
        sub.result[0][0] === 'mining.notify' && typeof sub.result[0][1] === 'string' &&
        sub.result[0][2] === 'EthereumStratum/1.0.0');
    var extranonce = sub.result[1];
    check('R1 extranonce is 2 bytes (4 hex chars)',
        typeof extranonce === 'string' && /^[0-9a-f]{4}$/.test(extranonce), extranonce);

    await sleep(300);
    check('R2 no mining.notify before authorize',
        rig.messages.filter(function (m) { return m.method === 'mining.notify'; }).length === 0);

    var enId = rig.send('mining.extranonce.subscribe', []);
    var en = await rig.responseTo(enId, 'extranonce.subscribe ack');
    check('extranonce.subscribe acked true', en.result === true);

    /* ---- authorize: difficulty first, then canonical notify ---------- */
    var authId = rig.send('mining.authorize', ['itc1qtestaddress.v100', 'x']);
    var auth = await rig.responseTo(authId, 'rigel authorize result');
    check('authorize accepted', auth.result === true && auth.error === null);

    var diffMsg = await rig.waitFor(function (m) { return m.method === 'mining.set_difficulty'; }, 'set_difficulty');
    var notify = await rig.waitFor(function (m) { return m.method === 'mining.notify'; }, 'rigel notify');
    var authIdx = rig.messages.indexOf(auth);
    check('R3 set_difficulty arrives after authorize and before first notify',
        rig.messages.indexOf(diffMsg) > authIdx && rig.messages.indexOf(diffMsg) < rig.messages.indexOf(notify));
    check('R3 set_difficulty value is the exact double for the job share target',
        Array.isArray(diffMsg.params) && diffMsg.params.length === 1 &&
        Math.abs(diffMsg.params[0] - expectedDiff(DEFAULT_TARGET)) < 1e-15,
        String(diffMsg.params && diffMsg.params[0]));
    check('R4 notify has exactly 4 params [jobId, seed, header, clean]',
        Array.isArray(notify.params) && notify.params.length === 4, JSON.stringify(notify.params));
    check('R4 notify job/seed/header/clean values',
        notify.params[0] === '2f' && notify.params[1] === '0'.repeat(64) &&
        notify.params[2] === HEADER && notify.params[3] === true);

    /* ---- new job with a different target: difficulty resent ---------- */
    server.setJob({
        jobId: '30', headerHashHex: HEADER, nBitsTargetHex: EASY,
        shareTargetHex: EASY, height: HEIGHT, clean: true
    });
    var diff2 = await rig.waitFor(function (m) {
        return m.method === 'mining.set_difficulty' && m !== diffMsg;
    }, 'resent set_difficulty');
    var notify2 = await rig.waitFor(function (m) {
        return m.method === 'mining.notify' && m.params[0] === '30';
    }, 'notify for job 30');
    check('R5 set_difficulty resent (new value) before the new job notify',
        rig.messages.indexOf(diff2) < rig.messages.indexOf(notify2) &&
        Math.abs(diff2.params[0] - expectedDiff(EASY)) < 1e-24,
        String(diff2.params && diff2.params[0]));

    /* ---- canonical 3-param submit ------------------------------------ */
    var segment = '000000000001'; // 6 bytes; full nonce = extranonce || segment
    var fullNonceHex = extranonce + segment;
    var nonce = BigInt('0x' + fullNonceHex);
    var expected = ethash.hashimotoLight(Buffer.from(HEADER, 'hex'), nonce, HEIGHT);
    var subShareId = rig.send('mining.submit', ['itc1qtestaddress.v100', '30', segment]);
    var subShare = await rig.responseTo(subShareId, 'rigel submit response', 60000);
    check('R6 canonical submit accepted (result true, error null)',
        subShare.result === true && subShare.error === null, JSON.stringify(subShare));
    var ev = shareEvents.filter(function (e) { return e.jobId === '30' && e.isValid; })[0];
    check('R6 share event: valid + block candidate under easy network target',
        !!ev && ev.isValid === true && ev.isBlock === true);
    check('R6 share event: nonce64 is the reconstructed full nonce',
        !!ev && ev.data.nonce64 === nonce.toString(10), ev && ev.data.nonce64);
    var le = Buffer.alloc(8); le.writeBigUInt64LE(nonce, 0);
    check('R6 share event: nonce64LeHex is the LE storage form',
        !!ev && ev.data.nonce64LeHex === le.toString('hex'), ev && ev.data.nonce64LeHex);
    check('R6 share event: mixHash is the pool-computed mix (miner sent none)',
        !!ev && ev.data.mixHash === expected.mixHash.toString('hex'), ev && ev.data.mixHash);
    check('R6 share event: finalHash matches hashimoto-light of the full nonce',
        !!ev && ev.data.finalHash === expected.finalHash.toString('hex'));

    /* ---- legacy client on the same server: untouched ------------------ */
    var leg = new Client(port);
    var lsubId = leg.send('mining.subscribe', ['lolMiner/1.87', 'EthereumStratum/1.0.0']);
    var lsub = await leg.responseTo(lsubId, 'legacy subscribe result');
    check('R7 legacy subscribe result keeps the historical 3-element shape',
        Array.isArray(lsub.result) && lsub.result.length === 3 && lsub.result[2] === 0 &&
        Array.isArray(lsub.result[0]) && lsub.result[0][0][0] === 'mining.set_difficulty');
    var lnotify = await leg.waitFor(function (m) { return m.method === 'mining.notify'; }, 'legacy notify');
    check('R7 legacy notify keeps 5 params with target in slot 4',
        Array.isArray(lnotify.params) && lnotify.params.length === 5 &&
        lnotify.params[3] === EASY && lnotify.params[4] === true);
    await sleep(300);
    check('R7 legacy client received NO set_difficulty',
        leg.messages.filter(function (m) { return m.method === 'mining.set_difficulty'; }).length === 0);

    rig.close(); leg.close();
    await new Promise(function (res) { server.close(res); });
    console.log(failures === 0 ? 'ALL RIGEL DIALECT CHECKS PASSED' : failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.log('FAIL  rigel dialect run aborted: ' + (e && e.message));
    process.exit(1);
});
