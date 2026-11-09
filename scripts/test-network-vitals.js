'use strict';
/*
 * test-network-vitals.js — dashboard chain vitals + stratum host.
 *
 * Two live bugs from 2026-11-09:
 *
 *  1. NETWORK.EXE showed every per-lane value as null while the height
 *     worked. The pool's poller read difficulty_<algo> /
 *     networkhashps_<algo> / connections off getblockchaininfo — but
 *     the daemon serves the per-lane fields ONLY from getmininginfo
 *     (src/rpc/mining.cpp) and the peer count from getnetworkinfo.
 *     These checks pin buildNetworkSnapshot to the daemon's real
 *     getmininginfo shape.
 *
 *  2. The dashboard's connect strings echoed window.location.hostname,
 *     so browsing via mine.interchained.org told miners to connect to
 *     mine.interchained.org. The stratum host now comes from
 *     /api/config (pool config / ITC_STRATUM_HOST), defaulting to
 *     stratum.interchained.org.
 *
 * Run: node scripts/test-network-vitals.js
 */

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');

var start = require('../start.js');
var createServer = require('../api/server').createServer;

var failures = 0;
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
    if (!cond) failures++;
}

/* A getmininginfo response exactly as the daemon builds it
   (src/rpc/mining.cpp: blocks, difficulty, difficulty_<algo>,
   networkhashps, networkhashps_<algo>, pooledtx, chain, warnings). */
var MINING_INFO = {
    blocks: 914575,
    difficulty: 1.090909942,
    difficulty_sha256: 123456.789,
    difficulty_yespower: 0.00390625,
    difficulty_ethash: 1.090909942,
    networkhashps: 987654321,
    networkhashps_sha256: 555000000,
    networkhashps_yespower: 12345,
    networkhashps_ethash: 432641976,
    pooledtx: 3,
    chain: 'main',
    warnings: ''
};

console.log('— buildNetworkSnapshot (getmininginfo shape)');
var snap = start.buildNetworkSnapshot(MINING_INFO, 8);
check('snapshot available', !!snap && snap.available === true);
check('height from blocks', snap && snap.height === 914575, snap && snap.height);
check('peers from getnetworkinfo connections', snap && snap.peers === 8, snap && snap.peers);
check('per-lane difficulty mapped',
    snap && snap.difficulty.sha256 === 123456.789 &&
    snap.difficulty.yespower === 0.00390625 &&
    snap.difficulty.ethash === 1.090909942,
    snap && JSON.stringify(snap.difficulty));
check('per-lane + total hashrate mapped',
    snap && snap.networkHashrate.total === 987654321 &&
    snap.networkHashrate.sha256 === 555000000 &&
    snap.networkHashrate.yespower === 12345 &&
    snap.networkHashrate.ethash === 432641976,
    snap && JSON.stringify(snap.networkHashrate));
check('null until the daemon answers with a numeric height',
    start.buildNetworkSnapshot(null, 8) === null &&
    start.buildNetworkSnapshot({}, 8) === null &&
    start.buildNetworkSnapshot({ blocks: '914575' }, 8) === null);
var partial = start.buildNetworkSnapshot({ blocks: 12, difficulty_ethash: 2.5 }, null);
check('missing fields stay null (never invented)',
    partial && partial.height === 12 && partial.peers === null &&
    partial.difficulty.sha256 === null && partial.difficulty.ethash === 2.5 &&
    partial.networkHashrate.total === null,
    partial && JSON.stringify(partial));

function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
        }).on('error', reject);
    });
}

async function main() {
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-netvitals-'));
    var dataFile = path.join(tmp, 'stats.json');
    var payoutsFile = path.join(tmp, 'payouts.json');

    console.log('— /api/network + /api/config over HTTP');
    var server = createServer({
        dataFile: dataFile,
        payoutsFile: payoutsFile,
        networkProvider: function () { return snap; },
        poolConfig: { address: 'itc1qhrtjdc02wgq0ary38prp6xel3mydcpjvkyhp4x', stratumHost: 'stratum.example.org', algos: {}, payments: {} }
    });
    await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
    var port = server.address().port;

    var net = JSON.parse((await httpGet(port, '/api/network')).body);
    check('/api/network serves the snapshot verbatim',
        net.available === true && net.height === 914575 && net.peers === 8 &&
        net.difficulty.ethash === 1.090909942 && net.networkHashrate.total === 987654321,
        JSON.stringify(net));
    var cfg = JSON.parse((await httpGet(port, '/api/config')).body);
    check('/api/config carries the configured stratum host',
        cfg.stratumHost === 'stratum.example.org', cfg.stratumHost);
    server.close();

    var server2 = createServer({
        dataFile: dataFile,
        payoutsFile: payoutsFile,
        poolConfig: { algos: {}, payments: {} }
    });
    await new Promise(function (res) { server2.listen(0, '127.0.0.1', res); });
    var port2 = server2.address().port;
    var cfg2 = JSON.parse((await httpGet(port2, '/api/config')).body);
    check('/api/config defaults the stratum host to stratum.interchained.org',
        cfg2.stratumHost === 'stratum.interchained.org', cfg2.stratumHost);
    var net2 = JSON.parse((await httpGet(port2, '/api/network')).body);
    check('no networkProvider -> /api/network stays honestly unavailable',
        net2.available === false, JSON.stringify(net2));
    server2.close();

    console.log(failures ? failures + ' NETWORK VITALS CHECK(S) FAILED' : 'ALL NETWORK VITALS CHECKS PASSED');
    process.exit(failures ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
