'use strict';
/*
 * stub-daemon.js — fake Interchained daemon JSON-RPC server for boot proofs.
 *
 * Speaks Bitcoin-style JSON-RPC over HTTP POST ({result, error, id}),
 * including BATCH requests (arrays), which lib/daemon.js batchCmd() uses
 * for the pool's DetectCoinData startup probe.
 *
 * Methods the pool (lib/pool.js) actually issues at startup / runtime:
 *   getpeerinfo          daemon.init() isOnline probe           -> []
 *   validateaddress      DetectCoinData batch                   -> {isvalid:true, address:<echo>}
 *   getdifficulty        DetectCoinData batch                   -> 0.00390625
 *   getmininginfo        DetectCoinData batch                   -> {networkhashps, difficulty, blocks}
 *   submitblock          DetectCoinData probe (params [])       -> error -32602 (method EXISTS;
 *                                                                   anything but 'Method not found'
 *                                                                   proves hasSubmitMethod)
 *                        DetectCoinData batch + SubmitBlock     -> null, records hex, height++
 *   getblockchaininfo    DetectCoinData batch                   -> {chain:'regtest', blocks, difficulty}
 *   getnetworkinfo       DetectCoinData batch                   -> {protocolversion, connections}
 *   getinfo              only if coin.hasGetInfo (not our path)  -> provided anyway
 *   getblocktemplate     OnBlockchainSynced + GetBlockTemplate  -> full GBT, honors params[0].algo
 *   getblockhash         SubmitBlock post-submit lookup         -> deterministic fake hash
 *   getblock             CheckBlockAccepted                     -> {hash:<echo>, tx:[coinbaseTxid]}
 *   getblockcount        (task requirement / polling helpers)   -> height
 *
 * Wallet / payments emulation (PSBT-based payouts processor):
 *   walletcreatefundedpsbt(inputs, outputs) -> {psbt:<fabricated base64>, fee:0.0001, changepos:-1}
 *   walletprocesspsbt(psbt)                 -> {psbt:<same>, complete:true}
 *   finalizepsbt(psbt)                      -> {hex:<fabricated raw tx hex>, complete:true}
 *   sendrawtransaction(hex)                 -> fake txid; call + hex recorded
 *   sendmany(from, outputs)                 -> fake txid; call recorded (legacy, harmless)
 *
 * Every call is logged to stdout AND appended as one JSON line to the
 * call-log file (env STUB_CALL_LOG, or argv[3], default ./stub-calls.jsonl).
 *
 * Usage: node scripts/stub-daemon.js [port] [callLogPath]
 *        STUB_PORT=18332 STUB_CALL_LOG=/tmp/calls.jsonl node scripts/stub-daemon.js
 */
var http = require('http');
var fs = require('fs');
var crypto = require('crypto');

var PORT = parseInt(process.env.STUB_PORT || process.argv[2] || '18332', 10);
var CALL_LOG = process.env.STUB_CALL_LOG || process.argv[3] || './stub-calls.jsonl';
var START_HEIGHT = parseInt(process.env.STUB_START_HEIGHT || '1000', 10);

var state = {
    height: START_HEIGHT,
    submittedBlocks: [],   // {height, hex}
    rawTransactions: [],   // {hex, txid}
    sendManyCalls: [],
    psbtCalls: []
};

function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function fakeBlockHash(h) { return sha256hex('itc-stub-block-' + h); }

/* diff1 as defined in lib/algoProperties.js */
var DIFF1 = BigInt('0x00000fffff000000000000000000000000000000000000000000000000000000');
/* GBT target: block difficulty = diff1/target = 1/256 ~= 0.0039 by default.
   A stratum share at the harness difficulties then has a small but real
   chance of also being a block candidate, exercising submitblock.
   STUB_TARGET_MULT overrides the multiplier (e.g. 1048576 makes nearly
   every share a block candidate, to demo the submitblock path on demand). */
var TARGET_MULT = BigInt(parseInt(process.env.STUB_TARGET_MULT || '256', 10));
var GBT_TARGET_HEX = (DIFF1 * TARGET_MULT).toString(16).padStart(64, '0');
var STUB_DIFFICULTY = 0.00390625;

function logCall(method, params) {
    var brief = JSON.stringify(params);
    if (brief && brief.length > 220) brief = brief.slice(0, 220) + '...';
    console.log('[stub] ' + method + ' ' + brief);
    try {
        fs.appendFileSync(CALL_LOG, JSON.stringify({ ts: Date.now(), method: method, params: params }) + '\n');
    } catch (e) { /* logging must never kill the stub */ }
}

function getBlockTemplate(req) {
    var algo = (req && typeof req === 'object' && req.algo) || 'sha256';
    var now = Math.floor(Date.now() / 1000);
    var h = state.height + 1;
    return {
        capabilities: ['proposal'],
        version: 536870912,
        rules: ['segwit'],
        vbavailable: {},
        vbrequired: 0,
        previousblockhash: fakeBlockHash(state.height),
        transactions: [],
        coinbaseaux: { flags: '' },
        coinbasevalue: 5000000000,
        longpollid: fakeBlockHash(state.height) + String(h),
        target: GBT_TARGET_HEX,
        mintime: now - 600,
        mutable: ['time', 'transactions', 'prevblock'],
        noncerange: '00000000ffffffff',
        sigoplimit: 80000,
        sizelimit: 4000000,
        weightlimit: 4000000,
        curtime: now,
        bits: '1f0fffff',
        height: h,
        algo: algo
    };
}

function handle(method, params) {
    params = params || [];
    switch (method) {
        case 'getpeerinfo':
            return [];
        case 'validateaddress':
            return {
                isvalid: true,
                address: params[0],
                scriptPubKey: '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac',
                isscript: false,
                iswitness: false
            };
        case 'getdifficulty':
            return STUB_DIFFICULTY;
        case 'getmininginfo':
            return {
                blocks: state.height,
                difficulty: STUB_DIFFICULTY,
                networkhashps: 1234567.0,
                pooledtx: 0,
                chain: 'regtest',
                warnings: ''
            };
        case 'getblockchaininfo':
            return {
                chain: 'regtest',
                blocks: state.height,
                headers: state.height,
                bestblockhash: fakeBlockHash(state.height),
                difficulty: STUB_DIFFICULTY,
                mediantime: Math.floor(Date.now() / 1000) - 60,
                verificationprogress: 1.0,
                pruned: false,
                softforks: {}
            };
        case 'getnetworkinfo':
            return {
                version: 210000,
                subversion: '/InterchainedStub:0.21.0/',
                protocolversion: 70015,
                localservices: '0000000000000409',
                localrelay: true,
                timeoffset: 0,
                networkactive: true,
                connections: 1,
                networks: [],
                relayfee: 0.00001,
                incrementalfee: 0.00001,
                warnings: ''
            };
        case 'getinfo':
            return {
                version: 210000,
                protocolversion: 70015,
                blocks: state.height,
                difficulty: STUB_DIFFICULTY,
                testnet: false,
                connections: 1,
                errors: ''
            };
        case 'getblocktemplate':
            return getBlockTemplate(params[0]);
        case 'submitblock': {
            if (!params[0] || typeof params[0] !== 'string') {
                // The pool's startup probe calls submitblock with no params.
                // A param error (NOT 'Method not found') proves the method exists.
                return { __error: { code: -32602, message: 'Invalid params: block hex required' } };
            }
            state.height += 1;
            state.submittedBlocks.push({ height: state.height, hex: params[0] });
            console.log('[stub] *** BLOCK SUBMITTED height=' + state.height + ' hexLen=' + params[0].length + ' ***');
            return null;
        }
        case 'getblockcount':
            return state.height;
        case 'getblockhash': {
            var hh = (typeof params[0] === 'number') ? params[0] : state.height;
            return fakeBlockHash(hh);
        }
        case 'getblock': {
            var hash = params[0];
            return {
                hash: hash,
                confirmations: 10,
                size: 250,
                height: state.height,
                version: 536870912,
                merkleroot: fakeBlockHash('merkle-' + hash),
                tx: [sha256hex('coinbase-' + hash)],
                time: Math.floor(Date.now() / 1000),
                bits: '1f0fffff',
                difficulty: STUB_DIFFICULTY,
                chainwork: '0000000000000000000000000000000000000000000000000000000000001000'
            };
        }
        case 'getblockheader': {
            var bh = params[0];
            return {
                hash: bh,
                confirmations: 10,
                height: state.height,
                version: 536870912,
                merkleroot: fakeBlockHash('merkle-' + bh),
                time: Math.floor(Date.now() / 1000),
                bits: '1f0fffff',
                difficulty: STUB_DIFFICULTY
            };
        }
        /* ---- wallet / PSBT payments emulation ---- */
        case 'walletcreatefundedpsbt': {
            var inputs = params[0] || [];
            var outputs = params[1] || {};
            var blob = JSON.stringify({ stub: 'itc-psbt-v0', inputs: inputs, outputs: outputs, ts: Date.now() });
            var psbt = Buffer.from(blob, 'utf8').toString('base64');
            state.psbtCalls.push({ method: method, inputs: inputs, outputs: outputs, psbt: psbt });
            return { psbt: psbt, fee: 0.0001, changepos: -1 };
        }
        case 'walletprocesspsbt': {
            state.psbtCalls.push({ method: method, psbt: params[0] });
            return { psbt: params[0], complete: true };
        }
        case 'finalizepsbt': {
            state.psbtCalls.push({ method: method, psbt: params[0] });
            var rawHex = '0200000001' + sha256hex('stub-rawtx-' + params[0]) + '00000000';
            return { hex: rawHex, complete: true };
        }
        case 'sendrawtransaction': {
            var txid = sha256hex('stub-sendraw-' + params[0]);
            state.rawTransactions.push({ hex: params[0], txid: txid });
            console.log('[stub] *** RAW TX BROADCAST txid=' + txid + ' ***');
            return txid;
        }
        case 'sendmany': {
            var fakeTxid = sha256hex('stub-sendmany-' + JSON.stringify(params));
            state.sendManyCalls.push({ params: params, txid: fakeTxid });
            return fakeTxid;
        }
        default:
            return { __error: { code: -32601, message: 'Method not found' } };
    }
}

var server = http.createServer(function (req, res) {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
        var payload;
        try { payload = JSON.parse(body); }
        catch (e) { res.writeHead(400); res.end('{"result":null,"error":{"code":-32700,"message":"Parse error"},"id":null}'); return; }
        var isBatch = Array.isArray(payload);
        var items = isBatch ? payload : [payload];
        var responses = items.map(function (item) {
            logCall(item.method, item.params);
            var out;
            try { out = handle(item.method, item.params); }
            catch (e) { out = { __error: { code: -32603, message: 'Internal error: ' + e.message } }; }
            if (out && out.__error) {
                return { result: null, error: out.__error, id: item.id === undefined ? null : item.id };
            }
            return { result: (out === undefined ? null : out), error: null, id: item.id === undefined ? null : item.id };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(isBatch ? responses : responses[0]));
    });
});

server.listen(PORT, '127.0.0.1', function () {
    console.log('[stub] Interchained stub daemon listening on 127.0.0.1:' + PORT +
        ' startHeight=' + state.height + ' callLog=' + CALL_LOG);
});
