'use strict';
/*
 * test-generation-mode.js — mode-based coinbase construction.
 *
 * Group modes (pplns/prop): the coinbase pays the pool recipients and
 * the payments processor splits it later — byte-identical to before.
 * Solo mode: the coinbase pays the FINDING miner directly — governance
 * and operator carve-outs unchanged, the whole miner remainder (fees
 * included) in a single output to the finder's script, no pool output.
 *
 * Pinned with the real economics of the pool's first accepted block,
 * height 914572 (2026-11-09, Ethash lane, solo scheme — the coinbase
 * that day paid the miner remainder to the POOL wallet; this suite pins
 * that it now pays the finder):
 *
 *   subsidy (coinbasevalue)  24,088,231
 *   governance (73%)         17,584,408
 *   operator                    — none (template carried no operator
 *                                 destination; daemon minerReward
 *                                 covered it inside the remainder)
 *   miner remainder           6,503,823  -> the finder, solo
 *
 * and of the lost block 914565 (governance + operator template):
 *   subsidy 24,088,879 / governance 17,584,881 / operators 1,204,443 /
 *   miner remainder 5,299,555.
 *
 * Run: node scripts/test-generation-mode.js
 */

require('../lib/algoProperties.js'); // sets global algos + diff1 for jobManager

var events = require('events');
var bitcoin = require('bitcoinjs-lib');
var transactions = require('../lib/transactions.js');
var util = require('../lib/util.js');
var network = require('../lib/interchained-network.js');
var JobManager = require('../lib/jobManager.js');
var attachEthash = require('../lib/ethash/ethashPool.js');

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('  ok   ' + name); }
    else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

var GOV_ADDRESS = 'itc1qg408c5vw9u4s47e5l5v5q0s0u98hprg8w94ffp';   // chainparams governance wallet
var FINDER_ADDRESS = 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu'; // miner wallet (found 914572)
var POOL_ADDRESS = 'itc1qhrtjdc02wgq0ary38prp6xel3mydcpjvkyhp4x';   // pool wallet (paid pre-fix)
var OPS_ADDRESS = bitcoin.payments.p2wpkh({
    hash: Buffer.from('07'.repeat(20), 'hex'), network: network
}).address;
var OTHER_ADDRESS = bitcoin.payments.p2wpkh({
    hash: Buffer.from('09'.repeat(20), 'hex'), network: network
}).address;

var PLACEHOLDER = Buffer.from('f000000ff111111f', 'hex');

function readVarInt(buf, pos) {
    var b = buf[pos];
    if (b < 0xfd) return [b, pos + 1];
    if (b === 0xfd) return [buf.readUInt16LE(pos + 1), pos + 3];
    if (b === 0xfe) return [buf.readUInt32LE(pos + 1), pos + 5];
    return [Number(buf.readBigUInt64LE(pos + 1)), pos + 9];
}

/* Parse the outputs of a raw transaction starting at offset. */
function parseTxOutputs(tx, pos) {
    pos += 4; // version
    var r = readVarInt(tx, pos); var nIn = r[0]; pos = r[1];
    for (var i = 0; i < nIn; i++) {
        pos += 32 + 4; // prev hash + index
        r = readVarInt(tx, pos); var sl = r[0]; pos = r[1];
        pos += sl + 4; // scriptSig + sequence
    }
    r = readVarInt(tx, pos); var nOut = r[0]; pos = r[1];
    var outputs = [];
    for (var j = 0; j < nOut; j++) {
        var value = Number(tx.readBigUInt64LE(pos)); pos += 8;
        r = readVarInt(tx, pos); var l = r[0]; pos = r[1];
        outputs.push({ value: value, scriptHex: tx.slice(pos, pos + l).toString('hex') });
        pos += l;
    }
    return outputs;
}

function generationParts(rpcData, recipients, soloScript) {
    return transactions.CreateGeneration(
        rpcData,
        util.addressToScript(POOL_ADDRESS),
        PLACEHOLDER,
        'POW',
        false,
        recipients || [],
        soloScript
    );
}
function generationOutputs(rpcData, recipients, soloScript) {
    var parts = generationParts(rpcData, recipients, soloScript);
    return parseTxOutputs(Buffer.concat([parts[0], PLACEHOLDER, parts[1]]), 0);
}
function byScript(outputs, address) {
    var scriptHex = util.addressToScript(address).toString('hex');
    return outputs.filter(function (o) { return o.scriptHex === scriptHex; });
}
function total(outputs) {
    return outputs.reduce(function (s, o) { return s + o.value; }, 0);
}

var FINDER_SCRIPT = util.addressToScript(FINDER_ADDRESS);

var TEMPLATE_914572 = {
    height: 914572,
    coinbasevalue: 24088231,
    coinbaseaux: { flags: '' },
    governanceAddress: GOV_ADDRESS,
    governanceReward: 17584408
};
var TEMPLATE_914565 = {
    height: 914565,
    coinbasevalue: 24088879,
    coinbaseaux: { flags: '' },
    governanceAddress: GOV_ADDRESS,
    governanceReward: 17584881,
    nodeOperatorsAddress: OPS_ADDRESS,
    nodeOperatorsReward: 1204443
};

/* ------------------------------------------------------------------ */
console.log('A. solo generation — 914572 economics (governance only)');
var a = generationOutputs(TEMPLATE_914572, [], FINDER_SCRIPT);
check('governance output intact', byScript(a, GOV_ADDRESS).length === 1 &&
    byScript(a, GOV_ADDRESS)[0].value === 17584408, JSON.stringify(byScript(a, GOV_ADDRESS)));
check('finder paid the full miner remainder', byScript(a, FINDER_ADDRESS).length === 1 &&
    byScript(a, FINDER_ADDRESS)[0].value === 6503823, JSON.stringify(byScript(a, FINDER_ADDRESS)));
check('NO pool-wallet output', byScript(a, POOL_ADDRESS).length === 0);
check('exactly two outputs', a.length === 2, 'count=' + a.length);
check('coinbase total equals coinbasevalue', total(a) === 24088231, 'total=' + total(a));

console.log('B. solo generation — fees go to the finder');
var b = generationOutputs(Object.assign({}, TEMPLATE_914572, { fees: 5000 }), [], FINDER_SCRIPT);
check('finder paid remainder + fees', byScript(b, FINDER_ADDRESS).length === 1 &&
    byScript(b, FINDER_ADDRESS)[0].value === 6503823 + 5000);
check('governance still on the subsidy only', byScript(b, GOV_ADDRESS)[0].value === 17584408);
check('coinbase total equals subsidy + fees', total(b) === 24088231 + 5000);

console.log('C. solo generation — 914565 economics (governance + operator)');
var c = generationOutputs(TEMPLATE_914565, [], FINDER_SCRIPT);
check('governance output intact', byScript(c, GOV_ADDRESS).length === 1 &&
    byScript(c, GOV_ADDRESS)[0].value === 17584881);
check('operator output intact', byScript(c, OPS_ADDRESS).length === 1 &&
    byScript(c, OPS_ADDRESS)[0].value === 1204443);
check('finder paid the miner remainder', byScript(c, FINDER_ADDRESS).length === 1 &&
    byScript(c, FINDER_ADDRESS)[0].value === 5299555, JSON.stringify(byScript(c, FINDER_ADDRESS)));
check('NO pool-wallet output', byScript(c, POOL_ADDRESS).length === 0);
check('exactly three outputs', c.length === 3, 'count=' + c.length);
check('coinbase total equals coinbasevalue', total(c) === 24088879);

console.log('D. solo generation ignores recipient percentages');
var d = generationOutputs(TEMPLATE_914572,
    [{ percent: 0.5, script: util.addressToScript(OTHER_ADDRESS) }], FINDER_SCRIPT);
check('finder still paid the full remainder', byScript(d, FINDER_ADDRESS).length === 1 &&
    byScript(d, FINDER_ADDRESS)[0].value === 6503823);
check('recipient got nothing in solo', byScript(d, OTHER_ADDRESS).length === 0);

console.log('E. group generation — byte-identical to the legacy call');
var recip = [{ percent: 0.1, script: util.addressToScript(OTHER_ADDRESS) }];
var legacy = generationParts(TEMPLATE_914565, recip);
var undef7 = generationParts(TEMPLATE_914565, recip, undefined);
var null7 = generationParts(TEMPLATE_914565, recip, null);
check('7th arg undefined == legacy buffers',
    legacy[0].equals(undef7[0]) && legacy[1].equals(undef7[1]));
check('7th arg null == legacy buffers',
    legacy[0].equals(null7[0]) && legacy[1].equals(null7[1]));
var e = generationOutputs(TEMPLATE_914572, []);
check('group 914572 still pays the pool the remainder (pre-fix behaviour preserved)',
    byScript(e, POOL_ADDRESS).length === 1 && byScript(e, POOL_ADDRESS)[0].value === 6503823 &&
    byScript(e, FINDER_ADDRESS).length === 0);

/* ------------------------------------------------------------------ */
var NOW = Math.floor(Date.now() / 1000);
function jmOptions(scheme) {
    return {
        coin: { algorithm: 'sha256', reward: 'POW', txMessages: false },
        poolAddressScript: util.addressToScript(POOL_ADDRESS),
        recipients: [],
        payments: { scheme: scheme }
    };
}
function classicTemplate(height, prevHash) {
    return {
        height: height,
        previousblockhash: prevHash,
        version: 0x20002000,
        bits: '207fffff',
        target: '7fffff' + '0'.repeat(58), // == bits expansion: ~every other nonce is a candidate
        coinbasevalue: 24088231,
        coinbaseaux: { flags: '' },
        curtime: NOW,
        transactions: [],
        governanceAddress: GOV_ADDRESS,
        governanceReward: 17584408
    };
}
/* Submit shares for workerName until jobManager emits a block candidate;
   returns the winning { data, blockHex } or null. */
function mineUntilBlock(jm, workerName, extraNonce1) {
    var found = null;
    var listener = function (data, blockHex) { if (blockHex && !found) found = { data: data, blockHex: blockHex }; };
    jm.on('share', listener);
    var nTime = NOW.toString(16).padStart(8, '0');
    for (var i = 0; i < 500 && !found; i++) {
        jm.processShare(jm.currentJob.jobId, null, 1e-9, extraNonce1, '00000000',
            nTime, i.toString(16).padStart(8, '0'), '127.0.0.1', 3333, workerName);
    }
    jm.removeListener('share', listener);
    return found;
}
function blockOutputs(blockHex) {
    var buf = Buffer.from(blockHex, 'hex');
    var r = readVarInt(buf, 80); // tx count
    if (r[0] !== 1) throw new Error('expected exactly the coinbase in the test block');
    return parseTxOutputs(buf, r[1]);
}

console.log('F. jobManager — solo lane end to end');
var jm = new JobManager(jmOptions('solo'));
check('scheme resolved from pool options', jm.scheme === 'solo', 'scheme=' + jm.scheme);
check('template processed', jm.processTemplate(classicTemplate(914572, 'aa'.repeat(32))) === true);
var sharedParams = jm.currentJob.getJobParams();
var soloParams = jm.getJobParamsForWorker(FINDER_ADDRESS + '.v100');
check('solo job params served for the finder', !!soloParams && soloParams[0] === sharedParams[0]);
check('solo generation differs from the shared generation',
    !!soloParams && soloParams[3] !== sharedParams[3]);
check('unusable worker address falls back to the shared params',
    JSON.stringify(jm.getJobParamsForWorker('not-an-address.w1')) === JSON.stringify(sharedParams));
check('buildSoloTemplate rejects an unusable address',
    jm.buildSoloTemplate(jm.currentJob, 'not-an-address.w1') === null);

var win = mineUntilBlock(jm, FINDER_ADDRESS + '.v100', 'aabbccdd');
check('finder found a block candidate on their solo job', !!win);
if (win) {
    var fo = blockOutputs(win.blockHex);
    check('block pays the finder the full miner remainder',
        byScript(fo, FINDER_ADDRESS).length === 1 && byScript(fo, FINDER_ADDRESS)[0].value === 6503823,
        JSON.stringify(fo));
    check('block governance output intact',
        byScript(fo, GOV_ADDRESS).length === 1 && byScript(fo, GOV_ADDRESS)[0].value === 17584408);
    check('block has NO pool-wallet output', byScript(fo, POOL_ADDRESS).length === 0);
    check('share event names the finder', win.data.worker === FINDER_ADDRESS + '.v100');
}
var winShared = mineUntilBlock(jm, OTHER_ADDRESS + '.w2', '11223344');
check('a worker never served solo params still mines the shared job', !!winShared);
if (winShared) {
    var so = blockOutputs(winShared.blockHex);
    check('shared-job block pays the pool as today',
        byScript(so, POOL_ADDRESS).length === 1 && byScript(so, POOL_ADDRESS)[0].value === 6503823,
        JSON.stringify(so));
    check('shared-job block does not pay that worker directly',
        byScript(so, OTHER_ADDRESS).length === 0);
}

console.log('G. jobManager — group lane unchanged');
var jmGroup = new JobManager(jmOptions('pplns'));
check('scheme resolved as pplns', jmGroup.scheme === 'pplns', 'scheme=' + jmGroup.scheme);
jmGroup.processTemplate(classicTemplate(914572, 'dd'.repeat(32)));
check('no solo template in group mode', jmGroup.getSoloTemplate(FINDER_ADDRESS + '.v100') === null);
check('per-worker params are the shared params in group mode',
    JSON.stringify(jmGroup.getJobParamsForWorker(FINDER_ADDRESS + '.v100')) ===
    JSON.stringify(jmGroup.currentJob.getJobParams()));

/* ------------------------------------------------------------------ */
console.log('H. ethash buildJob — solo selection at job-build time');
async function ethashPart() {
    var jm3 = new JobManager(jmOptions('solo'));
    var pool = new events.EventEmitter();
    pool.options = { payments: { scheme: 'solo' } };
    pool.jobManager = jm3;
    pool.daemon = { cmd: function (m, p, cb) { if (cb) cb([{ error: null, response: null, instance: { index: 0 } }]); } };
    var handle = attachEthash(pool, { port: 0, logger: function () {} });
    await handle.started;

    function ethTemplate(height, prevHash) {
        return Object.assign(classicTemplate(height, prevHash), { version: 0x20004000 });
    }
    function coinbaseOutputs(entry) {
        return parseTxOutputs(entry.coinbaseBuffer, 0);
    }

    // Exactly one finder connected -> the job pays the finder.
    handle.server.clients['c1'] = { workerName: FINDER_ADDRESS + '.v100', authorized: true };
    jm3.processTemplate(ethTemplate(914572, 'bb'.repeat(32)));
    var entry1 = handle.jobs.get(String(jm3.currentJob.jobId));
    check('job registered', !!entry1);
    if (entry1) {
        var o1 = coinbaseOutputs(entry1);
        check('ethash solo job pays the finder the full miner remainder',
            byScript(o1, FINDER_ADDRESS).length === 1 && byScript(o1, FINDER_ADDRESS)[0].value === 6503823,
            JSON.stringify(o1));
        check('ethash solo job has NO pool-wallet output', byScript(o1, POOL_ADDRESS).length === 0);
        check('ethash solo job governance output intact',
            byScript(o1, GOV_ADDRESS).length === 1 && byScript(o1, GOV_ADDRESS)[0].value === 17584408);
        check('entry template carries the finder solo script',
            !!entry1.template.soloRecipientScript &&
            entry1.template.soloRecipientScript.equals(FINDER_SCRIPT));
    }

    // A second distinct finder connects -> shared job pays the pool.
    handle.server.clients['c2'] = { workerName: OTHER_ADDRESS + '.w2', authorized: true };
    jm3.processTemplate(ethTemplate(914573, 'cc'.repeat(32)));
    var entry2 = handle.jobs.get(String(jm3.currentJob.jobId));
    check('second job registered', !!entry2);
    if (entry2) {
        var o2 = coinbaseOutputs(entry2);
        check('two distinct finders — job falls back to the pool recipients',
            byScript(o2, POOL_ADDRESS).length === 1 && byScript(o2, POOL_ADDRESS)[0].value === 6503823,
            JSON.stringify(o2));
        check('fallback job pays neither worker directly',
            byScript(o2, FINDER_ADDRESS).length === 0 && byScript(o2, OTHER_ADDRESS).length === 0);
    }

    // Nobody connected -> shared job pays the pool.
    delete handle.server.clients['c1'];
    delete handle.server.clients['c2'];
    jm3.processTemplate(ethTemplate(914574, 'ee'.repeat(32)));
    var entry3 = handle.jobs.get(String(jm3.currentJob.jobId));
    check('third job registered', !!entry3);
    if (entry3) {
        var o3 = coinbaseOutputs(entry3);
        check('no finder connected — job pays the pool recipients',
            byScript(o3, POOL_ADDRESS).length === 1 && byScript(o3, POOL_ADDRESS)[0].value === 6503823);
    }

    await new Promise(function (resolve) { handle.close(resolve); });
}

var watchdog = setTimeout(function () { console.log('FAIL  watchdog timeout'); process.exit(2); }, 60000);
watchdog.unref();
ethashPart().then(function () {
    if (failures) {
        console.log(failures + ' GENERATION MODE CHECK(S) FAILED');
        process.exit(1);
    }
    console.log('ALL GENERATION MODE CHECKS PASSED');
}).catch(function (e) {
    console.log('FAIL  exception: ' + (e && e.stack || e));
    process.exit(1);
});
