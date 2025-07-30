var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');



var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');


const SCALE = bignum('1000000000000000000'); // 1e18

//Unique extranonce per subscriber
var ExtraNonceCounter = function(configInstanceId){

    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;

    this.next = function(){
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };

    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function(){
    var counter = 0;

    this.next = function(){
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/
var JobManager = module.exports = function JobManager(options){


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    var shareMultiplier = algos[options.coin.algorithm].multiplier;
    
    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = new Buffer('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function(){
        switch(options.coin.algorithm){
            case 'keccak':
            case 'fugue':
            case 'groestl':
                if (options.coin.normalHashing === true)
                    return util.sha256d;
                else
                    return util.sha256;
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'scrypt':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-jane':
                if (options.coin.reward === 'POS') {
                    return function (d) {
                        return util.reverseBuffer(hashDigest.apply(this, arguments));
                    };
                }
            case 'scrypt-n':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function () {
                    return util.reverseBuffer(hashDigest.apply(this, arguments));
                };
        }
    })();

    this.updateCurrentJob = function(rpcData){

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        _this.currentJob = tmpBlockTemplate;
	let networkDiff = tmpBlockTemplate.difficulty;
	    console.log("DEBUG Network Difficulty:", networkDiff);
	    this.currentNetworkDiff = networkDiff;
        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function(rpcData){

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if  (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash){
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName){
        var shareError = function(error){
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var submitTime = Date.now() / 1000 | 0;

        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId ) {
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }

        var nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }

        if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }

        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce)) {
            return shareError([22, 'duplicate share']);
        }


        var extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        var extraNonce2Buffer = new Buffer(extraNonce2, 'hex');

        var coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        var coinbaseHash = coinbaseHasher(coinbaseBuffer);

        var merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');

        var headerBuffer = job.serializeHeader(merkleRoot, nTime, nonce);
        var headerHash = hashDigest(headerBuffer, nTimeInt);
        //var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});
	//var headerBigNum = bignum.fromBuffer(
//		    Buffer.from(headerHash, 'hex').reverse(),
//		    { endian: 'big', size: 32 }
//	);
	var headerBigNum = bignum.fromBuffer(Buffer.from(headerHash).reverse(), { endian: 'big' });

        var blockHashInvalid;
        var blockHash;
        var blockHex;

	  //  var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
	// const shareDiffBN = global.diff1.div(headerBigNum);
	// var shareDiff = shareDiffBN.toNumber() * shareMultiplier;
        // Compute share difficulty using fixed-point big integer math
	//var shareDiffBN = global.diff1.div(headerBigNum); 
	  //  console.log('DEBUG shareDiffBN:', shareDiffBN.toString());

	    //var shareDiff = parseFloat(shareDiffBN.toString()) * shareMultiplier;
	//var shareDiffBN = global.diff1.mul(1e12).div(headerBigNum);  // Scale up by 10^12
	//var shareDiff = parseFloat(shareDiffBN.toString()) / 1e12;
	//shareDiff = shareDiff * shareMultiplier;
const diff1Hex = '00000000ffff0000000000000000000000000000000000000000000000000000';
	    const diff2 = bignum.fromBuffer(Buffer.from(diff1Hex, 'hex'), { endian: 'big' });

	    console.log('DEBUG diff1 (hex padded):', diff1Hex);
	    console.log('DEBUG diff1 (decimal):', diff2.toString());

	    // var shareDiff = parseFloat(global.diff1.toString()) / parseFloat(headerBigNum.toString()) * shareMultiplier;
//	    var shareDiff = diff2.mul(job.target).div(headerBigNum);
	    // working but low diff shares 
	   // var shareDiff = parseFloat(diff2.toString()) / parseFloat(headerBigNum.toString());
	    //var shareDiff = parseFloat(diff2.toString()) / parseFloat(headerBigNum.toString());
	    //var networkDiff = parseFloat(job.difficulty);
	    //var normalizedDiff = shareDiff / networkDiff;
	    
	const DIFF1_BN = bignum.fromBuffer(
		    Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex'),
		    { endian: 'big' }
	);

//	    const shareDiff = parseFloat(DIFF1_BN.toString()) / parseFloat(headerBigNum.toString());
//
//	    const shareDiffFloat = shareDiff;
//	const networkDiff = parseFloat(job.difficulty);
//	    const normalizedDiff = shareDiff / networkDiff;
//
//	    console.log("DEBUG shareDiff:", shareDiff);
//	    console.log("DEBUG normalizedDiff:", normalizedDiff);

// Use the job's target (network target)
var targetBN = job.target; // job.target is already a bignum from blockTemplate

// Calculate share difficulty directly from target
var shareDiff = targetBN.div(headerBigNum);

// DEBUG
console.log("DEBUG targetBN:", targetBN.toString(16));
console.log("DEBUG headerBigNum:", headerBigNum.toString(16));
console.log("DEBUG shareDiff:", shareDiff.toString());

	    //var shareDiff = parseFloat(diff2.toString()) / parseFloat(headerBigNum.toString());
	    //console.log("DEBUG shareDiff:", shareDiff);


	    console.log("DEBUG headerHash:", headerHash.toString('hex'));
	    console.log("DEBUG headerBigNum (hex):", headerBigNum.toString(16));
	    console.log("DEBUG headerBigNum (decimal):", headerBigNum.toString());
	    
	var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //Check if share is a block candidate (matched network difficulty)
        //if (job.target.ge(headerBigNum)){
        //if (headerBigNum.cmp(job.target) <= 0) { // valid block candidate
	if (headerBigNum.le(targetBN)) {
            console.log("DEBUG block candidate! hash:", headerBigNum.toString(16));
	    blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer).toString('hex');
            if (options.coin.algorithm === 'blake' || options.coin.algorithm === 'neoscrypt') {                
                blockHash = util.reverseBuffer(util.sha256d(headerBuffer, nTime)).toString('hex');
            }
            else {
            	blockHash = blockHasher(headerBuffer, nTime).toString('hex');
            }
        }
        else {
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
	    //if (shareDiff / difficulty < 0.99){
	    //if (shareDiff < difficulty * 0.99) {
            //if (normalizedDiff < difficulty) {
	    if (shareDiff.lt(bignum(difficulty))) {
		//Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty){
                    difficulty = previousDifficulty;
                }
                else{
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }


        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: parseFloat(shareDiff.toString()).toFixed(8),
            blockDiff : blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
