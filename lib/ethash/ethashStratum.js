'use strict';
/**
 * lib/ethash/ethashStratum.js — standalone Stratum server for Interchained's
 * Ethash dialect. EventEmitter-based, modeled on lib/stratum.js patterns
 * (JSON-lines over TCP, subscription counter, flood guard) but deliberately
 * SEPARATE: the classic stratum/jobManager path cannot express Ethash
 * shares (they carry a 64-bit nonce + mix hash, not extranonce2/ntime).
 * lib/stratum.js is NOT modified by this lane.
 *
 * PROTOCOL (all hashes are 32-byte DISPLAY/big-endian hex, as they cross
 * the Ethash boundary in the daemon):
 *
 *   -> mining.subscribe
 *   <- result: [ [ ["mining.set_difficulty", subscriptionId],
 *                  ["mining.notify", subscriptionId] ],
 *                extranonce1, 0 ]
 *        (Ethash has no extranonce concept; extranonce1 is returned for
 *        client compatibility only and plays no role in verification.
 *        extranonce2 size is 0.)
 *
 *   -> mining.authorize  params: [username, password?]
 *        username = ITC payout address; an optional ".worker" or
 *        "/worker" suffix is kept as part of the stored worker name.
 *        If options.authorizeFn is supplied it is called with the classic
 *        pool signature authorizeFn(ip, port, workerName, password,
 *        callback) and its callback({error, authorized, disconnect})
 *        decides (added by the pool-wiring lane; lib/ethash/ethashPool.js
 *        passes the pool's authorizeFn straight through). With no
 *        authorizeFn, any username is accepted and stored (payout
 *        validation is then the pool operator's job).
 *   <- result: true
 *
 *   <- mining.notify  params (sent by setJob, see below):
 *        [ jobId, seedHashHex, headerHashHex, shareTargetHex, cleanFlag ]
 *        - jobId:         pool job id (string)
 *        - seedHashHex:   Ethash epoch seed hash for the job's height
 *        - headerHashHex: the Ethash INPUT hash = SHA256d of the 80-byte
 *                         standard header (display order). Miners run
 *                         hashimoto over THIS hash; they never see the
 *                         raw header from this dialect.
 *        - shareTargetHex: current SHARE target (display order). Fixed
 *                         per server/job in this version (see vardiff note).
 *        - cleanFlag:     true = discard all previous jobs
 *
 *   -> mining.submit  params:
 *        [ workerName, jobId, nonceHex, headerHashHex, mixHashHex ]
 *        - nonceHex: 8 bytes / 16 hex chars encoding the uint64 nonce
 *          VALUE big-endian (i.e. BigInt('0x' + nonceHex) is the nonce;
 *          the same notation ethminer-class miners use). NOTE the
 *          contrast with the daemon: CBlockHeader stores nNonce64 as a
 *          uint64 whose hashimoto serialization is LITTLE-endian — that
 *          LE encoding happens inside ethash.js (hash_seed), exactly as
 *          in chfast. The stratum wire form is the value, not the bytes.
 *        - headerHashHex: must equal the job's headerHashHex.
 *        - mixHashHex: miner's claimed mix hash.
 *   <- result: true (share accepted) / false + error [code, msg, null]
 *
 * EVENTS
 *   'share' (worker, jobId, isValid, isBlockCandidate, shareData)
 *        shareData: { worker, jobId, height, headerHash, seedHash,
 *          nonceHex, nonce64 (decimal string), nonce64LeHex (the 8-byte
 *          LE storage form for CBlockHeader::nNonce64), mixHash,
 *          finalHash, shareTarget, networkTarget, isBlockCandidate,
 *          error? }
 *        On a block candidate, shareData carries everything the pool
 *        needs to assemble the solved header (80 standard bytes are the
 *        pool's own template; append nonce64 LE bytes + mixHash display
 *        bytes reversed to internal order — see daemon serialization)
 *        and submit it via submitblock.
 *   'client.connected' / 'client.disconnected' (client object)
 *
 * KEEPALIVE: options.heartbeatIntervalMs (default 30000, 0 disables)
 * re-sends the current job with clean=false to any subscribed client
 * that has not been sent a job within the interval, so the stream
 * always carries traffic even when no new block template arrives;
 * sockets also get TCP keepalive with a 30s initial delay. A
 * client-sent mining.ping is answered with result "pong".
 *
 * VARDIFF: intentionally FIXED share difficulty for now — the share
 * target comes from options.shareTargetHex or job.shareTargetHex and
 * never changes per-client. Per-worker vardiff can be layered later by
 * recomputing a per-client target in handleSubmit; keep scope tight.
 *
 * NICEHASH DIALECT (per-client, negotiated at subscribe):
 * The legacy dialect above is a hybrid (target inside notify, 5-param
 * submit with header+mix) that ethminer-class and lolMiner clients
 * tolerate, but strict EthereumStratum/1.0.0 (NiceHash) clients —
 * Rigel is the one Mark runs — cannot work with it: they require the
 * canonical shapes below and otherwise never start hashing (observed
 * live 2026-11-09: Rigel connected, GPU healthy, Diff "n/a", no job
 * ever parsed, 0 H/s — the same wall ethminer/lolMiner hit in their
 * own ways). A client whose subscribe user-agent names Rigel is
 * switched to the canonical dialect for the whole session:
 *
 *   <- subscribe result: [ ["mining.notify", subscriptionId,
 *        "EthereumStratum/1.0.0"], extranonce1 ]  (exactly 2 elements;
 *        extranonce1 is 2 bytes — the spec caps it at 3 — and IS part
 *        of the mining nonce for this dialect, unlike the legacy one)
 *   <- mining.set_difficulty  params: [difficulty]  — sent after
 *        authorize, BEFORE the first mining.notify, and again whenever
 *        a new job's share target changes the value. The number is the
 *        exact double for the job's share target under the
 *        EthereumStratum diff-1 constant (0x00000000ffff0000...), so
 *        the target the miner derives equals the target shares are
 *        verified against here.
 *   <- mining.notify  params: [ jobId, seedHashHex, headerHashHex,
 *        cleanFlag ]  (4 params, NO target — difficulty carries it)
 *   -> mining.submit  params: [ workerName, jobId, nonceSegmentHex ]
 *        The miner sends only its own nonce segment; the full 64-bit
 *        nonce is extranonce1 || segment. A full-length 16-hex segment
 *        is also accepted as the complete nonce. No headerHash/mixHash
 *        is sent: the pool computes both with hashimoto-light (it
 *        already does full verification) and the emitted shareData is
 *        identical in shape to the legacy path, so ethashPool.js
 *        block assembly works unchanged.
 *   No job is sent before authorize for this dialect.
 * Legacy clients are byte-for-byte unaffected (the conformance suite
 * pins their shapes, including NO set_difficulty — C5).
 */

var net = require('net');
var crypto = require('crypto');
var events = require('events');
var ethash = require('./ethash.js');

var DEFAULT_SHARE_TARGET = '000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; // ~diff 16 equivalent scale; operator should set explicitly

function isHashHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s); }

/* EthereumStratum difficulty: diff-1 target per the NiceHash spec
   (0x00000000ffff0000...), NOT the classic pool diff-1 in
   ethashPool.js (0x00000fffff0000...) — the two constants differ by
   ~4096x, and mining.set_difficulty is only meaningful to the miner
   under the spec constant it converts back with. */
var ETH_DIFF1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
function difficultyFromTarget(targetHex) {
    var t = BigInt('0x' + targetHex);
    if (t === 0n) return Infinity;
    return Number(ETH_DIFF1) / Number(t);
}

var EthashStratumServer = module.exports = function EthashStratumServer(options) {
    options = options || {};
    var _this = this;
    this.options = options;
    this.defaultShareTargetHex = (options.shareTargetHex || DEFAULT_SHARE_TARGET).toLowerCase();
    this.clients = {};          // subscriptionId -> client record
    this.jobs = {};             // jobId -> job
    this.currentJob = null;
    this.server = null;
    var subCounter = 0;

    function sendJson(socket, obj) { socket.write(JSON.stringify(obj) + '\n'); }

    function notifyParams(client, job) {
        if (client.dialect === 'nicehash')
            return [job.jobId, job.seedHashHex, job.headerHashHex, !!job.clean];
        return [job.jobId, job.seedHashHex, job.headerHashHex, job.shareTargetHex, !!job.clean];
    }

    function sendDifficulty(client, job) {
        var diff = difficultyFromTarget(job.shareTargetHex);
        client.sentDifficulty = diff;
        sendJson(client.socket, { id: null, method: 'mining.set_difficulty', params: [diff] });
    }

    function sendJob(client, job) {
        /* Canonical dialect: difficulty must precede the job it
           applies to (spec 4.2.3: set before the first job; resent
           when a new job's target changes it). Legacy: never sent. */
        if (client.dialect === 'nicehash' &&
            client.sentDifficulty !== difficultyFromTarget(job.shareTargetHex))
            sendDifficulty(client, job);
        sendJson(client.socket, { id: null, method: 'mining.notify', params: notifyParams(client, job) });
        client.lastJobSentAt = Date.now();
    }

    /* Heartbeat: jobs otherwise flow only when a new block template
       arrives, so during a quiet stretch an authorized miner receives
       NOTHING — and NAT/firewall state for its idle connection expires
       in minutes (the stream looks alive at both ends until a write
       fails; that is the periodic "pool kicked me" disconnect). Every
       heartbeatIntervalMs, re-send the current job (clean=false: the
       work is unchanged) to any eligible client that has not been sent
       a job within the interval. Combined with the TCP keepalive delay
       set in handleNewClient, the stream always carries traffic. */
    var heartbeatIntervalMs = (typeof options.heartbeatIntervalMs === 'number')
        ? options.heartbeatIntervalMs : 30000;
    this.heartbeatTimer = null;
    function heartbeatTick() {
        var job = _this.currentJob;
        if (!job || !(heartbeatIntervalMs > 0)) return;
        var now = Date.now();
        var heartbeatJob = null;
        for (var id in _this.clients) {
            var c = _this.clients[id];
            if (!c.subscribed) continue;
            /* Canonical-dialect clients get nothing before authorize —
               same gate as setJob. */
            if (c.dialect === 'nicehash' && !c.authorized) continue;
            if (now - (c.lastJobSentAt || 0) < heartbeatIntervalMs) continue;
            if (!heartbeatJob) {
                heartbeatJob = Object.assign({}, job);
                heartbeatJob.clean = false;
            }
            try { sendJob(c, heartbeatJob); } catch (e) { /* close handler cleans up */ }
        }
    }

    function handleSubmit(client, message) {
        var fail = function (code, msg, jobId, shareDataExtra) {
            var shareData = Object.assign({
                worker: client.workerName, jobId: jobId || null, error: msg
            }, shareDataExtra || {});
            _this.emit('share', client.workerName, jobId || null, false, false, shareData);
            sendJson(client.socket, { id: message.id, result: false, error: [code, msg, null] });
        };
        if (!client.authorized) return fail(24, 'unauthorized worker', message.params && message.params[1]);
        var p = message.params || [];
        var workerName = p[0], jobId = p[1];
        var nonceHex, headerHashHex = null, mixHashHex = null;
        if (p.length >= 5) {
            /* Legacy hybrid submit: full nonce + header + mix. */
            nonceHex = p[2]; headerHashHex = p[3]; mixHashHex = p[4];
            if (!isHashHex(headerHashHex) || !isHashHex(mixHashHex))
                return fail(20, 'incorrect size of headerHash/mixHash', jobId);
        } else if (p.length === 3) {
            /* Canonical NiceHash submit: the miner sends only its own
               nonce segment; the full 64-bit nonce is the session
               extranonce1 prepended to that segment. A segment that is
               already the full 16 hex chars is taken as the complete
               nonce (Rigel's plain stratum mode sends it whole). No
               header/mix arrives — both are computed server-side. */
            if (typeof p[2] !== 'string' || !/^[0-9a-fA-F]+$/.test(p[2]))
                return fail(20, 'incorrect nonce segment', jobId);
            nonceHex = (p[2].length === 16) ? p[2] : (client.extraNonce1 + p[2]);
        } else {
            return fail(20, 'incorrect number of submit params (need 3 or 5)', jobId);
        }
        if (typeof nonceHex !== 'string' || !/^[0-9a-fA-F]{16}$/.test(nonceHex || ''))
            return fail(20, 'incorrect size of nonce (need 16 hex chars)', jobId);
        var job = _this.jobs[jobId];
        if (!job) return fail(21, 'job not found', jobId);
        if (headerHashHex && headerHashHex.toLowerCase() !== job.headerHashHex)
            return fail(20, 'headerHash does not match job', jobId);

        var nonce = BigInt('0x' + nonceHex);
        var computed;
        try {
            computed = ethash.hashimotoLight(Buffer.from(job.headerHashHex, 'hex'), nonce, job.height);
        } catch (e) {
            return fail(20, 'verification error: ' + e.message, jobId);
        }
        var finalHex = computed.finalHash.toString('hex');
        var computedMixHex = computed.mixHash.toString('hex');
        /* With no claimed mix (canonical submit), the computed mix IS
           the mix — mixOk is about a miner claim disagreeing. */
        var mixOk = mixHashHex ? (computedMixHex === mixHashHex.toLowerCase()) : true;
        var meetsShare = Buffer.compare(computed.finalHash, Buffer.from(job.shareTargetHex, 'hex')) <= 0;
        var meetsNetwork = Buffer.compare(computed.finalHash, Buffer.from(job.nBitsTargetHex, 'hex')) <= 0;
        var isValid = mixOk && meetsShare;
        var isBlockCandidate = mixOk && meetsNetwork;
        var nonceLe = Buffer.alloc(8); nonceLe.writeBigUInt64LE(nonce, 0);
        var shareData = {
            worker: workerName || client.workerName,
            jobId: jobId,
            height: job.height,
            headerHash: job.headerHashHex,
            seedHash: job.seedHashHex,
            nonceHex: nonceHex.toLowerCase(),
            nonce64: nonce.toString(10),
            nonce64LeHex: nonceLe.toString('hex'),
            mixHash: mixHashHex ? mixHashHex.toLowerCase() : computedMixHex,
            finalHash: finalHex,
            shareTarget: job.shareTargetHex,
            networkTarget: job.nBitsTargetHex,
            isBlockCandidate: isBlockCandidate
        };
        if (!mixOk) shareData.error = 'mix hash mismatch';
        else if (!meetsShare) shareData.error = 'low difficulty share';
        _this.emit('share', shareData.worker, jobId, isValid, isBlockCandidate, shareData);
        if (isValid) sendJson(client.socket, { id: message.id, result: true, error: null });
        else sendJson(client.socket, { id: message.id, result: false, error: [23, shareData.error, null] });
    }

    function handleMessage(client, message) {
        client.lastActivity = Date.now();
        switch (message.method) {
            case 'mining.ping':
                /* Liveness probe some miners send; answer it instead
                   of the method-not-found the dialect probes get, so a
                   miner checking the stream sees a live handshake. */
                if (message.id !== undefined && message.id !== null)
                    sendJson(client.socket, { id: message.id, result: 'pong', error: null });
                break;
            case 'mining.subscribe':
                client.subscribed = true;
                /* Dialect negotiation: a client whose user-agent names
                   Rigel gets the canonical EthereumStratum/1.0.0
                   (NiceHash) dialect for the whole session — see the
                   NICEHASH DIALECT note in the file header. Rigel
                   parses the subscribe result strictly per spec:
                   result[0] is the flat ["mining.notify", session,
                   protocol] triple and result[1] the extranonce
                   (max 3 bytes; 2 issued here). The legacy hybrid
                   result below — which ethminer confirms via its
                   3-element check on result[0] — leaves Rigel with
                   no session, no difficulty and no parseable job. */
                var subscribeUa = (message.params || [])[0] || '';
                if (/rigel/i.test(subscribeUa)) {
                    client.dialect = 'nicehash';
                    client.extraNonce1 = crypto.randomBytes(2).toString('hex');
                    sendJson(client.socket, {
                        id: message.id,
                        result: [
                            ['mining.notify', client.subscriptionId, 'EthereumStratum/1.0.0'],
                            client.extraNonce1
                        ],
                        error: null
                    });
                    /* No job yet: canonical clients are served
                       difficulty + job only after authorize. */
                    break;
                }
                /* The subscriptions array MUST carry the protocol string
                   as its third element — the canonical NiceHash shape.
                   ethminer's EthereumStratum/1.0.0 confirmation checks
                   result[0].length === 3 && result[0][2] ===
                   'EthereumStratum/1.0.0'; without it ethminer rejects
                   the flavour, falls through its autodetect to the
                   generic STRATUM flavour, and parses mining.notify in
                   eth-proxy order (header, seed) — the exact swap that
                   showed up live as "Epoch : -1" with the seed hash
                   displayed as the job header. lolMiner accepts both
                   shapes; the 3-element shape is the standard. */
                sendJson(client.socket, {
                    id: message.id,
                    result: [
                        [['mining.set_difficulty', client.subscriptionId], ['mining.notify', client.subscriptionId], 'EthereumStratum/1.0.0'],
                        client.extraNonce1,
                        0
                    ],
                    error: null
                });
                if (_this.currentJob) sendJob(client, _this.currentJob);
                break;
            case 'mining.extranonce.subscribe':
                /* ethminer sends this right after the flavour is
                   confirmed; it expects no logic, just an answer. */
                sendJson(client.socket, { id: message.id, result: true, error: null });
                break;
            case 'mining.authorize':
                var authUser = (message.params || [])[0] || '';
                var authPass = (message.params || [])[1];
                if (typeof _this.options.authorizeFn === 'function') {
                    var replied = false;
                    try {
                        _this.options.authorizeFn(client.remoteAddress, client.socket.localPort, authUser, authPass, function (result) {
                            if (replied) return; replied = true;
                            result = result || {};
                            client.authorized = !result.error && !!result.authorized;
                            if (client.authorized) client.workerName = authUser;
                            sendJson(client.socket, { id: message.id, result: client.authorized, error: result.error || null });
                            if (result.disconnect) { client.socket.destroy(); return; }
                            if (client.authorized && _this.currentJob && client.subscribed) sendJob(client, _this.currentJob);
                        });
                    } catch (e) {
                        if (!replied) {
                            client.authorized = false;
                            sendJson(client.socket, { id: message.id, result: false, error: [20, 'authorize error: ' + e.message, null] });
                        }
                    }
                } else {
                    client.workerName = authUser;
                    client.authorized = true;
                    sendJson(client.socket, { id: message.id, result: true, error: null });
                    if (_this.currentJob && client.subscribed) sendJob(client, _this.currentJob);
                }
                break;
            case 'mining.submit':
                client.lastActivity = Date.now();
                handleSubmit(client, message);
                break;
            default:
                _this.emit('unknownStratumMethod', client, message);
                /* Answer unknown methods with a JSON-RPC error instead
                   of silence. Autodetecting clients (ethminer) probe
                   with mining.hello (EthereumStratum/2) and
                   eth_submitLogin (eth-proxy) before settling; silence
                   leaves them waiting on a plea timeout, and a
                   success-shaped answer would confirm a dialect this
                   server does not speak. Method-not-found makes them
                   step down to EthereumStratum/1.0.0 immediately. */
                if (message.id !== undefined && message.id !== null) {
                    sendJson(client.socket, { id: message.id, result: null, error: [-32601, 'method not found', null] });
                }
                break;
        }
    }

    this.handleNewClient = function (socket) {
        /* Keepalive WITH an initial delay: bare setKeepAlive(true)
           leaves the kernel default (~2h on Linux) before the first
           probe, far beyond NAT/firewall idle-flow lifetimes. 30s
           probes keep the flow state warm between heartbeats. */
        socket.setKeepAlive(true, 30000);
        subCounter++;
        var subscriptionId = 'deadbeefcafebabe' + subCounter.toString(16).padStart(16, '0');
        var client = {
            subscriptionId: subscriptionId,
            socket: socket,
            remoteAddress: socket.remoteAddress,
            extraNonce1: crypto.randomBytes(4).toString('hex'),
            workerName: null,
            authorized: false,
            subscribed: false,
            dialect: 'legacy',       // 'nicehash' after a Rigel subscribe
            sentDifficulty: null,    // last mining.set_difficulty value sent
            lastActivity: Date.now(),
            lastJobSentAt: 0         // last mining.notify we sent (heartbeat clock)
        };
        _this.clients[subscriptionId] = client;
        _this.emit('client.connected', client);
        var dataBuffer = '';
        socket.setEncoding('utf8');
        socket.on('data', function (d) {
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) {
                dataBuffer = '';
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1) {
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function (line) {
                    if (line === '') return;
                    var msg;
                    try { msg = JSON.parse(line); } catch (e) { socket.destroy(); return; }
                    if (msg) handleMessage(client, msg);
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function () {
            delete _this.clients[subscriptionId];
            _this.emit('client.disconnected', client);
        });
        socket.on('error', function () { /* close handler cleans up */ });
        return client;
    };

    // Pool-side API: install a new job and broadcast mining.notify.
    // job = { jobId, headerHashHex, seedHashHex?, nBitsTargetHex,
    //         shareTargetHex?, height, clean }
    // seedHashHex is derived from height when omitted.
    this.setJob = function (job) {
        if (!job || !job.jobId || !isHashHex(job.headerHashHex || '') || !isHashHex(job.nBitsTargetHex || ''))
            throw new Error('setJob: jobId, headerHashHex and nBitsTargetHex (64 hex) are required');
        if (typeof job.height !== 'number') throw new Error('setJob: numeric height is required');
        var full = {
            jobId: String(job.jobId),
            headerHashHex: job.headerHashHex.toLowerCase(),
            seedHashHex: (job.seedHashHex || ethash.seedHashHex(ethash.epochOfHeight(job.height))).toLowerCase(),
            nBitsTargetHex: job.nBitsTargetHex.toLowerCase(),
            shareTargetHex: (job.shareTargetHex || _this.defaultShareTargetHex).toLowerCase(),
            height: job.height,
            clean: job.clean !== false
        };
        if (full.clean) _this.jobs = {};
        _this.jobs[full.jobId] = full;
        _this.currentJob = full;
        for (var id in _this.clients) {
            var c = _this.clients[id];
            /* Canonical-dialect clients get nothing before authorize;
               legacy clients keep the historical broadcast. */
            if (c.subscribed && (c.dialect !== 'nicehash' || c.authorized)) sendJob(c, full);
        }
        return full;
    };

    this.listen = function (port, callback) {
        _this.server = net.createServer({ allowHalfOpen: false }, function (socket) {
            _this.handleNewClient(socket);
        });
        _this.server.listen(port, function () {
            _this.emit('started');
            if (callback) callback();
        });
        if (heartbeatIntervalMs > 0 && !_this.heartbeatTimer) {
            _this.heartbeatTimer = setInterval(heartbeatTick, heartbeatIntervalMs);
            if (_this.heartbeatTimer.unref) _this.heartbeatTimer.unref();
        }
        return _this.server;
    };

    this.close = function (callback) {
        if (_this.heartbeatTimer) {
            clearInterval(_this.heartbeatTimer);
            _this.heartbeatTimer = null;
        }
        for (var id in _this.clients) _this.clients[id].socket.destroy();
        if (_this.server) _this.server.close(callback);
        else if (callback) callback();
    };
};
EthashStratumServer.prototype.__proto__ = events.EventEmitter.prototype;
module.exports.difficultyFromTarget = difficultyFromTarget;
