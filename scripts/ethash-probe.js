'use strict';
/*
 * ethash-probe.js -- minimal Ethash-dialect stratum probe (phase 2).
 *
 * Connects to the pool's Ethash stratum port (served by
 * lib/ethash/ethashPool.js, NOT the classic stratum server) and walks
 * the dialect handshake:
 *   mining.subscribe  -> session result (+ the current job as notify)
 *   mining.authorize  -> result true (username = payout address)
 *   mining.notify     -> [jobId, seedHash, headerHash, target, clean]
 *
 * Prints PROBE_SUBSCRIBED / PROBE_AUTHORIZED / PROBE_NOTIFY lines and
 * exits 0 only when all three were seen. Used by scripts/boot-proof.sh.
 *
 * Usage: node scripts/ethash-probe.js --port 13335 --user <address> [--timeout 60]
 */

var net = require('net');

function arg(name, dflt) {
    var i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

var port = parseInt(arg('port', '3335'), 10);
var user = arg('user', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
var timeoutMs = parseInt(arg('timeout', '60'), 10) * 1000;

var seen = { subscribed: false, authorized: false, notify: false };
var socket = net.connect(port, '127.0.0.1');
var buffer = '';
var finished = false;

function send(obj) { socket.write(JSON.stringify(obj) + '\n'); }

function finish(code, why) {
    if (finished) return;
    finished = true;
    console.log('PROBE_RESULT subscribed=' + seen.subscribed + ' authorized=' + seen.authorized +
        ' notify=' + seen.notify + (why ? ' (' + why + ')' : ''));
    try { socket.destroy(); } catch (e) { /* ignore */ }
    process.exit(code);
}

var timer = setTimeout(function () { finish(1, 'timeout'); }, timeoutMs);

socket.on('connect', function () {
    send({ id: 1, method: 'mining.subscribe', params: [] });
});

socket.on('data', function (chunk) {
    buffer += chunk.toString('utf8');
    var lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(function (line) {
        if (!line.trim()) return;
        var msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (msg.id === 1 && msg.result) {
            seen.subscribed = true;
            console.log('PROBE_SUBSCRIBED');
            send({ id: 2, method: 'mining.authorize', params: [user, 'x'] });
        } else if (msg.id === 2) {
            if (msg.result === true) {
                seen.authorized = true;
                console.log('PROBE_AUTHORIZED');
            } else {
                finish(1, 'authorize rejected: ' + JSON.stringify(msg.error));
            }
        } else if (msg.method === 'mining.notify') {
            seen.notify = true;
            console.log('PROBE_NOTIFY job=' + (msg.params && msg.params[0]));
        }
        if (seen.subscribed && seen.authorized && seen.notify) {
            clearTimeout(timer);
            finish(0);
        }
    });
});

socket.on('error', function (e) { finish(1, 'socket error: ' + e.message); });
socket.on('close', function () { if (!finished) finish(1, 'connection closed early'); });
