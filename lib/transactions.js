
var util = require('./util.js');


/*
function Transaction(params){

    var version = params.version || 1,
        inputs = params.inputs || [],
        outputs = params.outputs || [],
        lockTime = params.lockTime || 0;


    this.toBuffer = function(){
        return Buffer.concat([
            binpack.packUInt32(version, 'little'),
            util.varIntBuffer(inputs.length),
            Buffer.concat(inputs.map(function(i){ return i.toBuffer() })),
            util.varIntBuffer(outputs.length),
            Buffer.concat(outputs.map(function(o){ return o.toBuffer() })),
            binpack.packUInt32(lockTime, 'little')
        ]);
    };

    this.inputs = inputs;
    this.outputs = outputs;

}

function TransactionInput(params){

    var prevOutHash = params.prevOutHash || 0,
        prevOutIndex = params.prevOutIndex,
        sigScript = params.sigScript,
        sequence = params.sequence || 0;


    this.toBuffer = function(){
        sigScriptBuffer = sigScript.toBuffer();
        console.log('scriptSig length ' + sigScriptBuffer.length);
        return Buffer.concat([
            util.uint256BufferFromHash(prevOutHash),
            binpack.packUInt32(prevOutIndex, 'little'),
            util.varIntBuffer(sigScriptBuffer.length),
            sigScriptBuffer,
            binpack.packUInt32(sequence)
        ]);
    };
}

function TransactionOutput(params){

    var value = params.value,
        pkScriptBuffer = params.pkScriptBuffer;

    this.toBuffer = function(){
        return Buffer.concat([
            binpack.packInt64(value, 'little'),
            util.varIntBuffer(pkScriptBuffer.length),
            pkScriptBuffer
        ]);
    };
}

function ScriptSig(params){

    var height = params.height,
        flags = params.flags,
        extraNoncePlaceholder = params.extraNoncePlaceholder;

    this.toBuffer = function(){

        return Buffer.concat([
            util.serializeNumber(height),
            new Buffer(flags, 'hex'),
            util.serializeNumber(Date.now() / 1000 | 0),
            new Buffer([extraNoncePlaceholder.length]),
            extraNoncePlaceholder,
            util.serializeString('/nodeStratum/')
        ]);
    }
};


var Generation = exports.Generation = function Generation(rpcData, publicKey, extraNoncePlaceholder){

    var tx = new Transaction({
        inputs: [new TransactionInput({
            prevOutIndex : Math.pow(2, 32) - 1,
            sigScript    : new ScriptSig({
                height                : rpcData.height,
                flags                 : rpcData.coinbaseaux.flags,
                extraNoncePlaceholder : extraNoncePlaceholder
            })
        })],
        outputs: [new TransactionOutput({
            value          : rpcData.coinbasevalue,
            pkScriptBuffer : publicKey
        })]
    });

    var txBuffer = tx.toBuffer();
    var epIndex  = buffertools.indexOf(txBuffer, extraNoncePlaceholder);
    var p1       = txBuffer.slice(0, epIndex);
    var p2       = txBuffer.slice(epIndex + extraNoncePlaceholder.length);

    this.transaction = tx;
    this.coinbase = [p1, p2];

};
*/


/*
     ^^^^ The above code was a bit slow. The below code is uglier but optimized.
 */

function writeTxOut(valueSatoshis, scriptPubKey) {
    if (!Buffer.isBuffer(scriptPubKey)) {
        throw new Error('writeTxOut: scriptPubKey must be a Buffer');
    }

    return Buffer.concat([
        util.packUInt64LE(valueSatoshis),           // 8 bytes: value in satoshis (little-endian)
        util.varIntBuffer(scriptPubKey.length),     // VarInt: length of the script
        scriptPubKey                               // ScriptPubKey bytes
    ]);
}

/*
This function creates the generation transaction that accepts the reward for
successfully mining a new block.
For some (probably outdated and incorrect) documentation about whats kinda going on here,
see: https://en.bitcoin.it/wiki/Protocol_specification#tx
 */
function generateOutputTransactions(poolScript, recipients, rpcData, governanceScript, nodeOperatorsScript) {
    const coinbaseValue = rpcData.coinbasevalue || 0; // total reward in satoshis
    const governanceReward = rpcData.governanceReward || 0;
    const nodeOpsReward = rpcData.nodeOperatorsReward || 0;

    let outputs = [];
    let totalExtra = 0;

    // Add custom recipients (like donations, etc.)
    if (Array.isArray(recipients)) {
        for (const r of recipients) {
            if (r.address && typeof r.address === 'string' && r.address.trim() !== '') {
                const script = util.addressToScript(r.address);
                outputs.push(writeTxOut(Math.floor(r.amount), script));
                totalExtra += Math.floor(r.amount);
            }
        }
    }

    // Node Operators output (only if script is valid)
    if (nodeOperatorsScript && Buffer.isBuffer(nodeOperatorsScript) && nodeOpsReward > 0) {
        outputs.push(writeTxOut(nodeOpsReward, nodeOperatorsScript));
        totalExtra += nodeOpsReward;
    }

    // Governance output (only if script is valid)
    if (governanceScript && Buffer.isBuffer(governanceScript) && governanceReward > 0) {
        outputs.push(writeTxOut(governanceReward, governanceScript));
        totalExtra += governanceReward;
    }

    // Miner/Pool output = remaining balance
    const poolValue = coinbaseValue - totalExtra;
    if (poolValue < 0) {
        throw new Error('Outputs exceed coinbase reward');
    }
    outputs.unshift(writeTxOut(poolValue, poolScript));

    return Buffer.concat([util.varIntBuffer(outputs.length), ...outputs]);
}

exports.CreateGeneration = function (rpcData, poolAddressScript, extraNoncePlaceholder, rewardFlag, txMessages, recipients) {
    const governanceAddr = rpcData.governanceAddress;
console.log(governanceAddr);
    const governanceScript = governanceAddr ? util.addressToScript(governanceAddr.toString()) : null;
console.log(governanceScript);
    const nodeOpsAddr = rpcData.nodeOperatorsAddress || null;
    const nodeOperatorsScript = null; // nodeOpsAddr ? util.addressToScript(nodeOpsAddr) : null;

    const txVersion = txMessages === true ? 2 : 1;
    const txLockTime = 0;

    const txTimestamp = rewardFlag === 'POS'
        ? util.packUInt32LE(rpcData.curtime)
        : Buffer.alloc(0);

    const txComment = txMessages === true
        ? util.serializeString('https://github.com/zone117x/node-stratum')
        : Buffer.alloc(0);

    const txInputsCount = 1;
    const txInPrevOutHash = '';
    const txInPrevOutIndex = Math.pow(2, 32) - 1;
    const txInSequence = 0;

    const scriptSigPart1 = Buffer.concat([
        util.serializeNumber(rpcData.height),
        Buffer.alloc(0),
        util.serializeNumber((Date.now() / 1000) | 0),
        Buffer.from([extraNoncePlaceholder.length])
    ]);

    const scriptSigPart2 = util.serializeString('/nodeStratum/');

    const p1 = Buffer.concat([
        util.packUInt32LE(txVersion),
        txTimestamp,
        util.varIntBuffer(txInputsCount),
        util.uint256BufferFromHash(txInPrevOutHash),
        util.packUInt32LE(txInPrevOutIndex),
        util.varIntBuffer(scriptSigPart1.length + extraNoncePlaceholder.length + scriptSigPart2.length),
        scriptSigPart1
    ]);

    const outputTransactions = generateOutputTransactions(poolAddressScript, recipients, rpcData, governanceScript, nodeOperatorsScript);

    const p2 = Buffer.concat([
        scriptSigPart2,
        util.packUInt32LE(txInSequence),
        outputTransactions,
        util.packUInt32LE(txLockTime),
        txComment
    ]);

    return [p1, p2];
};

