'use strict';
/**
 * lib/ethash/ethash.js — pure-JS Ethash light verification for Interchained.
 *
 * Mirrors the daemon exactly (src/pow/ethash.cpp + vendored chfast/ethash
 * rev. 23 in src/crypto/ethash/):
 *  - Ethash input hash = SHA256d over ONLY the six standard header fields
 *    (80-byte Bitcoin serialization). Computing that hash is the caller's
 *    job; this module takes it as `headerHash` in DISPLAY (big-endian)
 *    byte order — the same byte order uint256 values use when they cross
 *    the Ethash boundary in CheckEthashHash (ToEthashHash reverses the
 *    internal little-endian bytes; the display hex IS the reversed order).
 *  - epoch = floor(height / 30000); hashimoto-light over the epoch cache.
 *  - A share is valid iff the computed mix hash EQUALS the submitted mix
 *    hash AND the final hash, read as a big-endian 256-bit number, is
 *    <= target. Comparing display-order byte strings lexicographically
 *    (Buffer.compare) is exactly that numeric comparison.
 *  - The nonce enters hashimoto as a uint64 serialized LITTLE-ENDIAN
 *    after the 32 header-hash bytes (chfast hash_seed). All internal
 *    32-bit words are little-endian, matching chfast on a LE host.
 *
 * Keccak is Keccak-256/512 (original padding 0x01, NOT NIST SHA3) from
 * the js-sha3 package — the same function as the vendored keccak.c.
 *
 * Performance note: pure JS. Epoch-0 cache generation is measured and
 * printed by lib/ethash/verify-vectors.js (expect seconds, ~17 MB RAM
 * per cached epoch). Caches are built lazily and memoized per epoch.
 * One hashimoto-light run needs 64 on-the-fly dataset items and takes
 * on the order of hundreds of ms in JS — fine for pool share checking
 * at human share rates, NOT a miner.
 */

var sha3 = require('js-sha3');
var keccak256 = sha3.keccak256;
var keccak512 = sha3.keccak512;

var EPOCH_LENGTH = 30000;
var CACHE_ITEM_SIZE = 64;        // ETHASH_LIGHT_CACHE_ITEM_SIZE
var DATASET_ITEM_SIZE = 128;     // ETHASH_FULL_DATASET_ITEM_SIZE
var NUM_DATASET_ACCESSES = 64;   // ETHASH_NUM_DATASET_ACCESSES
var DATASET_PARENTS = 256;       // full_dataset_item_parents
var CACHE_ROUNDS = 3;            // light_cache_rounds
var CACHE_INIT_SIZE = 1 << 24;   // light_cache_init_size (bytes)
var CACHE_GROWTH = 1 << 17;      // light_cache_growth (bytes)
var DATASET_INIT_SIZE = 1 << 30; // full_dataset_init_size (bytes)
var DATASET_GROWTH = 1 << 23;    // full_dataset_growth (bytes)
var FNV_PRIME = 0x01000193;

function keccak256Buf(buf) { return Buffer.from(keccak256.arrayBuffer(buf)); }
function keccak512Buf(buf) { return Buffer.from(keccak512.arrayBuffer(buf)); }

// FNV-1 over uint32 with wraparound, as in chfast ethash.cpp.
function fnv1(u, v) { return (Math.imul(u >>> 0, FNV_PRIME) ^ (v >>> 0)) >>> 0; }

function isPrime(n) {
    if (n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (var d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
    return true;
}
// ethash_find_largest_prime: largest prime <= upperBound.
function largestPrime(upperBound) {
    var n = upperBound;
    if (n < 2) return 0;
    if (n === 2) return 2;
    if (n % 2 === 0) n--;
    while (!isPrime(n)) n -= 2;
    return n;
}

function lightCacheNumItems(epoch) {
    return largestPrime(CACHE_INIT_SIZE / CACHE_ITEM_SIZE + epoch * (CACHE_GROWTH / CACHE_ITEM_SIZE));
}
function fullDatasetNumItems(epoch) {
    return largestPrime(DATASET_INIT_SIZE / DATASET_ITEM_SIZE + epoch * (DATASET_GROWTH / DATASET_ITEM_SIZE));
}

function epochOfHeight(height) { return Math.floor(height / EPOCH_LENGTH); }

// Seed hash: keccak256 applied `epoch` times starting from 32 zero bytes.
// Returns a 32-byte Buffer (display order).
function seedHashBuf(epoch) {
    var seed = Buffer.alloc(32);
    for (var i = 0; i < epoch; i++) seed = keccak256Buf(seed);
    return seed;
}
function seedHashHex(epoch) { return seedHashBuf(epoch).toString('hex'); }

// ---- light cache -----------------------------------------------------------

var cacheByEpoch = {};   // epoch -> { numItems, cache: Buffer(numItems*64), datasetNumItems, genMs }
var cacheGenMs = {};     // epoch -> measured generation time (ms)

function getCache(epoch) {
    var entry = cacheByEpoch[epoch];
    if (entry) return entry;
    var t0 = Date.now();
    var numItems = lightCacheNumItems(epoch);
    var cache = Buffer.alloc(numItems * CACHE_ITEM_SIZE);
    // Sequential keccak512 chain from the seed.
    var item = keccak512Buf(seedHashBuf(epoch));
    item.copy(cache, 0);
    for (var i = 1; i < numItems; i++) {
        item = keccak512Buf(item);
        item.copy(cache, i * CACHE_ITEM_SIZE);
    }
    // RandMemoHash-style rounds (in place, sequential — order matters).
    var tmp = Buffer.alloc(CACHE_ITEM_SIZE);
    for (var q = 0; q < CACHE_ROUNDS; q++) {
        for (var j = 0; j < numItems; j++) {
            var off = j * CACHE_ITEM_SIZE;
            var t = cache.readUInt32LE(off);
            var v = (t % numItems) * CACHE_ITEM_SIZE;
            var w = (((numItems + j - 1) % numItems)) * CACHE_ITEM_SIZE;
            for (var k = 0; k < CACHE_ITEM_SIZE; k++) tmp[k] = cache[v + k] ^ cache[w + k];
            keccak512Buf(tmp).copy(cache, off);
        }
    }
    var genMs = Date.now() - t0;
    cacheGenMs[epoch] = genMs;
    entry = { numItems: numItems, cache: cache, datasetNumItems: fullDatasetNumItems(epoch), genMs: genMs };
    cacheByEpoch[epoch] = entry;
    return entry;
}

// One 128-byte dataset item, generated from the light cache on the fly
// (interleaved pair of 64-byte items, exactly as calculate_dataset_item_1024).
function datasetItem(entry, index) {
    var cache = entry.cache, numCache = entry.numItems;
    var seed0 = (index * 2) >>> 0, seed1 = (seed0 + 1) >>> 0;
    var mix0 = Buffer.alloc(64), mix1 = Buffer.alloc(64);
    cache.copy(mix0, 0, (seed0 % numCache) * 64, (seed0 % numCache) * 64 + 64);
    cache.copy(mix1, 0, (seed1 % numCache) * 64, (seed1 % numCache) * 64 + 64);
    mix0.writeUInt32LE((mix0.readUInt32LE(0) ^ seed0) >>> 0, 0);
    mix1.writeUInt32LE((mix1.readUInt32LE(0) ^ seed1) >>> 0, 0);
    mix0 = keccak512Buf(mix0);
    mix1 = keccak512Buf(mix1);
    for (var j = 0; j < DATASET_PARENTS; j++) {
        var t0 = fnv1(seed0 ^ j, mix0.readUInt32LE((j % 16) * 4));
        var t1 = fnv1(seed1 ^ j, mix1.readUInt32LE((j % 16) * 4));
        var o0 = (t0 % numCache) * 64, o1 = (t1 % numCache) * 64;
        for (var w = 0; w < 16; w++) {
            mix0.writeUInt32LE(fnv1(mix0.readUInt32LE(w * 4), cache.readUInt32LE(o0 + w * 4)), w * 4);
            mix1.writeUInt32LE(fnv1(mix1.readUInt32LE(w * 4), cache.readUInt32LE(o1 + w * 4)), w * 4);
        }
    }
    return Buffer.concat([keccak512Buf(mix0), keccak512Buf(mix1)]);
}

// ---- hashimoto-light ---------------------------------------------------------

// nonce: BigInt, number, 8-byte LE Buffer, or string -> BigInt uint64.
// String form: '0x'-prefixed (or containing a-f letters) = hex, else decimal.
function toNonceBigInt(nonce) {
    if (typeof nonce === 'bigint') return nonce;
    if (typeof nonce === 'number') return BigInt(nonce);
    if (Buffer.isBuffer(nonce)) { // 8 bytes, little-endian storage form
        if (nonce.length !== 8) throw new Error('nonce buffer must be 8 bytes');
        return nonce.readBigUInt64LE(0);
    }
    if (typeof nonce === 'string') {
        if (nonce.startsWith('0x') || /[a-fA-F]/.test(nonce)) return BigInt('0x' + nonce.replace(/^0x/, ''));
        return BigInt(nonce);
    }
    throw new Error('unsupported nonce type: ' + typeof nonce);
}

// hashimotoLight(headerHashDisplayBytes /*32B Buffer*/, nonce, height)
//   -> { mixHash: Buffer(32), finalHash: Buffer(32) }  (display order)
// Also accepts (headerHash, nonce, {epoch}) instead of a height number.
function hashimotoLight(headerHashDisplayBytes, nonce, heightOrOpts) {
    var epoch;
    if (typeof heightOrOpts === 'number') epoch = epochOfHeight(heightOrOpts);
    else if (heightOrOpts && typeof heightOrOpts.epoch === 'number') epoch = heightOrOpts.epoch;
    else throw new Error('hashimotoLight needs a height (number) or {epoch}');
    if (!Buffer.isBuffer(headerHashDisplayBytes) || headerHashDisplayBytes.length !== 32)
        throw new Error('headerHash must be a 32-byte Buffer in display order');

    var entry = getCache(epoch);
    var nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(toNonceBigInt(nonce) & 0xffffffffffffffffn, 0);
    var seed = keccak512Buf(Buffer.concat([headerHashDisplayBytes, nonceBuf])); // hash_seed
    var seedInit = seed.readUInt32LE(0);

    // mix starts as {seed, seed} (32 LE words).
    var mix = Buffer.alloc(DATASET_ITEM_SIZE);
    seed.copy(mix, 0); seed.copy(mix, 64);
    var indexLimit = entry.datasetNumItems;
    for (var i = 0; i < NUM_DATASET_ACCESSES; i++) {
        var p = fnv1((i ^ seedInit) >>> 0, mix.readUInt32LE((i % 32) * 4)) % indexLimit;
        var data = datasetItem(entry, p);
        for (var w = 0; w < 32; w++)
            mix.writeUInt32LE(fnv1(mix.readUInt32LE(w * 4), data.readUInt32LE(w * 4)), w * 4);
    }
    // Compress mix into the 32-byte mix hash (FNV reduction, groups of 4).
    var mixHash = Buffer.alloc(32);
    for (var g = 0; g < 32; g += 4) {
        var h = fnv1(mix.readUInt32LE(g * 4), mix.readUInt32LE((g + 1) * 4));
        h = fnv1(h, mix.readUInt32LE((g + 2) * 4));
        h = fnv1(h, mix.readUInt32LE((g + 3) * 4));
        mixHash.writeUInt32LE(h, (g / 4) * 4);
    }
    var finalHash = keccak256Buf(Buffer.concat([seed, mixHash])); // hash_final
    return { mixHash: mixHash, finalHash: finalHash };
}

// verifyShare({headerHashHex, nonce, mixHashHex, height, targetHex}) -> boolean
// All hex is display (big-endian) order. Mirrors CheckEthashHash.
function verifyShare(opts) {
    var headerHash = Buffer.from(opts.headerHashHex, 'hex');
    var mixHash = Buffer.from(opts.mixHashHex, 'hex');
    var target = Buffer.from(opts.targetHex, 'hex');
    if (headerHash.length !== 32 || mixHash.length !== 32 || target.length !== 32) return false;
    var r = hashimotoLight(headerHash, opts.nonce, opts.height);
    if (!r.mixHash.equals(mixHash)) return false;
    return Buffer.compare(r.finalHash, target) <= 0;
}

module.exports = {
    EPOCH_LENGTH: EPOCH_LENGTH,
    keccak256: function (buf) { return keccak256Buf(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
    keccak512: function (buf) { return keccak512Buf(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
    seedHash: function (epoch) { return seedHashBuf(epoch); },
    seedHashHex: seedHashHex,
    epochOfHeight: epochOfHeight,
    lightCacheNumItems: lightCacheNumItems,
    fullDatasetNumItems: fullDatasetNumItems,
    getCacheInfo: function (epoch) { var e = getCache(epoch); return { numItems: e.numItems, datasetNumItems: e.datasetNumItems, genMs: e.genMs, bytes: e.cache.length }; },
    cacheGenMs: cacheGenMs,
    hashimotoLight: hashimotoLight,
    hashimotoLightHex: function (headerHashHex, nonce, height) {
        var r = hashimotoLight(Buffer.from(headerHashHex, 'hex'), nonce, height);
        return { mixHash: r.mixHash.toString('hex'), finalHash: r.finalHash.toString('hex') };
    },
    verifyShare: verifyShare,
    toNonceBigInt: toNonceBigInt
};
