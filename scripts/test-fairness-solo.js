'use strict';
/*
 * test-fairness-solo.js -- settled SOLO blocks in reconciliation and
 * breakdowns (the publish-anyway fairness lane).
 *
 * Live bug (2026-11-09): the pool runs solo on every lane; block
 * 914572 settled on chain, yet /api/reconcile showed settledBlocks 0
 * with a vacuously-balanced all-zero aggregate and the block's
 * breakdown showed settled:false while crediting the finder the FULL
 * coinbase subsidy -- including the governance carve-out that the
 * coinbase paid to the governance wallet, never to the pool.
 *
 * Semantics pinned here (see docs/FAIRNESS.md):
 * - a solo block is settled once 'confirmed' (or 'paid'); its split
 *   is deterministic: governance (73% of subsidy, chain consensus) is
 *   never pool revenue; the finder is credited 100% of the remainder
 *   (the pool-creditable amount), fee 0, paid by the coinbase itself;
 * - reconcile counts it (settledBlocks, rewardIn = creditable), the
 *   aggregate equation holds with real numbers, and solo credits
 *   never enter balances / FIFO carry-over;
 * - a recorded solo split that disagrees with the coinbase economics
 *   is a discrepancy, never silently passed.
 *
 * Fixture economics are block 914572's real ones: subsidy 24,088,231
 * sat; governance 17,584,408 sat (floor(24088231 * 7300/10000));
 * pool-creditable 6,503,823 sat to the finder.
 *
 * Run: node scripts/test-fairness-solo.js
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');

var reconcile = require('../lib/payouts/reconcile');
var breakdown = require('../lib/payouts/breakdown');
var apiServer = require('../api/server');

var failures = 0;
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
    if (!cond) failures++;
}

var FINDER = 'itc1qh73574ygkd6ycd5kwpud022v9ts2qnvuxrnjqu';
var HASH = '029f4cf376f1fab02066917a9bf8051bef770f24c405c01a1dcaaae54837a210';
var SUBSIDY = 24088231, GOVERNANCE = 17584408, CREDITABLE = 6503823;

function soloStore(extraBlockFields) {
    return {
        shares: [
            { algo: 'ethash', worker: FINDER, difficulty: 0.5, time: 1794234600, height: 914572 },
            { algo: 'ethash', worker: FINDER, difficulty: 0.5, time: 1794234700, height: 914572 },
            { algo: 'ethash', worker: FINDER, difficulty: 0.5, time: 1794234775, height: 914572 }
        ],
        blocks: [Object.assign({
            algo: 'ethash', height: 914572, hash: HASH,
            reward: SUBSIDY, finder: FINDER, time: 1794234780,
            scheme: 'solo', status: 'confirmed', confirmations: 120, payoutId: null
        }, extraBlockFields || {})],
        balances: {},
        payouts: []
    };
}

console.log('— solo derivation');
var derived = reconcile.soloSplit(soloStore().blocks[0]);
check('governance is floor(73% of subsidy)', derived.governanceSat === GOVERNANCE, derived.governanceSat);
check('creditable = subsidy - governance', derived.creditableSat === CREDITABLE, derived.creditableSat);
check('implicit split credits the finder 100% of creditable, fee 0',
    derived.amounts[FINDER] === CREDITABLE && derived.feeSat === 0, JSON.stringify(derived.amounts));
check('a pending solo block is NOT settled',
    reconcile.isSoloSettled({ scheme: 'solo', status: 'pending' }) === false &&
    reconcile.isSettled({ scheme: 'solo', status: 'pending', amounts: null }) === false);

console.log('— reconcile: settled solo block (no recorded split)');
var rec = reconcile.reconcile(soloStore());
check('settledBlocks counts the solo block', rec.settledBlocks === 1, rec.settledBlocks);
check('rewardIn is the pool-creditable amount (governance excluded)',
    rec.aggregate.rewardInSat === CREDITABLE && rec.aggregate.settledRewardSat === CREDITABLE,
    rec.aggregate.rewardInSat);
check('solo total published separately', rec.aggregate.soloSettledSat === CREDITABLE);
check('credited = creditable, no fee, no payouts, no carry-over',
    rec.aggregate.creditedSat === CREDITABLE && rec.aggregate.feeSat === 0 &&
    rec.aggregate.payoutsSat === 0 && rec.aggregate.carryOverDeltaSat === 0,
    JSON.stringify(rec.aggregate));
check('equation holds with real numbers (not vacuously)',
    rec.aggregate.holds === true && rec.balanced === true && rec.discrepancies.length === 0,
    JSON.stringify(rec.discrepancies));
check('per-block entry carries the full money trail',
    rec.perBlock.length === 1 && rec.perBlock[0].rewardSat === CREDITABLE &&
    rec.perBlock[0].grossRewardSat === SUBSIDY && rec.perBlock[0].governanceSat === GOVERNANCE &&
    rec.perBlock[0].paidOutSat === CREDITABLE && rec.perBlock[0].carryOverSat === 0 &&
    rec.perBlock[0].balanced === true,
    JSON.stringify(rec.perBlock[0]));

console.log('— reconcile: recorded solo splits are checked, not trusted');
var recRecorded = reconcile.reconcile(soloStore({ amounts: { [FINDER]: CREDITABLE }, feeSat: 0 }));
check('honest recorded solo split settles balanced',
    recRecorded.settledBlocks === 1 && recRecorded.balanced === true &&
    recRecorded.aggregate.rewardInSat === CREDITABLE, JSON.stringify(recRecorded.discrepancies));
var recTampered = reconcile.reconcile(soloStore({ amounts: { [FINDER]: CREDITABLE - 1 }, feeSat: 0 }));
check('recorded solo split 1 sat short is a discrepancy',
    recTampered.balanced === false &&
    recTampered.discrepancies.some(function (d) { return d.kind === 'solo-split-mismatch'; }),
    JSON.stringify(recTampered.discrepancies.map(function (d) { return d.kind; })));

console.log('— reconcile: group-only stores are byte-identical in spirit');
var recEmpty = reconcile.reconcile({ shares: [], blocks: [], balances: {}, payouts: [] });
check('empty store: original equation string, solo total 0, holds',
    recEmpty.aggregate.equation === 'rewardInSat == payoutsSat + feeSat + carryOverDeltaSat' &&
    recEmpty.aggregate.soloSettledSat === 0 && recEmpty.aggregate.holds === true &&
    recEmpty.settledBlocks === 0);

console.log('— breakdown: settled solo block published truthfully');
var bd = breakdown.breakdownForHeight(soloStore(), 914572, {});
check('breakdown settled + balanced', bd.settled === true && bd.balanced === true);
check('breakdown shows gross, governance and creditable',
    bd.rewardSat === SUBSIDY && bd.governanceSat === GOVERNANCE && bd.creditableSat === CREDITABLE,
    JSON.stringify({ r: bd.rewardSat, g: bd.governanceSat, c: bd.creditableSat }));
check('creditedSat is the creditable amount, not the subsidy, not zero',
    bd.creditedSat === CREDITABLE, bd.creditedSat);
check('finder credited 100% of creditable and marked coinbase-paid',
    bd.miners.length === 1 && bd.miners[0].address === FINDER &&
    bd.miners[0].payoutAmountSat === CREDITABLE && bd.miners[0].paidOutSat === CREDITABLE &&
    bd.miners[0].carryOverCreatedSat === 0,
    JSON.stringify(bd.miners[0]));
check('recompute agrees with the published solo split',
    bd.miners[0].recomputedAmountSat === CREDITABLE && bd.recomputedFeeSat === 0);
var list = breakdown.listBreakdowns(soloStore(), {});
check('breakdowns list includes the solo block as settled',
    list.length === 1 && list[0].settled === true && list[0].creditedSat === CREDITABLE &&
    list[0].governanceSat === GOVERNANCE && list[0].creditableSat === CREDITABLE,
    JSON.stringify(list[0]));
var bdTampered = breakdown.breakdownForHeight(soloStore({ amounts: { [FINDER]: CREDITABLE - 1 }, feeSat: 0 }), 914572, {});
check('tampered recorded solo split: matchesRecorded false, not balanced',
    bdTampered.matchesRecorded === false && bdTampered.balanced === false);

console.log('— API endpoints serve it');
function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var body = '';
            res.on('data', function (d) { body += d; });
            res.on('end', function () {
                try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}
var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-fairness-solo-'));
var payoutsFile = path.join(tmpDir, 'payouts.json');
fs.writeFileSync(payoutsFile, JSON.stringify(soloStore(), null, 2));
var server = apiServer.createServer({
    collector: new apiServer.StatsCollector({ dataFile: null }),
    payoutsFile: payoutsFile,
    poolConfig: {
        payments: { feePercent: 0, minPayout: 0.5, dryRun: true, confirmations: 5 },
        algos: { sha256: { scheme: 'solo' }, yespower: { scheme: 'solo' }, ethash: { scheme: 'solo' } }
    }
});
server.listen(0, '127.0.0.1', function () {
    var port = server.address().port;
    Promise.all([
        httpGet(port, '/api/reconcile'),
        httpGet(port, '/api/breakdowns'),
        httpGet(port, '/api/blocks/914572/breakdown?algo=ethash')
    ]).then(function (r) {
        check('GET /api/reconcile: settledBlocks 1, rewardIn creditable, balanced',
            r[0].status === 200 && r[0].json.settledBlocks === 1 &&
            r[0].json.aggregate.rewardInSat === CREDITABLE && r[0].json.balanced === true,
            JSON.stringify(r[0].json.aggregate || {}));
        check('GET /api/breakdowns: the solo block, settled',
            r[1].status === 200 && r[1].json.length === 1 && r[1].json[0].settled === true &&
            r[1].json[0].creditedSat === CREDITABLE);
        check('GET /api/blocks/914572/breakdown: finder credited 100% of creditable',
            r[2].status === 200 && r[2].json.miners.length === 1 &&
            r[2].json.miners[0].payoutAmountSat === CREDITABLE &&
            r[2].json.governanceSat === GOVERNANCE);
        server.close(function () {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            console.log(failures === 0 ? 'ALL FAIRNESS-SOLO CHECKS PASSED' : failures + ' FAIRNESS-SOLO CHECK(S) FAILED');
            process.exit(failures === 0 ? 0 : 1);
        });
    }).catch(function (e) {
        check('API requests complete', false, e.message);
        server.close(function () { process.exit(1); });
    });
});
