'use strict';
/**
 * Runnable check: node lib/ethash/verify-vectors.js
 * Asserts the pure-JS Ethash (lib/ethash/ethash.js) reproduces, byte-for-byte,
 * the reference vectors produced by the daemon's vendored chfast/ethash C
 * library (see test-vectors.js header), plus verifyShare boundary behaviour.
 * Exits non-zero on any mismatch. Prints cache-gen timing per epoch.
 */
var ethash = require('./ethash.js');
var ref = require('./test-vectors.js');

var failures = 0;
function check(name, cond) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
    if (!cond) failures++;
}

// Keccak sanity (well-known Keccak-256 values, also implied by seed hashes):
check('keccak256("") == c5d24601...', ethash.keccak256(Buffer.alloc(0)).toString('hex') ===
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
check('keccak256(32 zero bytes) == epoch-1 seed', ethash.keccak256(Buffer.alloc(32)).toString('hex') ===
    '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563');

for (var e in ref.epochs) {
    var epoch = parseInt(e, 10), meta = ref.epochs[e];
    check('seedHash epoch ' + epoch, ethash.seedHashHex(epoch) === meta.seedHash);
    check('lightCacheNumItems epoch ' + epoch, ethash.lightCacheNumItems(epoch) === meta.lightCacheNumItems);
    check('fullDatasetNumItems epoch ' + epoch, ethash.fullDatasetNumItems(epoch) === meta.fullDatasetNumItems);
}

ref.vectors.forEach(function (v, idx) {
    var t0 = Date.now();
    var r = ethash.hashimotoLightHex(v.headerHash, BigInt(v.nonce), v.height);
    var ms = Date.now() - t0;
    check('vector ' + idx + ' mixHash (height ' + v.height + ', nonce ' + v.nonce + ', ' + ms + 'ms incl. any cache gen)',
        r.mixHash === v.mixHash);
    check('vector ' + idx + ' finalHash', r.finalHash === v.finalHash);

    // verifyShare: target == final hash must pass (<=), wrong mix must fail,
    // target == final-1 must fail.
    check('vector ' + idx + ' verifyShare target==final', ethash.verifyShare({
        headerHashHex: v.headerHash, nonce: BigInt(v.nonce), mixHashHex: v.mixHash,
        height: v.height, targetHex: v.finalHash
    }) === true);
    var badMix = (v.mixHash[0] === '0' ? '1' : '0') + v.mixHash.slice(1);
    check('vector ' + idx + ' verifyShare wrong mix rejected', ethash.verifyShare({
        headerHashHex: v.headerHash, nonce: BigInt(v.nonce), mixHashHex: badMix,
        height: v.height, targetHex: v.finalHash
    }) === false);
    var below = (BigInt('0x' + v.finalHash) - 1n).toString(16).padStart(64, '0');
    check('vector ' + idx + ' verifyShare target==final-1 rejected', ethash.verifyShare({
        headerHashHex: v.headerHash, nonce: BigInt(v.nonce), mixHashHex: v.mixHash,
        height: v.height, targetHex: below
    }) === false);
});

console.log('cache gen times (ms): ' + JSON.stringify(ethash.cacheGenMs));

// Phase 3: chain-sourced byte-order cross-check (test-chain-vectors.js,
// vectors taken from the daemon's own ethash conversions — see that
// file's header). Run as a child so its epoch caches are independent.
var chainStatus = require('child_process').spawnSync(
    process.execPath, [require('path').join(__dirname, 'test-chain-vectors.js')],
    { stdio: 'inherit' }).status;
if (chainStatus !== 0) {
    console.log('FAIL  chain-vector cross-check (test-chain-vectors.js)');
    failures++;
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
