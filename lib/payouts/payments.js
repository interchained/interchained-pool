'use strict';
/*
 * payments.js -- payout processor for PROP / PPLNS algos.
 *
 * createPaymentsProcessor({ daemon, ledger, config, logger }) ->
 *   { start, stop, runOnce(callback), isRunning (boolean getter) }
 *
 * config = {
 *   enabled,                       // false -> start()/runOnce() are no-ops
 *   dryRun,                        // DEFAULT TRUE when undefined
 *   feePercent,                    // e.g. 1 means 1%
 *   minPayout,                     // in COINS (e.g. 0.1); converted to sat
 *   confirmations,                 // required confirmation count
 *   intervalSeconds,               // start() timer period
 *   schemes: { sha256: { scheme: 'solo'|'pplns'|'prop', pplnsWindow },
 *              yespower: {...}, ethash: {...} }
 * }
 *
 * `daemon` is a lib/daemon.js DaemonInterface (or any object with the same
 * cmd(method, params, callback) shape): callback receives an ARRAY of
 * per-daemon results { error, response, instance }. Every call here uses
 * the FIRST non-error result; transport errors never mutate the ledger.
 *
 * ORPHAN RULE: a pending block is marked 'orphaned' ONLY when the daemon
 * definitively reports it gone:
 *   - getblock answers with error code -5 or a /block not found/i message, or
 *   - getblock succeeds but reports confirmations === -1 (not in main chain).
 * Any other error (daemon offline, timeout, ...) leaves the block 'pending'
 * untouched for the next run.
 *
 * PAYOUTS ARE PSBTs (Mark's requirement, phase-2 integration): a payout
 * batch is never a plain sendmany. The processor builds the transaction
 * as a PSBT via the daemon's walletcreatefundedpsbt (pool wallet), and
 * the recorded payout carries the base64 PSBT plus its stage:
 *   'created'   walletcreatefundedpsbt returned a funded PSBT
 *   'processed' walletprocesspsbt signed it (complete)
 *   'finalized' finalizepsbt extracted the network transaction (hex kept)
 *   'sent'      sendrawtransaction broadcast it (txid kept)
 * The stages are separate explicit steps so an external signer could
 * take the recorded PSBT from the 'created' stage onward instead.
 *
 * DRY-RUN (the default): builds and RECORDS the PSBT, then stops BEFORE
 * any signing stage -- walletprocesspsbt / finalizepsbt /
 * sendrawtransaction are never called. Balance semantics are unchanged
 * from the sendmany design: the dry run moves the paid amounts from
 * balances.pending to balances.paid, so dry-run state stays consistent
 * (the same miner is never "paid" twice across consecutive dry runs, and
 * carry-over math can be rehearsed end to end). The trade-off --
 * balances.paid includes rehearsed, not-yet-sent amounts -- is deliberate
 * and visible via payouts[].dryRun.
 *
 * LIVE RESUME: if a live batch stops mid-stages (daemon error, crash),
 * its amounts stay in balances.pending and the NEXT run resumes that
 * batch from its recorded PSBT/stage before building any new batch for
 * the algo, so a batch can never be double-created or double-paid.
 *
 * AMOUNTS FORMAT: PSBT output amounts are strings with exactly 8
 * decimals (e.g. "0.50000000"), produced by (sat / 1e8).toFixed(8), so
 * the JSON on the wire always carries exactly 8 decimal places (a JSON
 * number could not guarantee that). Bitcoin-family daemons accept
 * string amounts in PSBT outputs.
 *
 * Solo algos are skipped entirely in both steps: the coinbase already paid
 * the finder directly; the ledger only holds their shares/blocks for stats.
 */

var schemes = require('./schemes');

var SAT_PER_COIN = 100000000;

function coinsToSat(coins) { return Math.round((Number(coins) || 0) * SAT_PER_COIN); }
function satToCoinsString(sat) { return (sat / SAT_PER_COIN).toFixed(8); }

function firstGoodResult(results) {
    if (!Array.isArray(results)) return null;
    for (var i = 0; i < results.length; i++)
        if (results[i] && !results[i].error && results[i].response != null) return results[i];
    return null;
}

function isBlockNotFound(results) {
    if (!Array.isArray(results)) return false;
    return results.some(function (r) {
        if (!r || !r.error) return false;
        if (r.error.code === -5) return true;
        var msg = r.error.message || (typeof r.error === 'string' ? r.error : '');
        return /block not found/i.test(String(msg));
    });
}

function createPaymentsProcessor(deps) {
    deps = deps || {};
    var daemon = deps.daemon;
    var ledger = deps.ledger;
    var config = deps.config || {};
    var logger = deps.logger || function (severity, message) {
        console.log(severity + ': ' + message);
    };
    function log(severity, message) {
        try { logger(severity, '[payouts] ' + message); } catch (e) { /* never crash on logging */ }
    }

    var cfg = {
        enabled: config.enabled !== false,
        dryRun: (typeof config.dryRun === 'undefined') ? true : !!config.dryRun,
        feePercent: Number(config.feePercent) || 0,
        minPayoutSat: coinsToSat(typeof config.minPayout === 'number' ? config.minPayout : 0),
        confirmations: (typeof config.confirmations === 'number') ? config.confirmations : 100,
        intervalSeconds: (typeof config.intervalSeconds === 'number' && config.intervalSeconds > 0)
            ? config.intervalSeconds : 600,
        schemes: config.schemes || {}
    };

    function schemeFor(algo, block) {
        if (block && block.scheme) return block.scheme;
        var s = cfg.schemes[algo];
        return (s && s.scheme) || 'solo';
    }
    function pplnsWindowFor(algo) {
        var s = cfg.schemes[algo];
        return (s && typeof s.pplnsWindow === 'number') ? s.pplnsWindow : null;
    }

    var timer = null;
    var running = false;
    var payoutSeq = 0;

    /* Previous recorded block time for the algo, strictly before this
     * block -- the PROP round boundary. Any status counts (a round is
     * defined by when blocks were found, not by their payout fate). */
    function prevBlockTime(block) {
        var prev = null;
        ledger.getBlocks(block.algo).forEach(function (b) {
            if (b.hash === block.hash) return;
            if (b.time < block.time && (prev === null || b.time > prev)) prev = b.time;
            else if (b.time === block.time && b.height < block.height && prev === null) prev = b.time;
        });
        return prev;
    }

    function confirmBlock(block, confirmations, summary, done) {
        var scheme = schemeFor(block.algo, block);
        var weights;
        if (scheme === 'prop')
            weights = schemes.splitProp(ledger.getShares(block.algo), block, prevBlockTime(block));
        else if (scheme === 'pplns')
            weights = schemes.splitPplns(ledger.getShares(block.algo), block, pplnsWindowFor(block.algo));
        else { // unknown scheme string: never crash, never credit
            log('warning', 'block ' + block.hash + ' (algo ' + block.algo + ') has unknown scheme "' +
                scheme + '"; marking confirmed with no split');
            ledger.updateBlockStatus(block.hash, 'confirmed', confirmations);
            summary.blocksConfirmed++;
            return done();
        }

        var split = schemes.splitReward(block.reward, weights, cfg.feePercent, block.finder);
        ledger.updateBlockStatus(block.hash, 'confirmed', confirmations);
        summary.blocksConfirmed++;
        if (Object.keys(split.amounts).length === 0) {
            // Spec: empty split stays 'confirmed', amounts zero, warn, no crash.
            log('warning', 'block ' + block.hash + ' (algo ' + block.algo + ', height ' + block.height +
                ') confirmed with NO recorded shares; reward of ' + block.reward + ' sat undistributed');
            ledger.setBlockFields(block.hash, { amounts: {}, feeSat: 0, emptySplit: true });
            return done();
        }
        ledger.addBalances(block.algo, split.amounts);
        ledger.setBlockFields(block.hash, { amounts: split.amounts, feeSat: split.feeSat });
        log('debug', 'block ' + block.hash + ' (algo ' + block.algo + ', height ' + block.height +
            ') confirmed; credited ' + JSON.stringify(split.amounts) + ' sat, fee ' + split.feeSat + ' sat');
        done();
    }

    function checkBlock(block, summary, done) {
        daemon.cmd('getblock', [block.hash], function (results) {
            var good = firstGoodResult(results);
            if (!good) {
                if (isBlockNotFound(results)) {
                    ledger.updateBlockStatus(block.hash, 'orphaned');
                    summary.blocksOrphaned++;
                    log('warning', 'block ' + block.hash + ' (height ' + block.height +
                        ') not found by daemon; marked orphaned');
                } else {
                    log('warning', 'getblock failed for ' + block.hash +
                        '; leaving pending (not a definitive not-found)');
                }
                return done();
            }
            var conf = (typeof good.response.confirmations === 'number')
                ? good.response.confirmations : 0;
            if (conf === -1) { // daemon: block is not in the main chain
                ledger.updateBlockStatus(block.hash, 'orphaned', conf);
                summary.blocksOrphaned++;
                log('warning', 'block ' + block.hash + ' reports confirmations -1; marked orphaned');
                return done();
            }
            ledger.updateBlockStatus(block.hash, 'pending', conf);
            if (conf >= cfg.confirmations) confirmBlock(block, conf, summary, done);
            else done();
        });
    }

    /* Advance a live payout batch through the PSBT signing stages from
     * wherever its recorded stage is: created -> processed -> finalized
     * -> sent. Balances and block statuses move ONLY when the broadcast
     * succeeds. Any stage failure records the error on the payout and
     * leaves everything else untouched; the next run resumes the batch. */
    function progressLiveBatch(payoutId, summary, done) {
        function current() {
            var all = ledger.getPayouts();
            for (var i = 0; i < all.length; i++) if (all[i].id === payoutId) return all[i];
            return null;
        }
        function fail(stage, results) {
            var errs = (results || []).map(function (r) { return r && r.error; });
            ledger.updatePayout(payoutId, {
                error: 'stage ' + stage + ' failed: ' + JSON.stringify(errs)
            });
            log('error', 'payout ' + payoutId + ' stopped at stage ' + stage +
                ': ' + JSON.stringify(errs) + '; balances left untouched, will resume next run');
            done();
        }
        (function step() {
            var p = current();
            if (!p) return done();
            if (p.stage === 'created') {
                daemon.cmd('walletprocesspsbt', [p.psbt], function (results) {
                    var good = firstGoodResult(results);
                    if (!good || !good.response || typeof good.response.psbt !== 'string')
                        return fail('walletprocesspsbt', results);
                    if (good.response.complete === false) {
                        ledger.updatePayout(payoutId, {
                            error: 'walletprocesspsbt returned complete=false (pool wallet could not fully sign)'
                        });
                        log('error', 'payout ' + payoutId + ': walletprocesspsbt incomplete; left at stage created for external signing or a later run');
                        return done();
                    }
                    ledger.updatePayout(payoutId, { psbt: good.response.psbt, stage: 'processed', error: null });
                    step();
                });
            } else if (p.stage === 'processed') {
                daemon.cmd('finalizepsbt', [p.psbt], function (results) {
                    var good = firstGoodResult(results);
                    if (!good || !good.response || typeof good.response.hex !== 'string')
                        return fail('finalizepsbt', results);
                    if (good.response.complete === false) {
                        ledger.updatePayout(payoutId, {
                            error: 'finalizepsbt returned complete=false'
                        });
                        log('error', 'payout ' + payoutId + ': finalizepsbt incomplete; left at stage processed');
                        return done();
                    }
                    ledger.updatePayout(payoutId, { hex: good.response.hex, stage: 'finalized', error: null });
                    step();
                });
            } else if (p.stage === 'finalized') {
                daemon.cmd('sendrawtransaction', [p.hex], function (results) {
                    var good = firstGoodResult(results);
                    if (!good || typeof good.response !== 'string')
                        return fail('sendrawtransaction', results);
                    var txid = good.response;
                    ledger.updatePayout(payoutId, { txid: txid, stage: 'sent', error: null });
                    ledger.movePendingToPaid(p.algo, p.amounts);
                    ledger.getBlocks(p.algo).forEach(function (b) {
                        if (b.payoutId === payoutId)
                            ledger.updateBlockStatus(b.hash, 'paid', b.confirmations, payoutId);
                    });
                    var sent = current();
                    summary.payouts.push(sent);
                    log('debug', 'payout ' + payoutId + ' for ' + p.algo + ' SENT, txid ' + txid +
                        ', amounts ' + JSON.stringify(p.amounts));
                    done();
                });
            } else {
                done(); // 'sent' or unknown stage: nothing to advance
            }
        })();
    }

    function payoutAlgo(algo, summary, done) {
        var scheme = schemeFor(algo, null);
        if (scheme === 'solo') return done();

        /* Resume an incomplete live batch before building a new one: its
         * amounts are still inside balances.pending, so building a fresh
         * batch now would double-count them. */
        var incomplete = ledger.getPayouts().filter(function (p) {
            return p.algo === algo && !p.dryRun &&
                (p.stage === 'created' || p.stage === 'processed' || p.stage === 'finalized');
        });
        if (incomplete.length > 0) return progressLiveBatch(incomplete[0].id, summary, done);

        var balances = ledger.getBalances()[algo] || {};
        var amountsSat = {};
        Object.keys(balances).forEach(function (address) {
            if (balances[address].pending >= cfg.minPayoutSat && balances[address].pending > 0)
                amountsSat[address] = balances[address].pending;
        });
        var addresses = Object.keys(amountsSat);
        if (addresses.length === 0) return done(); // nobody at threshold: skip

        // Confirmed, not-yet-paid-out blocks of this algo ride along with
        // this payout (their amounts are part of the balances being paid,
        // together with any sub-threshold carry-over from earlier rounds).
        var includedBlocks = ledger.getBlocks(algo).filter(function (b) {
            return b.status === 'confirmed' && !b.payoutId;
        });
        var feeSat = includedBlocks.reduce(function (sum, b) { return sum + (b.feeSat || 0); }, 0);
        var heights = includedBlocks.map(function (b) { return b.height; });

        var amountsCoins = {};
        addresses.forEach(function (a) { amountsCoins[a] = satToCoinsString(amountsSat[a]); });

        /* Build the batch as a PSBT from the pool wallet. The batch is
         * recorded the moment the PSBT exists (stage 'created', with the
         * base64 PSBT) in BOTH modes -- the recorded PSBT is the batch's
         * identity and the artifact an external signer could take over. */
        daemon.cmd('walletcreatefundedpsbt', [[], amountsCoins], function (results) {
            var good = firstGoodResult(results);
            if (!good || !good.response || typeof good.response.psbt !== 'string') {
                // Nothing recorded, balances untouched; a later run retries.
                log('error', 'walletcreatefundedpsbt failed for algo ' + algo + ': ' +
                    JSON.stringify((results || []).map(function (r) { return r && r.error; })) +
                    '; balances left untouched, no payout recorded');
                return done();
            }
            payoutSeq++;
            var payout = ledger.recordPayout({
                id: 'payout-' + algo + '-' + Date.now() + '-' + payoutSeq,
                algo: algo, time: Math.floor(Date.now() / 1000),
                dryRun: cfg.dryRun, txid: null,
                amounts: amountsSat, blocks: heights, fee: feeSat,
                psbt: good.response.psbt, stage: 'created'
            });

            if (cfg.dryRun) {
                /* Dry-run stops BEFORE signing: the PSBT is built and
                 * recorded, the signing-stage RPCs are never called, and
                 * balances move exactly as in the documented dry-run
                 * semantics (rehearsal settles the batch). */
                ledger.movePendingToPaid(algo, amountsSat);
                includedBlocks.forEach(function (b) {
                    ledger.updateBlockStatus(b.hash, 'paid', b.confirmations, payout.id);
                });
                summary.payouts.push(payout);
                log('special', 'DRY-RUN payout ' + payout.id + ' for ' + algo +
                    ': PSBT built and recorded (stage created), amounts ' +
                    JSON.stringify(amountsCoins) + ' -- NOT signed, NOT broadcast');
                return done();
            }

            /* Live: link the blocks to this batch now (they flip to
             * 'paid' only when the broadcast lands), then walk the
             * signing stages. */
            includedBlocks.forEach(function (b) {
                ledger.updateBlockStatus(b.hash, 'confirmed', b.confirmations, payout.id);
            });
            log('debug', 'payout ' + payout.id + ' for ' + algo + ' created as PSBT, amounts ' +
                JSON.stringify(amountsCoins) + '; advancing signing stages');
            progressLiveBatch(payout.id, summary, done);
        });
    }

    function runOnce(callback) {
        callback = callback || function () {};
        if (!cfg.enabled) {
            log('debug', 'payments disabled in config; runOnce is a no-op');
            return process.nextTick(function () {
                callback(null, { blocksChecked: 0, blocksConfirmed: 0, blocksOrphaned: 0, payouts: [] });
            });
        }
        if (running) {
            return process.nextTick(function () {
                callback(new Error('payout run already in progress'));
            });
        }
        if (!daemon || typeof daemon.cmd !== 'function' || !ledger) {
            return process.nextTick(function () {
                callback(new Error('payments processor requires a daemon (cmd) and a ledger'));
            });
        }
        running = true;
        var summary = { blocksChecked: 0, blocksConfirmed: 0, blocksOrphaned: 0, payouts: [] };

        var pendingBlocks = ledger.getBlocks().filter(function (b) {
            return b.status === 'pending' && schemeFor(b.algo, b) !== 'solo';
        });

        (function nextBlock(i) {
            if (i >= pendingBlocks.length) return payoutStep();
            summary.blocksChecked++;
            checkBlock(pendingBlocks[i], summary, function () { nextBlock(i + 1); });
        })(0);

        function payoutStep() {
            var algos = {};
            Object.keys(cfg.schemes).forEach(function (a) { algos[a] = true; });
            Object.keys(ledger.getBalances()).forEach(function (a) { algos[a] = true; });
            var list = Object.keys(algos);
            (function nextAlgo(i) {
                if (i >= list.length) {
                    running = false;
                    return callback(null, summary);
                }
                payoutAlgo(list[i], summary, function () { nextAlgo(i + 1); });
            })(0);
        }
    }

    function start() {
        if (!cfg.enabled) { log('warning', 'payments disabled in config; not starting'); return; }
        if (timer) return;
        timer = setInterval(function () {
            runOnce(function (err) { if (err) log('error', 'payout run failed: ' + err.message); });
        }, cfg.intervalSeconds * 1000);
        if (timer.unref) timer.unref();
        log('debug', 'payments processor started (interval ' + cfg.intervalSeconds + 's, dryRun=' + cfg.dryRun + ')');
    }

    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
    }

    var processor = { start: start, stop: stop, runOnce: runOnce, config: cfg };
    Object.defineProperty(processor, 'isRunning', {
        enumerable: true,
        get: function () { return running || timer !== null; }
    });
    return processor;
}

module.exports = { createPaymentsProcessor: createPaymentsProcessor, coinsToSat: coinsToSat };
