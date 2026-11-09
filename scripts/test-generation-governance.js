'use strict';
/*
 * test-generation-governance.js — the Interchained three-way coinbase
 * split in transactions.CreateGeneration.
 *
 * The daemon's getblocktemplate precomputes the split (governanceReward
 * = 73% of the subsidy to governanceAddress, nodeOperatorsReward = 5%
 * to nodeOperatorsAddress, minerReward = remainder + fees) and
 * ConnectBlock rejects any block whose coinbase lacks the governance
 * output ("missing-governance"). The pool paid out none of it until
 * 2026-11-09, losing a found Ethash block at height 914565. These
 * checks pin the split using that block's real numbers:
 *
 *   subsidy (coinbasevalue)  24,088,879
 *   governance (73%)         17,584,881  (24088879 * 7300 / 10000, trunc)
 *   operators  (5%)           1,204,443  (24088879 *  500 / 10000, trunc)
 *   miner remainder           5,299,555
 *
 * Run: node scripts/test-generation-governance.js
 */

var transactions = require('../lib/transactions.js');
var util = require('../lib/util.js');
var bitcoin = require('bitcoinjs-lib');
var network = require('../lib/interchained-network.js');

var failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log('  ok   ' + name); }
    else { failures++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

var GOV_ADDRESS = 'itc1qg408c5vw9u4s47e5l5v5q0s0u98hprg8w94ffp'; // chainparams mainnet governance wallet
var POOL_ADDRESS = 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu'; // miner wallet (pool recipient stand-in)
var OPS_ADDRESS = 'itc1qhrtjdc02wgq0ary38prp6xel3mydcpjvkyhp4x'; // pool wallet (operator stand-in)
var RECIPIENT_ADDRESS = bitcoin.payments.p2wpkh({
    hash: Buffer.from('07'.repeat(20), 'hex'), network: network
}).address;

var SUBSIDY = 24088879;
var GOV_REWARD = 17584881;
var OPS_REWARD = 1204443;
var MINER_REMAINDER = SUBSIDY - GOV_REWARD - OPS_REWARD; // 5299555

var PLACEHOLDER = Buffer.from('f000000ff111111f', 'hex'); // daemon extranonce_marker

function readVarInt(buf, pos) {
    var b = buf[pos];
    if (b < 0xfd) return [b, pos + 1];
    if (b === 0xfd) return [buf.readUInt16LE(pos + 1), pos + 3];
    if (b === 0xfe) return [buf.readUInt32LE(pos + 1), pos + 5];
    return [Number(buf.readBigUInt64LE(pos + 1)), pos + 9];
}

/* Parse the outputs of a coinbase built by CreateGeneration:
   full tx = p1 + extranoncePlaceholder + p2. */
function parseOutputs(rpcData, recipients) {
    var parts = transactions.CreateGeneration(
        rpcData,
        util.addressToScript(POOL_ADDRESS),
        PLACEHOLDER,
        'POW',
        false,
        recipients || []
    );
    var tx = Buffer.concat([parts[0], PLACEHOLDER, parts[1]]);
    var pos = 4; // version
    var nIn; var r = readVarInt(tx, pos); nIn = r[0]; pos = r[1];
    if (nIn !== 1) throw new Error('expected 1 input, got ' + nIn);
    pos += 32 + 4; // prev hash + index
    var scriptLen; r = readVarInt(tx, pos); scriptLen = r[0]; pos = r[1];
    pos += scriptLen + 4; // scriptSig + sequence
    var nOut; r = readVarInt(tx, pos); nOut = r[0]; pos = r[1];
    var outputs = [];
    for (var i = 0; i < nOut; i++) {
        var value = Number(tx.readBigUInt64LE(pos)); pos += 8;
        var sl; r = readVarInt(tx, pos); sl = r[0]; pos = r[1];
        outputs.push({ value: value, scriptHex: tx.slice(pos, pos + sl).toString('hex') });
        pos += sl;
    }
    return outputs;
}

function byScript(outputs, address) {
    var scriptHex = util.addressToScript(address).toString('hex');
    return outputs.filter(function (o) { return o.scriptHex === scriptHex; });
}
function total(outputs) {
    return outputs.reduce(function (s, o) { return s + o.value; }, 0);
}

function splitTemplate(extra) {
    return Object.assign({
        height: 914565,
        coinbasevalue: SUBSIDY,
        coinbaseaux: { flags: '' },
        governanceAddress: GOV_ADDRESS,
        governanceReward: GOV_REWARD,
        nodeOperatorsAddress: OPS_ADDRESS,
        nodeOperatorsReward: OPS_REWARD
    }, extra || {});
}

console.log('A. split template, no fees field, no recipients');
var a = parseOutputs(splitTemplate(), []);
check('governance output pays exactly governanceReward',
    byScript(a, GOV_ADDRESS).length === 1 && byScript(a, GOV_ADDRESS)[0].value === GOV_REWARD,
    JSON.stringify(byScript(a, GOV_ADDRESS)));
check('operator output pays exactly nodeOperatorsReward',
    byScript(a, OPS_ADDRESS).length === 1 && byScript(a, OPS_ADDRESS)[0].value === OPS_REWARD);
check('pool output is the miner remainder',
    byScript(a, POOL_ADDRESS).length === 1 && byScript(a, POOL_ADDRESS)[0].value === MINER_REMAINDER,
    JSON.stringify(byScript(a, POOL_ADDRESS)));
check('coinbase total equals coinbasevalue', total(a) === SUBSIDY, 'total=' + total(a));

console.log('B. split template with fees — miners get the fees');
var b = parseOutputs(splitTemplate({ fees: 100000 }), []);
check('pool output is miner remainder + fees',
    byScript(b, POOL_ADDRESS).length === 1 && byScript(b, POOL_ADDRESS)[0].value === MINER_REMAINDER + 100000,
    JSON.stringify(byScript(b, POOL_ADDRESS)));
check('coinbase total equals subsidy + fees', total(b) === SUBSIDY + 100000, 'total=' + total(b));
check('governance still paid on the subsidy only',
    byScript(b, GOV_ADDRESS).length === 1 && byScript(b, GOV_ADDRESS)[0].value === GOV_REWARD);

console.log('C. recipient percentages apply to the miner remainder');
var recipScript = util.addressToScript(RECIPIENT_ADDRESS);
var c = parseOutputs(splitTemplate(), [{ percent: 0.1, script: recipScript }]);
var recipOut = c.filter(function (o) { return o.scriptHex === recipScript.toString('hex'); });
check('recipient gets 10% of the miner remainder',
    recipOut.length === 1 && recipOut[0].value === Math.floor(0.1 * MINER_REMAINDER),
    JSON.stringify(recipOut));
check('pool keeps the rest of the miner remainder',
    byScript(c, POOL_ADDRESS).length === 1 &&
    byScript(c, POOL_ADDRESS)[0].value === MINER_REMAINDER - Math.floor(0.1 * MINER_REMAINDER));
check('coinbase total still equals coinbasevalue', total(c) === SUBSIDY, 'total=' + total(c));

console.log('D. legacy template without the split fields — behaviour unchanged');
var d = parseOutputs({ height: 914565, coinbasevalue: SUBSIDY, coinbaseaux: { flags: '' } }, []);
check('single pool output for the full coinbasevalue',
    d.length === 1 && d[0].value === SUBSIDY &&
    d[0].scriptHex === util.addressToScript(POOL_ADDRESS).toString('hex'),
    JSON.stringify(d));

if (failures) {
    console.log(failures + ' GOVERNANCE CHECK(S) FAILED');
    process.exit(1);
}
console.log('ALL GENERATION GOVERNANCE CHECKS PASSED');
