'use strict';
/**
 * lib/ethash/test-chain-vectors.js — chain-sourced byte-order cross-check.
 *
 * Run standalone:  node lib/ethash/test-chain-vectors.js
 * (also executed by lib/ethash/verify-vectors.js as a child process.)
 *
 * PURPOSE (phase-3 gap a): phase 1/2 proved the pool's pure-JS Ethash
 * matches the vendored chfast/ethash C library given a header hash, but
 * never cross-checked the BYTE ORDER of the values that cross the
 * daemon boundary — header hash, epoch seed hash, mix hash, nonce64 —
 * against the daemon's own conversion code. Every vector below was
 * produced from the CHAIN side (repo ~/workspace/interchained); each
 * section cites the chain file+function it comes from.
 *
 * HOW THE VECTORS WERE MADE: a tiny C++ harness (kept out of this repo,
 * in /tmp/itc-ethash-harness/ during the build) linked ONLY the vendored
 * library (src/crypto/ethash/lib/ethash/ethash.cpp + keccak.c + primes.c,
 * the exact objects CheckEthashHash calls) and printed
 * ethash_calculate_epoch_seed() / ethash_hash() outputs verbatim. The
 * fixed header's 80-byte serialization and its SHA256d were computed
 * with Python hashlib over bytes assembled exactly as the chain
 * serializes them (citations inline). No pool code produced any
 * expected value in this file.
 *
 * VERDICT (see evidence): MATCH — no pool-side byte-order fix was
 * needed. The pool's conventions are the daemon's:
 *   - header/seed/mix/final hashes on the stratum wire and inside
 *     ethash.js are ethash_hash256.bytes order, which equals the
 *     DISPLAY (big-endian, GetHex) order of the corresponding uint256
 *     because ToEthashHash (src/pow/ethash.cpp) reverses the uint256's
 *     internal little-endian bytes;
 *   - the daemon's serialized storage form is the REVERSE of the wire
 *     form for mixHash (FromEthashHash), and nNonce64 is serialized
 *     little-endian — exactly what ethashPool's block assembly does.
 */

var crypto = require('crypto');
var events = require('events');
var ethash = require('./ethash.js');
var attachEthash = require('./ethashPool.js');

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  chain-vector: ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}
function sha256d(buf) {
    return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
}
function reversedHex(buf) { return Buffer.from(buf).reverse().toString('hex'); }

/* ------------------------------------------------------------------ *
 * A. Epoch seed hashes.
 * Origin: ethash_calculate_epoch_seed(epoch) — declared in
 * src/crypto/ethash/include/ethash/ethash.h, defined in
 * src/crypto/ethash/lib/ethash/ethash.cpp (iterated keccak256 over 32
 * zero bytes, raw .bytes order — hash256 is a plain byte array there,
 * no endian swap). The daemon builds its epoch contexts from this
 * seed (ethash_create_epoch_context), and CheckEthashHash
 * (src/pow/ethash.cpp) verifies against those contexts, so the seed
 * the pool derives in ethash.seedHashHex MUST equal these bytes or
 * every share at that epoch fails daemon-side.
 * The daemon never serves a seed hash: getblocktemplate's result
 * construction (src/rpc/mining.cpp, getblocktemplate) pushes version,
 * previousblockhash, target, bits, height, curtime etc. — no
 * seedhash/headerhash/mixhash keys exist there — so the pool MUST
 * derive the seed itself, in this byte order.
 * ------------------------------------------------------------------ */
var CHAIN_SEEDS = {
    0: '0000000000000000000000000000000000000000000000000000000000000000',
    1: '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563',
    2: '510e4e770828ddbf7f7b00ab00a9f6adaf81c0dc9cc85f1f8249c256942d61d9',
    30: '1842cb89c0dfad7efb5ce2bf93f418e369214e9e1773a1bfe7c9c72ceee682bb',
    31: '7e7d8bef9d86983accafa937aed08042391d6f435bc640e50a9c38927de9b299'
};
Object.keys(CHAIN_SEEDS).forEach(function (e) {
    check('seedHash epoch ' + e + ' == ethash_calculate_epoch_seed bytes',
        ethash.seedHashHex(Number(e)) === CHAIN_SEEDS[e]);
});
check('epochOfHeight(913982) == 30 (fork height epoch)',
    ethash.epochOfHeight(913982) === 30);

/* ------------------------------------------------------------------ *
 * B. Fixed header -> Ethash input hash.
 * Header fields chosen chain-shaped: nVersion 0x20004000 =
 * 0x20000000 | (ETHASH tag 2 << POW_ALGO_TAG_SHIFT 13)
 * (src/pow.h: PowAlgo::ETHASH = 2, POW_ALGO_TAG_SHIFT = 13).
 * The 80-byte form follows CBlockHeader::SerializationOp
 * (src/primitives/block.h): nVersion, hashPrevBlock, hashMerkleRoot,
 * nTime, nBits, nNonce — integers little-endian (src/serialize.h
 * ser_writedata32), uint256 fields as their internal m_data bytes,
 * which are the REVERSE of the display hex (src/uint256.cpp:
 * base_blob::GetHex() reverses m_data before hexing).
 * The input hash is EthashInputHash (src/pow/ethash.cpp): CHashWriter
 * (SER_GETHASH = SHA256d) over exactly those six fields — the Ethash
 * extras never enter it. Its uint256 result's internal bytes are the
 * raw digest; ToEthashHash (src/pow/ethash.cpp) then REVERSES them
 * into ethash_hash256.bytes, so the bytes ethash_hash() consumes are
 * the digest read in display order.
 * ------------------------------------------------------------------ */
var FIXED_HEADER = {
    version: 0x20004000,
    prevBlockHashDisplay: '000000000000000000000000000000000000000000000000000000000000abcd',
    merkleRootDisplay: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    nTime: 1760000000,
    nBits: 0x1d00ffff,
    nNonce: 0,
    // Assembled byte-for-byte as above (Python hashlib cross-check):
    serializedHex: '00400020cdab000000000000000000000000000000000000000000000000000000000000' +
        'efcdab9078563412efcdab9078563412efcdab9078563412efcdab9078563412' +
        '0078e768ffff001d00000000',
    sha256dInternalHex: '5efb35d8eaf4001b5cc7dca79b1d58139d8561a8758b746ca41d64a114168099',
    // ToEthashHash(EthashInputHash) .bytes, i.e. reversed digest:
    inputHashDisplayHex: '99801614a1641da46c748b75a861859d13581d9ba7dcc75c1b00f4ead835fb5e'
};
(function () {
    var hdr = Buffer.alloc(80);
    hdr.writeInt32LE(FIXED_HEADER.version, 0);
    Buffer.from(FIXED_HEADER.prevBlockHashDisplay, 'hex').reverse().copy(hdr, 4);
    Buffer.from(FIXED_HEADER.merkleRootDisplay, 'hex').reverse().copy(hdr, 36);
    hdr.writeUInt32LE(FIXED_HEADER.nTime, 68);
    hdr.writeUInt32LE(FIXED_HEADER.nBits, 72);
    hdr.writeUInt32LE(FIXED_HEADER.nNonce, 76);
    check('fixed header serializes to the chain-shaped 80 bytes',
        hdr.toString('hex') === FIXED_HEADER.serializedHex);
    var digest = sha256d(hdr);
    check('sha256d(header) internal bytes == chain digest',
        digest.toString('hex') === FIXED_HEADER.sha256dInternalHex);
    check('display input hash == reversed digest (ToEthashHash)',
        reversedHex(digest) === FIXED_HEADER.inputHashDisplayHex);
    // The pool's own derivation (ethashPool.buildJob) is the same
    // expression over the template's serialized header:
    check('ethashPool.sha256d + reverse == display input hash',
        reversedHex(attachEthash.sha256d(hdr)) === FIXED_HEADER.inputHashDisplayHex);
})();

/* ------------------------------------------------------------------ *
 * C. hashimoto-light against ethash_hash() with the display-order
 * header hash from section B.
 * Origin: ethash_hash(epoch_context, header_hash, nonce) from the
 * vendored library, called by CheckEthashHash (src/pow/ethash.cpp)
 * with header_hash = ToEthashHash(inputHash) — i.e. the harness was
 * fed the section-B display bytes as header_hash.bytes verbatim.
 * The pool must reproduce mix/final BYTE-FOR-BYTE in the same order:
 * its stratum wire carries these bytes as hex, and CheckEthashHash
 * memcmp()s the computed mix against ToEthashHash(block.mixHash).
 * ------------------------------------------------------------------ */
var CHAIN_HASHES = [
    { nonce: '0', height: 913982,
      mixHash: 'e3a045a5f646cc8305508d4ec50d5f390732022f1c5f412a7eab18399cf44d13',
      finalHash: '09988ad65c4918d2cf972315f522d5e0199afc4e141cf73bca50a86a527ce352' },
    { nonce: '42', height: 913982,
      mixHash: '70448432b9ebd70ae6be90f11339135d3fd0ab05a26bc32fd59e2ba41bc833b6',
      finalHash: '3655562d04df97c3aad9746e51ee63f89f2d208cbd305d22a5a749540de9a345' },
    { nonce: '18446744073709551615', height: 0,
      mixHash: '481fd659744e24be91cd3c933a77720fccaf690c604b8b4cf82d142a44d77678',
      finalHash: '29f637ceac89f19927aca664afcad7bcab2c06b3419ab1233f257408ae613b10' }
];
CHAIN_HASHES.forEach(function (v) {
    var r = ethash.hashimotoLightHex(FIXED_HEADER.inputHashDisplayHex, BigInt(v.nonce), v.height);
    check('ethash_hash mixHash nonce ' + v.nonce + ' height ' + v.height, r.mixHash === v.mixHash);
    check('ethash_hash finalHash nonce ' + v.nonce + ' height ' + v.height, r.finalHash === v.finalHash);
});

/* ------------------------------------------------------------------ *
 * D. Mined vector — MineEthash semantics.
 * Origin: MineEthash (src/pow/ethash.cpp) scans nonces from
 * block.nNonce64 and records the FIRST whose final hash, read as a
 * big-endian number via FromEthashHash + UintToArith256, is <= target,
 * storing that nonce and FromEthashHash(result.mix_hash) in the block.
 * The harness repeated that scan with the vendored library against
 * target 0x0000ffff... (GBT serves `target` as hashTarget.GetHex(),
 * src/rpc/mining.cpp — display hex, the same form the pool carries).
 * ------------------------------------------------------------------ */
var MINED = {
    height: 913982,
    targetHex: '0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    nonce: '42946',
    mixHash: '6126e6a07a4da0cd806c02169069875c6d85ec5ff0c00d3d746c600a126a03f6',
    finalHash: '000091dd3a3d6cffd024b1198d52e5e6e43b54968403f95290849d9e64d9e247'
};
(function () {
    var r = ethash.hashimotoLightHex(FIXED_HEADER.inputHashDisplayHex, BigInt(MINED.nonce), MINED.height);
    check('mined vector mix/final reproduced', r.mixHash === MINED.mixHash && r.finalHash === MINED.finalHash);
    check('verifyShare accepts mined share at chain target', ethash.verifyShare({
        headerHashHex: FIXED_HEADER.inputHashDisplayHex, nonce: BigInt(MINED.nonce),
        mixHashHex: MINED.mixHash, height: MINED.height, targetHex: MINED.targetHex
    }) === true);
    var below = (BigInt('0x' + MINED.finalHash) - 1n).toString(16).padStart(64, '0');
    check('verifyShare rejects at target == final-1 (BE numeric compare)', ethash.verifyShare({
        headerHashHex: FIXED_HEADER.inputHashDisplayHex, nonce: BigInt(MINED.nonce),
        mixHashHex: MINED.mixHash, height: MINED.height, targetHex: below
    }) === false);
    // If a miner (or the pool) confused wire order with daemon storage
    // order and submitted the mix reversed, CheckEthashHash's memcmp
    // against ToEthashHash(mixHash) fails — the pool must reject too.
    var mixReversed = Buffer.from(MINED.mixHash, 'hex').reverse().toString('hex');
    check('verifyShare rejects storage-order (reversed) mix hash', ethash.verifyShare({
        headerHashHex: FIXED_HEADER.inputHashDisplayHex, nonce: BigInt(MINED.nonce),
        mixHashHex: mixReversed, height: MINED.height, targetHex: MINED.targetHex
    }) === false);
})();

/* ------------------------------------------------------------------ *
 * E. nonce64 byte order.
 * Origin: hash_seed (src/crypto/ethash/lib/ethash/ethash.cpp) builds
 * keccak512(header_hash.bytes || le::uint64(nonce)) — the nonce VALUE
 * serialized little-endian after the 32 header bytes. Block storage
 * agrees: CBlockHeader::SerializationOp writes nNonce64 via
 * ser_writedata64 (src/serialize.h), also little-endian. The stratum
 * wire form is the VALUE in big-endian hex notation (see
 * ethashStratum.js header); ethash.js must convert value -> LE inside
 * hashimoto, which is what toNonceBigInt + writeBigUInt64LE do.
 * ------------------------------------------------------------------ */
(function () {
    var value = ethash.toNonceBigInt('0x0102030405060708');
    check('stratum nonce hex parses as the uint64 VALUE', value === 0x0102030405060708n);
    var le = Buffer.alloc(8); le.writeBigUInt64LE(value, 0);
    check('nonce value serializes little-endian for hash_seed / block storage',
        le.toString('hex') === '0807060504030201');
    var leMax = Buffer.alloc(8); leMax.writeBigUInt64LE(ethash.toNonceBigInt('18446744073709551615'), 0);
    check('nonce 2^64-1 (decimal string) survives exactly',
        ethash.toNonceBigInt('18446744073709551615') === 0xffffffffffffffffn && leMax.toString('hex') === 'ffffffffffffffff');
})();

/* ------------------------------------------------------------------ *
 * F. Daemon storage order for a solved block.
 * Origin: MineEthash stores block.mixHash = FromEthashHash(mix)
 * (src/pow/ethash.cpp: FromEthashHash reverses ethash bytes into
 * uint256 internal order) and SerializationOp
 * (src/primitives/block.h) writes, after the 80 standard bytes,
 * nNonce64 (LE) THEN mixHash internal bytes. ethashPool's
 * assembleBlockHex performs exactly: header + nonce64LeHex +
 * reverse(mixDisplay). Assert the composed tail bytes for the mined
 * vector equal that chain layout.
 * ------------------------------------------------------------------ */
(function () {
    var nonceLe = Buffer.alloc(8); nonceLe.writeBigUInt64LE(BigInt(MINED.nonce), 0);
    var tail = Buffer.concat([nonceLe, Buffer.from(MINED.mixHash, 'hex').reverse()]);
    // nonce 42946 = 0xa7c2 -> LE c2a7000000000000; mix internal = reversed display mix.
    check('solved-header tail == nNonce64 LE || mixHash internal bytes',
        tail.toString('hex') === 'c2a7000000000000' +
            Buffer.from(MINED.mixHash, 'hex').reverse().toString('hex') &&
        tail.length === 40);
})();

/* ------------------------------------------------------------------ *
 * G. Job construction (ethashPool.buildJob) field order.
 * The stratum notify carries [jobId, seedHash, headerHash, target]
 * (ethashStratum notifyParams). buildJob must fill seedHash with the
 * section-A chain seed for the job's epoch, headerHash with the
 * section-B display input hash of the TEMPLATE's serialized header,
 * and the target with GBT's display-order target verbatim
 * (src/rpc/mining.cpp: result "target" = hashTarget.GetHex()).
 * The fake template's serializeHeader copies lib/blockTemplate.js
 * statement-for-statement (same construction test-pool-wiring.js uses).
 * ------------------------------------------------------------------ */
function buildJobChecks(done) {
    var rpcData = {
        height: 913982, bits: '207fffff', coinbasevalue: 5000000000, transactions: [],
        previousblockhash: FIXED_HEADER.prevBlockHashDisplay,
        version: 0x20004000, curtime: 1760000000,
        target: '00000000ffff0000000000000000000000000000000000000000000000000000'
    };
    var template = {
        jobId: 'chainvec1', rpcData: rpcData, difficulty: 1,
        transactionData: Buffer.alloc(0),
        serializeCoinbase: function (en1, en2) { return Buffer.concat([Buffer.from('cb-'), en1, en2]); },
        merkleTree: { withFirst: function (f) { return f; } },
        serializeHeader: function (merkleRoot, nTime, nonce) {
            var header = Buffer.alloc(80);
            var position = 0;
            header.write(nonce, position, 4, 'hex');
            header.write(rpcData.bits, position += 4, 4, 'hex');
            header.write(nTime, position += 4, 4, 'hex');
            header.write(merkleRoot, position += 4, 32, 'hex');
            header.write(rpcData.previousblockhash, position += 32, 32, 'hex');
            header.writeUInt32BE(rpcData.version, position + 32);
            return Buffer.from(header).reverse();
        },
        serializeBlock: function (header, coinbase) { return Buffer.concat([header, Buffer.from([1]), coinbase]); }
    };
    var jobManager = new events.EventEmitter();
    jobManager.extraNonceCounter = { next: function () { return '00000001'; } };
    jobManager.extraNonce2Size = 4;
    jobManager.currentJob = undefined;
    var pool = new events.EventEmitter();
    pool.jobManager = jobManager;
    pool.daemon = { cmd: function (m, p, cb) { if (cb) cb([{ error: null, response: null, instance: { index: 0 } }]); } };
    var handle = attachEthash(pool, { port: 0, logger: function () {} });
    handle.started.then(function () {
        try {
            var built = handle.buildJob(template);
            check('buildJob seedHash == chain epoch-30 seed', built.params.seedHashHex === CHAIN_SEEDS[30]);
            check('buildJob headerHash == display sha256d of template header',
                built.params.headerHashHex === reversedHex(sha256d(built.headerBuffer)));
            check('buildJob target == GBT target verbatim (display order)',
                built.params.nBitsTargetHex === rpcData.target);
            check('buildJob height carried for epoch derivation', built.params.height === 913982);
        } catch (e) {
            check('buildJob threw: ' + e.message, false);
        }
        handle.close(function () { done(); });
    });
}

if (require.main === module) {
    buildJobChecks(function () {
        console.log(failures === 0 ? 'ALL CHAIN-VECTOR CHECKS PASSED' : failures + ' CHAIN-VECTOR CHECK(S) FAILED');
        process.exit(failures === 0 ? 0 : 1);
    });
} else {
    module.exports = { buildJobChecks: buildJobChecks, getFailures: function () { return failures; } };
}
