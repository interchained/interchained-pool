'use strict';
/**
 * scripts/test-stratum-keepalive.js — regression test for the periodic
 * "pool kicked my miner" disconnects. Run:
 *     node scripts/test-stratum-keepalive.js
 *
 * Pins three behaviours over REAL TCP sockets:
 *
 *   K1 (ethash, legacy dialect): after subscribe+authorize, with NO new
 *      block template ever installed, the server keeps the stream warm
 *      on its own — the current job is re-sent (same jobId, cleanFlag
 *      false) at the configured heartbeat cadence and the connection
 *      survives minutes of miner silence. Before the fix, jobs flowed
 *      only on new templates and an idle connection's NAT/firewall
 *      state expired silently. Also pins the mining.ping -> "pong"
 *      answer.
 *   K2 (ethash, canonical/Rigel dialect): same heartbeat, with the
 *      dialect gate intact — nothing before authorize, 4-param notify
 *      with cleanFlag false on heartbeats.
 *   K3 (classic stratum): a miner that submits NO shares for longer
 *      than connectionTimeout still receives the next broadcast job —
 *      sendMiningJob must not destroy its socket. Before the fix, the
 *      idle check in sendMiningJob destroyed exactly those miners on
 *      the next broadcast (every ~55s rebroadcast / new block), which
 *      is what "kicked every so often" looked like on the classic
 *      lanes.
 */

var net = require('net');
var EthashStratumServer = require('../lib/ethash/ethashStratum.js');
var stratum = require('../lib/stratum.js');

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function waitFor(pred, timeoutMs, label) {
    var started = Date.now();
    return new Promise(function (resolve, reject) {
        (function poll() {
            if (pred()) return resolve(true);
            if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for ' + label));
            setTimeout(poll, 15);
        })();
    });
}

var HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
var EASY_TARGET = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

function Miner(port) {
    this.socket = net.connect(port, '127.0.0.1');
    this.buffer = '';
    this.messages = [];
    this.closed = false;
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
        }
    });
    this.socket.on('close', function () { self.closed = true; });
    this.socket.on('error', function () {});
}
Miner.prototype.send = function (method, params) {
    var id = this.nextId++;
    this.socket.write(JSON.stringify({ id: id, method: method, params: params || [] }) + '\n');
    return id;
};
Miner.prototype.notifies = function () {
    return this.messages.filter(function (m) { return m.method === 'mining.notify'; });
};
Miner.prototype.response = function (id) {
    var found = this.messages.filter(function (m) { return m.id === id; });
    return found.length ? found[0] : null;
};
Miner.prototype.close = function () { try { this.socket.destroy(); } catch (e) {} };

async function ethashPart(label, subscribeParams, isNicehash) {
    var server = new EthashStratumServer({ heartbeatIntervalMs: 300 });
    await new Promise(function (r) { server.listen(0, r); });
    var port = server.server.address().port;
    server.setJob({
        jobId: 'hb-' + label, headerHashHex: HASH, nBitsTargetHex: EASY_TARGET,
        shareTargetHex: EASY_TARGET, height: 1000, clean: true
    });
    var miner = new Miner(port);
    var subId = miner.send('mining.subscribe', subscribeParams);
    await waitFor(function () { return miner.response(subId); }, 3000, label + ' subscribe result');
    if (isNicehash) {
        check('K2 no job before authorize (dialect gate intact)',
            miner.notifies().length === 0, 'notifies=' + miner.notifies().length);
    }
    var authId = miner.send('mining.authorize', ['itc1qtestworker.' + label, 'x']);
    /* Legacy sends the current job on subscribe AND on authorize (both
       with the job's own clean flag); canonical sends it once, on
       authorize. Wait for all of those, settle, THEN baseline — only
       notifies after this point may be counted as heartbeats. */
    var initialJobs = isNicehash ? 1 : 2;
    await waitFor(function () {
        var r = miner.response(authId);
        return r && r.result === true && miner.notifies().length >= initialJobs;
    }, 3000, label + ' authorize + first job');
    await sleep(120);
    var baseline = miner.notifies().length;

    /* Silence: no submits, no new templates. Heartbeats must arrive. */
    await waitFor(function () { return miner.notifies().length >= baseline + 2; },
        2500, label + ' heartbeat notifies');
    var beats = miner.notifies().slice(baseline);
    check('K' + (isNicehash ? '2' : '1') + ' heartbeat re-sends current job while miner is silent',
        beats.length >= 2, 'beats=' + beats.length);
    check('K' + (isNicehash ? '2' : '1') + ' heartbeat notifies carry cleanFlag=false, same jobId',
        beats.every(function (m) {
            var p = m.params;
            return p[0] === 'hb-' + label && p[p.length - 1] === false &&
                (!isNicehash || p.length === 4) && (isNicehash || p.length === 5);
        }), JSON.stringify(beats.length ? beats[0].params : null));
    check('K' + (isNicehash ? '2' : '1') + ' connection survives the silent window', !miner.closed);

    if (!isNicehash) {
        var pingId = miner.send('mining.ping', []);
        await waitFor(function () { return miner.response(pingId); }, 2000, 'ping reply');
        check('K1 mining.ping answered with pong',
            miner.response(pingId).result === 'pong', JSON.stringify(miner.response(pingId)));
    }
    miner.close();
    await new Promise(function (r) { server.close(r); });
}

async function classicPart() {
    var JOB = ['jobx', '00'.repeat(32), 'c1', 'c2', [], '20000000', '1e0eaaa9', '65000000', true];
    var server = new stratum.Server({
        ports: { '24333': { diff: 8 } },
        connectionTimeout: 1,             /* seconds — the shipped value is 600 */
        jobRebroadcastTimeout: 55,
        banning: { enabled: false },
        tcpProxyProtocol: false
    }, function (ip, port, user, pass, cb) { cb({ error: null, authorized: true }); });
    await new Promise(function (r) { server.on('started', r); });
    server.on('client.connected', function (client) {
        client.on('subscription', function (params, resultCallback) {
            resultCallback(null, 'aabbccdd', 4);
            client.sendDifficulty(8);
            client.sendMiningJob(JOB);
        });
    });
    var miner = new Miner(24333);
    var subId = miner.send('mining.subscribe', ['keepalive-test/1.0']);
    await waitFor(function () { return miner.response(subId); }, 3000, 'classic subscribe');
    var authId = miner.send('mining.authorize', ['itc1qtestworker.classic', 'x']);
    await waitFor(function () {
        var r = miner.response(authId);
        return r && r.result === true && miner.notifies().length >= 1;
    }, 3000, 'classic authorize + first job');
    var baseline = miner.notifies().length;

    /* The miner now goes quiet for >2x connectionTimeout, submitting
       nothing. Broadcasts during that silence must NOT kill it. */
    await sleep(1200);
    server.broadcastMiningJobs(JOB);
    await sleep(1200);
    server.broadcastMiningJobs(JOB);
    await waitFor(function () { return miner.notifies().length >= baseline + 2; },
        2500, 'classic jobs after idle window');
    check('K3 silent miner survives broadcasts past connectionTimeout',
        !miner.closed && miner.notifies().length >= baseline + 2,
        'closed=' + miner.closed + ' notifies=' + miner.notifies().length + '/' + (baseline + 2));
    miner.close();
}

(async function main() {
    try {
        await ethashPart('legacy', ['ethminer/0.19.0-alpha.0'], false);
        await ethashPart('rigel', ['Rigel/1.23.2'], true);
        await classicPart();
    } catch (e) {
        check('suite completed without timeout/error', false, e.message);
    }
    console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
    process.exit(failures ? 1 : 0);
})();
