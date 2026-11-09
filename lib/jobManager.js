var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');



var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');
var payoutsAttach = require('./payouts/attach.js');



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

/* The payout script for a stratum worker name. On every transport the
   authorize username is the miner's payout address with an optional
   ".worker" suffix, so the finding miner's address is the part before
   the first dot. Returns null when the address is missing or does not
   decode — callers then fall back to the pool recipients rather than
   build an unspendable coinbase. */
var payoutScriptForWorker = function(workerName){
    if (typeof workerName !== 'string') return null;
    var address = workerName.split('.')[0].trim();
    if (!address) return null;
    try {
        return util.addressToScript(address);
    } catch (e) {
        return null;
    }
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

    /* Payout scheme for this lane, resolved from the pool options with
       the same source of truth the payouts ledger attach uses
       (lib/payouts/attach.js resolveScheme: options.payments /
       options.payouts, default 'solo'). The coinbase construction is
       mode-based: in solo mode a block pays the FINDING miner directly
       (per-worker templates below); in group modes (pplns/prop) it pays
       the pool recipients and the payments processor splits it later. */
    this.scheme = payoutsAttach.resolveScheme({ options: options }, options.coin.algorithm);

    /* Per-worker solo templates: workerName -> BlockTemplate built from
       the current job's rpcData with that worker's own payout script as
       the generation's solo recipient. The coinbase is committed by the
       work miners hash over (merkle root in the header), so the finder
       must be chosen when the job is BUILT — a share-time coinbase swap
       would change the merkle root and invalidate the share. A solo
       template is therefore materialized when a worker is served
       per-worker job params (getJobParamsForWorker); processShare then
       validates that worker's shares against the very generation they
       were given. A worker never served solo params keeps the shared
       template, byte-identical to group behaviour. */
    this.soloTemplates = {};

    this.buildSoloTemplate = function(sourceTemplate, workerName){
        if (!sourceTemplate) return null;
        var script = payoutScriptForWorker(workerName);
        if (!script) return null;
        return new blockTemplate(
            sourceTemplate.jobId,
            sourceTemplate.rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients,
            options.coin.algorithm,
            script
        );
    };

    this.getSoloTemplate = function(workerName){
        if (_this.scheme !== 'solo' || !_this.currentJob) return null;
        var cached = _this.soloTemplates[workerName];
        if (cached && cached.jobId === _this.currentJob.jobId) return cached;
        var built = _this.buildSoloTemplate(_this.currentJob, workerName);
        if (built) _this.soloTemplates[workerName] = built;
        return built;
    };

    /* Job params to serve one worker: their solo params in solo mode,
       the shared params otherwise (or when the worker's address is
       unusable — the job then pays the pool recipients as today). */
    this.getJobParamsForWorker = function(workerName){
        var solo = _this.getSoloTemplate(workerName);
        if (solo) return solo.getJobParams();
        return _this.currentJob ? _this.currentJob.getJobParams() : null;
    };

    function peekSoloTemplate(workerName, jobId){
        var t = _this.soloTemplates[workerName];
        return (t && t.jobId === jobId) ? t : null;
    }

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
            options.recipients,
            options.coin.algorithm
        );

        _this.currentJob = tmpBlockTemplate;

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
            options.recipients,
            options.coin.algorithm
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

        /* Solo mode: if this worker was served per-worker job params,
           their shares were hashed over their solo template (same jobId,
           generation paying the worker) — validate against it. This
           only PEEKS: a template is never created at share time, because
           a generation the miner never received could not match the
           work they hashed. Workers without a solo template keep the
           shared job above, unchanged. */
        if (_this.scheme === 'solo' && workerName) {
            var soloJob = peekSoloTemplate(workerName, jobId);
            if (soloJob) job = soloJob;
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
        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHashInvalid;
        var blockHash;
        var blockHex;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;

        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //Check if share is a block candidate (matched network difficulty)
        if (job.target.ge(headerBigNum)){
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
            if (shareDiff / difficulty < 0.99){

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
            algo: options.coin.algorithm,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            /* Fairness (phase 3): `difficulty` above is the ACCEPTED
               difficulty (adjusted to previousDifficulty when the share
               met a pre-retarget difficulty) -- it is the weighting
               input for payout accounting, never shareDiff. `time` is
               the submission time (seconds) so payout windows are
               bounded by share/block EVENTS, not by whenever async
               block submission finishes. The submission identity fields
               (extraNonce1/extraNonce2/nTime/nonce) let accounting
               deduplicate the exact same share if it is ever emitted
               twice -- registerSubmit() above already rejects it at
               this layer. */
            time: submitTime,
            extraNonce1: extraNonce1,
            extraNonce2: extraNonce2,
            nTime: nTime,
            nonce: nonce,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff : blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;

module.exports.payoutScriptForWorker = payoutScriptForWorker;
