'use strict';
/*
 * test-stratum-negotiation.js — flavour-negotiation regression test.
 *
 * Live failure this guards (2026-11-09): ethminer pointed at the pool
 * with the plain stratum+tcp:// scheme never confirmed
 * EthereumStratum/1.0.0, fell through its autodetect to the generic
 * STRATUM flavour, and parsed mining.notify in eth-proxy order
 * (header, seed) instead of stratum order (seed, header). Symptom on
 * the miner: "Epoch : -1" and the epoch seed hash displayed as the
 * job header, 0.00 hashrate forever.
 *
 * Root cause: ethminer confirms EthereumStratum/1.0.0 only when the
 * subscribe result's first element is a THREE-element array whose
 * third element is the string 'EthereumStratum/1.0.0' (the NiceHash
 * shape). The adapter sent two elements. This test pins the shape,
 * plus the fast method-not-found answers to the other flavours'
 * probes (mining.hello / eth_submitLogin) and the
 * mining.extranonce.subscribe ack ethminer sends after confirming.
 */
var net = require('net');
var EthashStratumServer = require('./ethashStratum');
var ethash = require('./ethash');

var failures = 0;
function check(name, cond, detail) {
    if (cond) console.log('PASS  ' + name);
    else { failures++; console.log('FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout waiting for ' + label)); }, ms); })
    ]);
}

function Client(port) {
    this.socket = net.connect(port, '127.0.0.1');
    this.buf = '';
    this.waiters = {};   // id -> resolve
    this.notifyWaiters = [];
    var _this = this;
    this.socket.setEncoding('utf8');
    this.socket.on('data', function (d) {
        _this.buf += d;
        var lines = _this.buf.split('\n');
        _this.buf = lines.pop();
        lines.forEach(function (line) {
            if (!line.trim()) return;
            var msg; try { msg = JSON.parse(line); } catch (e) { return; }
            if (msg.method === 'mining.notify') {
                _this.notifyWaiters = _this.notifyWaiters.filter(function (w) { return !w(msg.params); });
            } else if (msg.id !== undefined && _this.waiters[msg.id]) {
                var w = _this.waiters[msg.id]; delete _this.waiters[msg.id]; w(msg);
            }
        });
    });
}
Client.prototype.send = function (id, method, params) {
    var _this = this;
    return new Promise(function (resolve) {
        _this.waiters[id] = resolve;
        _this.socket.write(JSON.stringify({ id: id, method: method, params: params || [] }) + '\n');
    });
};
Client.prototype.waitNotify = function () {
    var _this = this;
    return new Promise(function (resolve) {
        _this.notifyWaiters.push(function (params) { resolve(params); return true; });
    });
};

async function main() {
    var server = new EthashStratumServer({});
    var HEADER = '04cdb821d75625c976ea7f2e6ee0c43668ce3fdb6e287a326804cc1e2b2dee28';
    var HEIGHT = 914500; // epoch 30
    server.setJob({
        jobId: '1',
        headerHashHex: HEADER,
        nBitsTargetHex: '00000eaaa9000000000000000000000000000000000000000000000000000000',
        height: HEIGHT,
        clean: true
    });
    await new Promise(function (resolve) { server.listen(0, resolve); });
    var port = server.server.address().port;
    check('server listening on ephemeral port', typeof port === 'number' && port > 0, 'port=' + port);

    var client = new Client(port);

    // 1) EthereumStratum/2 probe gets a fast error, not silence.
    var hello = await withTimeout(client.send(1, 'mining.hello', [{ proto: 'EthereumStratum/2.0.0' }]), 2000, 'mining.hello reply');
    check('mining.hello answered with an error (fast step-down)', !!hello.error, JSON.stringify(hello).slice(0, 120));

    // 2) eth-proxy probe gets a fast error too.
    var login = await withTimeout(client.send(2, 'eth_submitLogin', ['someone']), 2000, 'eth_submitLogin reply');
    check('eth_submitLogin answered with an error (fast step-down)', !!login.error, JSON.stringify(login).slice(0, 120));

    // 3) The subscribe result must carry the NiceHash confirmation shape.
    var notifyPromise = client.waitNotify();
    var sub = await withTimeout(client.send(3, 'mining.subscribe', ['ethminer 0.19.0-alpha.0', 'EthereumStratum/1.0.0']), 2000, 'subscribe reply');
    var r = sub.result || [];
    check('subscribe result[0] has exactly 3 elements', Array.isArray(r[0]) && r[0].length === 3, JSON.stringify(r[0]).slice(0, 160));
    check('subscribe result[0][2] is the protocol string', Array.isArray(r[0]) && r[0][2] === 'EthereumStratum/1.0.0', JSON.stringify(r[0]).slice(0, 160));
    check('subscribe result[0] pairs are set_difficulty + notify',
        Array.isArray(r[0]) && Array.isArray(r[0][0]) && r[0][0][0] === 'mining.set_difficulty' &&
        Array.isArray(r[0][1]) && r[0][1][0] === 'mining.notify');
    check('subscribe result[2] (extranonce2 size) still 0', r[2] === 0, 'got ' + r[2]);

    // 4) Notify follows in EthereumStratum/1.0.0 order: [job, seed, header, target, clean].
    var notify = await withTimeout(notifyPromise, 2000, 'mining.notify');
    check('notify seed slot carries the canonical epoch-30 seed', notify[1] === ethash.seedHashHex(30), notify[1]);
    check('notify header slot carries the job header', notify[2] === HEADER, notify[2]);

    // 5) extranonce.subscribe is acked, not dropped.
    var en = await withTimeout(client.send(4, 'mining.extranonce.subscribe', []), 2000, 'extranonce.subscribe reply');
    check('mining.extranonce.subscribe acked without error', en.error === null || en.error === undefined, JSON.stringify(en).slice(0, 120));

    // 6) authorize still works after the negotiation dance.
    var auth = await withTimeout(client.send(5, 'mining.authorize', ['itc1qaddress.worker', 'x']), 2000, 'authorize reply');
    check('authorize accepted', auth.result === true, JSON.stringify(auth).slice(0, 120));

    client.socket.destroy();
    server.close(function () {
        console.log(failures === 0 ? 'ALL NEGOTIATION CHECKS PASSED' : failures + ' NEGOTIATION CHECK(S) FAILED');
        process.exit(failures === 0 ? 0 : 1);
    });
}

main().catch(function (e) {
    console.log('FAIL  harness error: ' + e.message);
    process.exit(1);
});
