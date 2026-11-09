'use strict';
/**
 * lib/ethash/ethashPool.js — pool wiring for Interchained Ethash (phase 2,
 * lane 1). Exports attachEthash(pool, options).
 *
 * WHY THIS FILE EXISTS
 * The classic pool path cannot validate Ethash shares: jobManager.processShare
 * works in extranonce2/ntime/32-bit-nonce terms and algoProperties.ethash.hash()
 * is only the sha256d INPUT hash. Ethash shares (64-bit nonce + mix hash,
 * hashimoto-light verification) are handled by lib/ethash/ethashStratum.js +
 * lib/ethash/ethash.js. This module is the glue between that stratum server
 * and a classic pool object (lib/pool.js):
 *
 *   pool.jobManager --'newBlock'/'updatedBlock'(BlockTemplate)--> buildJob()
 *     headerHashHex = display-order sha256d of the 80-byte header built with the TEMPLATE'S OWN
 *       serializeCoinbase / merkleTree / serializeHeader, so the coinbase and
 *       merkle root miners hash over are this template's)
 *     seedHashHex   = ethash.seedHashHex(epochOfHeight(rpcData.height))
 *     nBitsTargetHex = rpcData.target if present, else the compact-nBits
 *       expansion of rpcData.bits (BigInt, same formula as
 *       util.bignumFromBitsHex — implemented locally, see DEPENDENCIES)
 *     -> stratumServer.setJob(...)
 *
 *   stratumServer --'share'(worker, jobId, isValid, isBlockCandidate, data)-->
 *     pool.emit('share', isValid, isBlockCandidate, shareData) with a
 *     classic-shaped shareData (see DIFFICULTY CONVENTION), plus the Ethash
 *     fields nonce64 / nonce64LeHex / mixHash / finalHash kept verbatim.
 *     On a block candidate the full block is assembled and submitted with
 *     pool.daemon.cmd('submitblock', [blockHex], ...) BEFORE/AFTER note:
 *     the share is emitted first (jobManager emits its share before pool.js
 *     finishes submission too, in the sense that submission outcome is not
 *     part of shareData); the daemon response is only logged. If submission
 *     assembly fails, the share is still emitted, with blockHex undefined
 *     and the failure logged.
 *
 * AUTHORIZATION
 * options.authorizeFn is passed straight into EthashStratumServer, which
 * (as of this lane) supports it with the classic signature
 * authorizeFn(ip, port, workerName, password, callback) and the classic
 * callback shape {error, authorized, disconnect} — exactly start.js's
 * authorizeFn semantics (username = payout address, optional ".worker"
 * suffix). If options.authorizeFn is omitted the stratum server keeps its
 * phase-1 behaviour: any username is accepted.
 *
 * BLOCK ASSEMBLY (candidate)
 *   fullHeader = templateHeader(80B)
 *              + nonce64 LE bytes (shareData.nonce64LeHex — daemon storage
 *                order for CBlockHeader::nNonce64)
 *              + mixHash in daemon storage order: the DISPLAY hex reversed
 *                byte-wise (uint256 internal/little-endian order, i.e.
 *                ToEthashHash's inverse in src/pow/ethash.cpp)
 *   blockHex   = template.serializeBlock(fullHeader, coinbaseBuffer)
 *                — the same call jobManager.processShare makes, so the
 *                tx-count varInt, transaction payload, vote data and POS
 *                suffix are exactly the template's. Fallback when a template
 *                has no serializeBlock: header + varInt(txCount+1) +
 *                coinbase + template.transactionData.
 *   blockHash  = reverse(sha256d(fullHeader)) as hex — CBlockHeader::GetHash()
 *                is sha256d over the serialized header INCLUDING the Ethash
 *                extras for post-fork Ethash-tagged headers
 *                (src/primitives/block.h SerializationOp / SerializeForHash),
 *                and the display form of a uint256 hash is the byte-reversed
 *                digest, exactly as jobManager's blockHasher produces for
 *                classic shares. CONFIRMED from the chain sources, not from
 *                a live daemon.
 *
 * COINBASE / HEADER CHOICES (Ethash miners supply no extranonce or ntime)
 *   extraNonce1: pool.jobManager.extraNonceCounter.next() when available
 *     (4 bytes), else 4 zero bytes; extraNonce2: zero bytes of
 *     jobManager.extraNonce2Size (default 4). Together they fill the
 *     template's 8-byte extranonce placeholder, so the coinbase is fully
 *     determined by the pool at job time.
 *   nTime: rpcData.curtime (UInt32BE hex, as getJobParams sends it);
 *   32-bit nNonce: 0. The Ethash solution lives entirely in nNonce64/mixHash.
 *   A warning is logged if rpcData.version's algo tag bits (13-14) do not
 *   decode as Ethash (2): the daemon tags GBT results when the pool requests
 *   algo "ethash" (pool.js getBlockTemplateRequest), and an untagged header
 *   would serialize WITHOUT the Ethash extras on the daemon and be rejected.
 *
 * DIFFICULTY CONVENTION (shareData)
 *   diff1 is the classic pool diff-1 target from lib/algoProperties.js
 *   (0x00000fffff0000...). difficulty = diff1 / shareTarget (the difficulty
 *   the miner was working at; stratum share target is fixed in this
 *   version), shareDiff = diff1 / finalHash (actual achieved, as a Number —
 *   classic shareDiff is a fixed-8 STRING; here a Number is emitted and
 *   shareDiffFixed8 carries the classic string form for drop-in consumers),
 *   blockDiff = diff1 / networkTarget, blockDiffActual = template.difficulty
 *   when the template carries one. All computed with BigInt -> Number, so
 *   trailing precision is float-grade, same as jobManager's bignum.toNumber().
 *
 * DEPENDENCIES
 * Node builtins + ./ethash.js + ./ethashStratum.js ONLY. Deliberately no
 * require of ../util.js / ../blockTemplate.js / bignum: those pull native /
 * unlisted modules (bignum, multi-hashing, bs58check, bitcoinjs-lib) that
 * are not loadable in every environment, and everything needed here
 * (sha256d, compact-bits expansion, varInt) is a few lines with crypto/BigInt.
 *
 * attachEthash(pool, options) -> handle
 *   options: { port (required, 0 = ephemeral), authorizeFn?, shareTargetHex?,
 *              logger? fn(severity, text), maxJobs? (default 16) }
 *   handle:  { server, jobs (Map jobId->entry), buildJob(template),
 *              registerJob(jobParams, template, context), feedTemplate(t, clean),
 *              port() (bound port or null), close(cb), detach() }
 *   Throws if pool.jobManager or pool.daemon is missing: attach AFTER the
 *   pool's JobManager exists (pool.start() creates it once the daemon is
 *   online). If jobManager.currentJob already exists it is fed immediately.
 *   The pool should be created with ports:{} so the classic stratum server
 *   binds nothing (lib/stratum.js iterates options.ports) and this server is
 *   the instance's only listener.
 */

var crypto = require('crypto');
var ethash = require('./ethash.js');
var EthashStratumServer = require('./ethashStratum.js');

var DIFF1_HEX = '00000fffff000000000000000000000000000000000000000000000000000000';
var DIFF1 = BigInt('0x' + DIFF1_HEX);

function sha256d(buf) {
    var first = crypto.createHash('sha256').update(buf).digest();
    return crypto.createHash('sha256').update(first).digest();
}
function reversedHex(buf) { return Buffer.from(buf).reverse().toString('hex'); }
function packUInt32BEHex(n) {
    var b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b.toString('hex');
}
function varIntBuffer(n) {
    if (n < 0xfd) return Buffer.from([n]);
    if (n <= 0xffff) { var b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b; }
    var c = Buffer.alloc(5); c[0] = 0xfe; c.writeUInt32LE(n, 1); return c;
}
// Compact nBits -> 256-bit target hex (display order, 64 chars).
// Same formula as util.bignumFromBitsBuffer: mantissa * 2^(8*(exponent-3)).
function targetHexFromBits(bits) {
    var bitsHex = (typeof bits === 'number')
        ? bits.toString(16).padStart(8, '0') : String(bits).toLowerCase();
    var buf = Buffer.from(bitsHex, 'hex');
    if (buf.length !== 4) throw new Error('nBits must be 4 bytes, got: ' + bits);
    var exponent = buf.readUInt8(0);
    var mantissa = BigInt('0x' + buf.slice(1).toString('hex'));
    var shift = 8n * (BigInt(exponent) - 3n);
    var target = shift >= 0n ? (mantissa << shift) : (mantissa >> (-shift));
    return target.toString(16).padStart(64, '0');
}
function difficultyOfTarget(targetHex) {
    var t = BigInt('0x' + targetHex);
    if (t === 0n) return Infinity;
    return Number(DIFF1) / Number(t);
}
function difficultyOfHash(hashHex) {
    var h = BigInt('0x' + hashHex);
    if (h === 0n) return Infinity;
    return Number(DIFF1) / Number(h);
}

function attachEthash(pool, options) {
    options = options || {};
    if (!pool || typeof pool.emit !== 'function')
        throw new TypeError('attachEthash: pool (an EventEmitter) is required');
    if (!pool.jobManager || typeof pool.jobManager.on !== 'function')
        throw new TypeError('attachEthash: pool.jobManager is required (attach after JobManager setup)');
    if (!pool.daemon || typeof pool.daemon.cmd !== 'function')
        throw new TypeError('attachEthash: pool.daemon.cmd is required');
    if (typeof options.port !== 'number')
        throw new TypeError('attachEthash: options.port (number) is required');

    var log = (typeof options.logger === 'function') ? options.logger : function (severity, text) {
        if (typeof pool.emit === 'function') pool.emit('log', severity, text);
        else console.log(severity + ': ' + text);
    };
    var maxJobs = (typeof options.maxJobs === 'number' && options.maxJobs > 0) ? options.maxJobs : 16;

    var server = new EthashStratumServer({
        shareTargetHex: options.shareTargetHex,
        authorizeFn: (typeof options.authorizeFn === 'function') ? options.authorizeFn : undefined
    });

    var jobs = new Map(); // jobId -> entry (insertion-ordered for pruning)

    function lookupClient(workerName) {
        if (!workerName) return null;
        for (var id in server.clients) {
            var c = server.clients[id];
            if (c && c.workerName === workerName) return c;
        }
        return null;
    }

    // ---- job construction -------------------------------------------------
    function buildJob(template) {
        if (!template || !template.rpcData)
            throw new Error('buildJob: template.rpcData is required');
        var rpcData = template.rpcData;
        if (typeof template.serializeCoinbase !== 'function' || typeof template.serializeHeader !== 'function')
            throw new Error('buildJob: template must provide serializeCoinbase/serializeHeader (BlockTemplate does)');

        var jm = pool.jobManager;
        var en1Hex = (jm.extraNonceCounter && typeof jm.extraNonceCounter.next === 'function')
            ? jm.extraNonceCounter.next() : '00000000';
        var en2Size = (typeof jm.extraNonce2Size === 'number') ? jm.extraNonce2Size : 4;
        var coinbaseBuffer = template.serializeCoinbase(
            Buffer.from(en1Hex, 'hex'), Buffer.alloc(en2Size));

        var coinbaseHash = sha256d(coinbaseBuffer);
        var merkleRootHex;
        if (template.merkleTree && typeof template.merkleTree.withFirst === 'function')
            merkleRootHex = reversedHex(template.merkleTree.withFirst(coinbaseHash));
        else
            merkleRootHex = reversedHex(coinbaseHash); // no steps: coinbase is the only tx

        var nTimeHex = packUInt32BEHex(rpcData.curtime || (Date.now() / 1000 | 0));
        var headerBuffer = template.serializeHeader(merkleRootHex, nTimeHex, '00000000');
        if (!Buffer.isBuffer(headerBuffer) || headerBuffer.length !== 80)
            throw new Error('buildJob: serializeHeader must return the 80-byte header, got ' +
                (headerBuffer && headerBuffer.length));

        // Ethash INPUT hash in DISPLAY order: EthashInputHash() returns a
        // uint256 whose internal bytes are the raw sha256d digest, and
        // ToEthashHash() reverses them — so the display hex ethash.js and
        // the stratum wire use is the byte-reversed sha256d digest (the
        // same reversal jobManager's blockHasher applies for block hashes).
        var headerHashHex = reversedHex(sha256d(headerBuffer));

        var networkTargetHex;
        if (rpcData.target) networkTargetHex = String(rpcData.target).toLowerCase().padStart(64, '0');
        else if (template.target && typeof template.target.toString === 'function' && !rpcData.bits)
            networkTargetHex = template.target.toString(16).padStart(64, '0');
        else networkTargetHex = targetHexFromBits(rpcData.bits);

        var tag = (typeof rpcData.version === 'number') ? ((rpcData.version >> 13) & 3) : null;
        if (tag !== null && tag !== 2)
            log('warning', 'ethash: template version ' + rpcData.version + ' has algo tag ' + tag +
                ' (expected 2/ethash) at height ' + rpcData.height +
                ' — daemon may reject a solved block; was getblocktemplate requested with algo "ethash"?');

        var params = {
            jobId: String(template.jobId),
            headerHashHex: headerHashHex,
            seedHashHex: ethash.seedHashHex(ethash.epochOfHeight(rpcData.height)),
            nBitsTargetHex: networkTargetHex,
            height: rpcData.height,
            clean: true
        };
        if (options.shareTargetHex) params.shareTargetHex = options.shareTargetHex;
        return {
            params: params,
            headerBuffer: headerBuffer,
            coinbaseBuffer: coinbaseBuffer,
            headerHashHex: headerHashHex,
            networkTargetHex: networkTargetHex
        };
    }

    function registerJob(params, template, context) {
        context = context || {};
        if (params.clean) jobs.clear();
        var entry = {
            jobId: String(params.jobId),
            template: template,
            headerBuffer: context.headerBuffer || null,
            coinbaseBuffer: context.coinbaseBuffer || null,
            headerHashHex: params.headerHashHex,
            networkTargetHex: params.nBitsTargetHex,
            shareTargetHex: (params.shareTargetHex || server.defaultShareTargetHex).toLowerCase(),
            height: params.height,
            blockReward: template && template.rpcData ? template.rpcData.coinbasevalue : undefined,
            templateDifficulty: template && typeof template.difficulty === 'number' ? template.difficulty : undefined
        };
        jobs.set(entry.jobId, entry);
        while (jobs.size > maxJobs) jobs.delete(jobs.keys().next().value); // prune oldest
        var installed = server.setJob(params);
        entry.shareTargetHex = installed.shareTargetHex;
        return entry;
    }

    function feedTemplate(template, clean) {
        try {
            var built = buildJob(template);
            built.params.clean = clean !== false;
            var entry = registerJob(built.params, template, built);
            log('debug', 'ethash: job ' + entry.jobId + ' height ' + entry.height +
                ' headerHash ' + entry.headerHashHex + ' target ' + entry.networkTargetHex);
            return entry;
        } catch (e) {
            log('error', 'ethash: failed to build job from template: ' + e.message);
            return null;
        }
    }

    function onNewBlock(template) { feedTemplate(template, true); }
    function onUpdatedBlock(template) { feedTemplate(template, false); }
    pool.jobManager.on('newBlock', onNewBlock);
    pool.jobManager.on('updatedBlock', onUpdatedBlock);

    // ---- block assembly + submission --------------------------------------
    function assembleBlockHex(entry, ethShareData) {
        if (!entry.headerBuffer || !entry.coinbaseBuffer)
            throw new Error('no header/coinbase stored for job ' + entry.jobId);
        var mixInternal = Buffer.from(ethShareData.mixHash, 'hex').reverse();
        var fullHeader = Buffer.concat([
            entry.headerBuffer,
            Buffer.from(ethShareData.nonce64LeHex, 'hex'),
            mixInternal
        ]); // 80 + 8 + 32 = 120 bytes
        var blockHex;
        if (entry.template && typeof entry.template.serializeBlock === 'function') {
            blockHex = entry.template.serializeBlock(fullHeader, entry.coinbaseBuffer).toString('hex');
        } else {
            var txCount = entry.template && entry.template.rpcData && Array.isArray(entry.template.rpcData.transactions)
                ? entry.template.rpcData.transactions.length : 0;
            var txData = (entry.template && Buffer.isBuffer(entry.template.transactionData))
                ? entry.template.transactionData : Buffer.alloc(0);
            blockHex = Buffer.concat([fullHeader, varIntBuffer(txCount + 1), entry.coinbaseBuffer, txData]).toString('hex');
        }
        var blockHash = reversedHex(sha256d(fullHeader));
        return { blockHex: blockHex, blockHash: blockHash, fullHeaderHex: fullHeader.toString('hex') };
    }

    function submitBlock(entry, assembled) {
        try {
            pool.daemon.cmd('submitblock', [assembled.blockHex], function (results) {
                var list = Array.isArray(results) ? results : [results];
                list.forEach(function (r) {
                    if (!r) return;
                    if (r.error) {
                        log('error', 'ethash: submitblock rpc error (daemon instance ' +
                            (r.instance && r.instance.index) + '): ' + JSON.stringify(r.error));
                    } else if (r.response === 'rejected') {
                        log('error', 'ethash: daemon rejected block candidate ' + assembled.blockHash +
                            ' at height ' + entry.height);
                    } else {
                        log('special', 'ethash: submitted block candidate ' + assembled.blockHash +
                            ' at height ' + entry.height + ' via submitblock: ' + JSON.stringify(r.response));
                    }
                });
            });
        } catch (e) {
            log('error', 'ethash: submitblock call failed: ' + e.message);
        }
    }

    // ---- share handling -----------------------------------------------------
    server.on('share', function (worker, jobId, isValid, isBlockCandidate, ethShareData) {
        ethShareData = ethShareData || {};
        var entry = jobs.get(String(jobId)) || null;
        var client = lookupClient(ethShareData.worker || worker);
        var finalHash = ethShareData.finalHash || null;
        var networkTargetHex = entry ? entry.networkTargetHex : (ethShareData.networkTarget || null);
        var shareTargetHex = entry ? entry.shareTargetHex : (ethShareData.shareTarget || null);

        var assembled = null;
        if (isBlockCandidate && entry) {
            try { assembled = assembleBlockHex(entry, ethShareData); }
            catch (e) { log('error', 'ethash: block assembly failed for job ' + jobId + ': ' + e.message); }
        }

        var shareDiff = finalHash ? difficultyOfHash(finalHash) : 0;
        var shareData = {
            job: jobId,
            ip: client ? client.remoteAddress : undefined,
            port: client && client.socket ? client.socket.localPort : options.port,
            worker: ethShareData.worker || worker,
            algo: 'ethash',
            // Classic shareData contract (jobManager stamps `time` on
            // every share; pool.js stamps `blockFoundTime` at the
            // synchronous block-found event): attach.js closes payout
            // rounds at these event times, so the Ethash lane stamps
            // them too instead of leaving attach to fall back to
            // wall-clock emit time.
            time: Math.floor(Date.now() / 1000),
            height: entry ? entry.height : ethShareData.height,
            blockReward: entry ? entry.blockReward : undefined,
            difficulty: shareTargetHex ? difficultyOfTarget(shareTargetHex) : 0,
            shareDiff: shareDiff,
            shareDiffFixed8: (typeof shareDiff === 'number' && isFinite(shareDiff)) ? shareDiff.toFixed(8) : String(shareDiff),
            blockDiff: networkTargetHex ? difficultyOfTarget(networkTargetHex) : 0,
            blockDiffActual: entry ? entry.templateDifficulty : undefined,
            blockHash: assembled ? assembled.blockHash : undefined,
            blockHex: assembled ? assembled.blockHex : undefined,
            // Ethash-specific fields, kept verbatim from ethashStratum:
            nonce64: ethShareData.nonce64,
            nonce64LeHex: ethShareData.nonce64LeHex,
            mixHash: ethShareData.mixHash,
            finalHash: finalHash,
            headerHash: ethShareData.headerHash,
            seedHash: ethShareData.seedHash,
            shareTarget: shareTargetHex,
            networkTarget: networkTargetHex
        };
        if (ethShareData.error) shareData.error = ethShareData.error;
        if (isBlockCandidate) shareData.blockFoundTime = shareData.time;
        if (isBlockCandidate && !assembled) shareData.blockAssemblyError = true;

        pool.emit('share', !!isValid, !!isBlockCandidate, shareData);
        if (assembled) submitBlock(entry, assembled);
    });

    server.on('client.connected', function (client) {
        log('debug', 'ethash: client connected ' + (client && client.remoteAddress));
    });

    // Feed a template that was already current before we attached.
    if (pool.jobManager.currentJob) feedTemplate(pool.jobManager.currentJob, true);

    var startedPromise = new Promise(function (resolve) {
        server.once('started', function () { resolve(); });
    });
    server.listen(options.port, function () { /* 'started' also emitted */ });

    return {
        server: server,
        jobs: jobs,
        buildJob: buildJob,
        registerJob: registerJob,
        feedTemplate: feedTemplate,
        started: startedPromise,
        port: function () {
            return (server.server && server.server.address()) ? server.server.address().port : null;
        },
        detach: function () {
            pool.jobManager.removeListener('newBlock', onNewBlock);
            pool.jobManager.removeListener('updatedBlock', onUpdatedBlock);
        },
        close: function (callback) {
            this.detach();
            server.close(callback);
        }
    };
}

module.exports = attachEthash;
module.exports.attachEthash = attachEthash;
module.exports.targetHexFromBits = targetHexFromBits;
module.exports.sha256d = sha256d;
module.exports.DIFF1_HEX = DIFF1_HEX;
