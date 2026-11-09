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
 * VARDIFF: intentionally FIXED share difficulty for now — the share
 * target comes from options.shareTargetHex or job.shareTargetHex and
 * never changes per-client. Per-worker vardiff can be layered later by
 * recomputing a per-client target in handleSubmit; keep scope tight.
 */

var net = require('net');
var crypto = require('crypto');
var events = require('events');
var ethash = require('./ethash.js');

var DEFAULT_SHARE_TARGET = '000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; // ~diff 16 equivalent scale; operator should set explicitly

function isHashHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s); }

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

    function notifyParams(job) {
        return [job.jobId, job.seedHashHex, job.headerHashHex, job.shareTargetHex, !!job.clean];
    }

    function sendJob(client, job) {
        sendJson(client.socket, { id: null, method: 'mining.notify', params: notifyParams(job) });
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
        var workerName = p[0], jobId = p[1], nonceHex = p[2], headerHashHex = p[3], mixHashHex = p[4];
        if (typeof nonceHex !== 'string' || !/^[0-9a-fA-F]{16}$/.test(nonceHex || ''))
            return fail(20, 'incorrect size of nonce (need 16 hex chars)', jobId);
        if (!isHashHex(headerHashHex) || !isHashHex(mixHashHex))
            return fail(20, 'incorrect size of headerHash/mixHash', jobId);
        var job = _this.jobs[jobId];
        if (!job) return fail(21, 'job not found', jobId);
        if (headerHashHex.toLowerCase() !== job.headerHashHex)
            return fail(20, 'headerHash does not match job', jobId);

        var nonce = BigInt('0x' + nonceHex);
        var computed;
        try {
            computed = ethash.hashimotoLight(Buffer.from(job.headerHashHex, 'hex'), nonce, job.height);
        } catch (e) {
            return fail(20, 'verification error: ' + e.message, jobId);
        }
        var finalHex = computed.finalHash.toString('hex');
        var mixOk = computed.mixHash.toString('hex') === mixHashHex.toLowerCase();
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
            mixHash: mixHashHex.toLowerCase(),
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
        switch (message.method) {
            case 'mining.subscribe':
                client.subscribed = true;
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
        socket.setKeepAlive(true);
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
            lastActivity: Date.now()
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
            if (c.subscribed) sendJob(c, full);
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
        return _this.server;
    };

    this.close = function (callback) {
        for (var id in _this.clients) _this.clients[id].socket.destroy();
        if (_this.server) _this.server.close(callback);
        else if (callback) callback();
    };
};
EthashStratumServer.prototype.__proto__ = events.EventEmitter.prototype;
