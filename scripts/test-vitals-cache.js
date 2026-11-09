'use strict';
/*
 * test-vitals-cache.js — the NEDB vitals cache (api/vitalsStore.js),
 * collector window persistence, and the /api/network + /api/history
 * fallbacks that let ANY server of the dashboard show them.
 *
 * Live bugs from 2026-11-09:
 *  - The NETWORK panel read UNAVAILABLE on the standalone-served page
 *    even while the pool's own API had the data: the snapshot existed
 *    only inside the pool process. Now the pool caches it in NEDB
 *    and mirrors it to a JSON file every other server reads (NEDB is
 *    single-opener — a second process cannot open the store while
 *    the pool holds it; that constraint is asserted below, not
 *    assumed away).
 *  - Hashrate history/charts reset on every reboot and page load:
 *    the collector's rolling windows were never persisted and the
 *    charts accumulated in the browser. Windows now ride the
 *    snapshot, and a 30 s sample series in NEDB seeds the charts.
 *
 * Needs nedb-engine resolvable (it is a package.json dependency; in a
 * bare checkout run with NODE_PATH pointing at an install that has
 * it). Run: node scripts/test-vitals-cache.js
 */

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var failures = 0;
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
    if (!cond) failures++;
}

var vitalsStoreModule = require('../api/vitalsStore.js');
var StatsCollector = require('../api/collector.js');
var createServer = require('../api/server.js').createServer;
var VITALS_PATH = path.join(__dirname, '..', 'api', 'vitalsStore.js');

var SNAP = {
    available: true,
    height: 914575,
    peers: 8,
    difficulty: { sha256: 123456.789, yespower: 0.00390625, ethash: 1.090909942 },
    networkHashrate: { total: 987654321, sha256: 555000000, yespower: 12345, ethash: 432641976 },
    updatedAt: 1794235075995
};
var T0 = 1794235000000;
var SAMPLES = [
    { t: T0, height: 914570, sha256: 100, yespower: 200, ethash: 300 },
    { t: T0 + 30000, height: 914571, sha256: 110, yespower: 210, ethash: 310 },
    { t: T0 + 60000, height: 914572, sha256: 120, yespower: 220, ethash: 320 }
];

function runChild(src, env) {
    var out = childProcess.execFileSync(process.execPath, ['-e', src], {
        env: Object.assign({}, process.env, env),
        encoding: 'utf8'
    });
    var lines = out.trim().split('\n');
    return lines[lines.length - 1];
}

function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
        }).on('error', reject);
    });
}

async function boot(opts) {
    var server = createServer(opts);
    await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
    return { server: server, port: server.address().port };
}

async function main() {
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-vitals-'));

    console.log('— vitals store persistence across processes (real NEDB engine)');
    var vitalsDir = path.join(tmp, 'vitals-nedb');
    var writerSrc =
        'var m = require(' + JSON.stringify(VITALS_PATH) + ');' +
        'var s = m.createVitalsStore({ dir: process.env.VITALS_DIR });' +
        's.writeNetwork(JSON.parse(process.env.SNAP));' +
        'var samples = JSON.parse(process.env.SAMPLES);' +
        'samples.forEach(function (x) { s.appendSample(x); });' +
        'console.log("samples=" + s.status().samples);';
    var wrote = runChild(writerSrc, {
        VITALS_DIR: vitalsDir,
        SNAP: JSON.stringify(SNAP),
        SAMPLES: JSON.stringify(SAMPLES)
    });
    check('writer process stored 3 samples', wrote === 'samples=3', wrote);

    var readerSrc =
        'var m = require(' + JSON.stringify(VITALS_PATH) + ');' +
        'var s = m.createVitalsStore({ dir: process.env.VITALS_DIR });' +
        'console.log(JSON.stringify({ network: s.readNetwork(), samples: s.listSamples({}), since: s.listSamples({ since: Number(process.env.SINCE) }) }));';
    var read = JSON.parse(runChild(readerSrc, { VITALS_DIR: vitalsDir, SINCE: String(T0 + 30000) }));
    check('network snapshot survives across processes, fields intact',
        !!read.network && read.network.available === true && read.network.height === 914575 &&
        read.network.peers === 8 && read.network.difficulty.ethash === 1.090909942 &&
        read.network.networkHashrate.total === 987654321 && read.network.updatedAt === 1794235075995,
        JSON.stringify(read.network));
    check('samples survive across processes, in time order',
        read.samples.length === 3 && read.samples[0].height === 914570 && read.samples[2].ethash === 320,
        JSON.stringify(read.samples));
    check('since filter keeps only newer samples',
        read.since.length === 2 && read.since[0].t === T0 + 30000, JSON.stringify(read.since));

    console.log('— NEDB single-opener constraint (the reason the mirror exists)');
    var heldDir = path.join(tmp, 'held-nedb');
    var held = vitalsStoreModule.createVitalsStore({ dir: heldDir });
    held.writeNetwork(SNAP);
    SAMPLES.forEach(function (x) { held.appendSample(x); });
    var lockError = null;
    try { vitalsStoreModule.createVitalsStore({ dir: heldDir }); } catch (e) { lockError = e; }
    check('second open of a held store is refused', !!lockError && /locked/i.test(lockError.message),
        lockError && lockError.message.slice(0, 60));

    console.log('— mirror file helpers');
    var mirrorFile = path.join(tmp, 'vitals-cache.json');
    check('writeMirrorFile ok', vitalsStoreModule.writeMirrorFile(mirrorFile, { network: SNAP, samples: SAMPLES }) === true);
    var mirror = vitalsStoreModule.readMirrorFile(mirrorFile);
    check('mirror round-trips network + samples',
        !!mirror && mirror.network.height === 914575 && mirror.samples.length === 3 && typeof mirror.mirroredAt === 'number');
    check('missing mirror reads as null', vitalsStoreModule.readMirrorFile(path.join(tmp, 'nope.json')) === null);

    console.log('— collector rolling windows persist across instances');
    var dataFile = path.join(tmp, 'stats.json');
    var c1 = new StatsCollector({ dataFile: dataFile });
    for (var i = 0; i < 3; i++) c1.recordShare('ethash', 'w1', { valid: true, difficulty: 2 });
    var hr1 = c1.getHashrate('ethash');
    check('hashrate positive with shares in window', hr1 > 0, hr1);
    c1._saveNow();
    var c2 = new StatsCollector({ dataFile: dataFile });
    var hr2 = c2.getHashrate('ethash');
    check('hashrate identical after reload (window restored)', hr2 === hr1, hr1 + ' -> ' + hr2);
    var w2 = c2.getAlgoStats('ethash').workersDetail.filter(function (w) { return w.worker === 'w1'; })[0];
    check('worker hashrate restored too', !!w2 && w2.hashrate === hr1, w2 && w2.hashrate);

    console.log('— API fallbacks over HTTP');
    var base = { dataFile: path.join(tmp, 'api-stats.json'), payoutsFile: path.join(tmp, 'api-payouts.json'), poolConfig: { algos: {}, payments: {} } };

    var s1 = await boot(Object.assign({}, base, { vitalsStore: held }));
    var netRes = JSON.parse((await httpGet(s1.port, '/api/network')).body);
    check('server with the store serves the network snapshot',
        netRes.available === true && netRes.height === 914575 && netRes.peers === 8, JSON.stringify(netRes));
    var hist = JSON.parse((await httpGet(s1.port, '/api/history')).body);
    check('/api/history serves the samples', hist.available === true && hist.samples.length === 3);
    var histSince = JSON.parse((await httpGet(s1.port, '/api/history?since=' + (T0 + 30000))).body);
    check('/api/history honours since', histSince.available === true && histSince.samples.length === 2);
    s1.server.close();

    var liveSnap = Object.assign({}, SNAP, { height: 914600 });
    var s2 = await boot(Object.assign({}, base, {
        vitalsStore: held,
        networkProvider: function () { return liveSnap; }
    }));
    var net2 = JSON.parse((await httpGet(s2.port, '/api/network')).body);
    check('injected provider still wins over the cache', net2.height === 914600, net2.height);
    s2.server.close();

    /* Foreign-process simulation: vitalsDir is the LOCKED store (held
       by this process), so the server's own open is refused and the
       mirror file is the only read path — the production standalone. */
    var s3 = await boot(Object.assign({}, base, { vitalsDir: heldDir, vitalsMirrorFile: mirrorFile }));
    var net3 = JSON.parse((await httpGet(s3.port, '/api/network')).body);
    check('locked store -> /api/network served from the mirror',
        net3.available === true && net3.height === 914575, JSON.stringify(net3));
    var hist3 = JSON.parse((await httpGet(s3.port, '/api/history')).body);
    check('locked store -> /api/history served from the mirror',
        hist3.available === true && hist3.samples.length === 3, JSON.stringify(hist3).slice(0, 100));
    s3.server.close();

    var s4 = await boot(Object.assign({}, base, {
        vitalsDir: path.join(tmp, 'empty-nedb'),
        vitalsMirrorFile: path.join(tmp, 'no-mirror.json')
    }));
    var net4 = JSON.parse((await httpGet(s4.port, '/api/network')).body);
    check('no data anywhere -> /api/network honestly unavailable', net4.available === false, JSON.stringify(net4));
    var hist4 = JSON.parse((await httpGet(s4.port, '/api/history')).body);
    check('empty store -> /api/history available with zero samples',
        hist4.available === true && hist4.samples.length === 0, JSON.stringify(hist4));
    s4.server.close();

    console.log(failures ? failures + ' VITALS CACHE CHECK(S) FAILED' : 'ALL VITALS CACHE CHECKS PASSED');
    process.exit(failures ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
