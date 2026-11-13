'use strict';
/* Phase-2 API verification: fixture payouts store + sample poolConfig.
 * Boots the real server on scratch ports, asserts endpoint behaviour,
 * then boots WITHOUT the fixture and asserts sane empties + UI 200.
 * Run: node api/test-phase2.js   (exit 0 = all pass) */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createServer } = require('./server');

const ADDR = 'iTcMinerAddress1111111111111111111111';
const OTHER = 'iTcOtherAddress2222222222222222222222';
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failures += 1;
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
const json = (r) => JSON.parse(r.body);

async function main() {
  const now = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-phase2-'));
  const payoutsFile = path.join(dir, 'payouts.json');
  const fixture = {
    version: 1,
    shares: [
      { algo: 'sha256', worker: ADDR, workerName: 'rig1', difficulty: 10, time: now - 1000, height: 914000 },
      { algo: 'sha256', worker: ADDR, workerName: 'rig1', difficulty: 20, time: now - 2000, height: 914000 },
      { algo: 'sha256', worker: ADDR, workerName: 'rig1', difficulty: 100, time: now - 700000, height: 913999 },
      { algo: 'sha256', worker: OTHER, workerName: 'rig9', difficulty: 7, time: now - 1000, height: 914000 },
      // workerName suffix must NOT match ADDR lookup:
      { algo: 'yespower', worker: OTHER, workerName: ADDR, difficulty: 999, time: now - 1000, height: 914000 },
      { algo: 'yespower', worker: ADDR, workerName: 'cpu1', difficulty: 5, time: now - 3000, height: 914001 },
    ],
    blocks: [
      { algo: 'sha256', height: 914000, hash: 'aaaa', reward: 5000000000, finder: ADDR, time: now - 5000, scheme: 'pplns', status: 'confirmed', confirmations: 12, payoutId: 'pay1' },
      { algo: 'yespower', height: 914001, hash: 'bbbb', reward: 2500000000, finder: ADDR, time: now - 4000, scheme: 'prop', status: 'paid', confirmations: 30, payoutId: 'pay2' },
    ],
    balances: {
      sha256: { [ADDR]: { pending: 150000000, paid: 50000000 }, [OTHER]: { pending: 1, paid: 0 } },
      yespower: { [ADDR]: { pending: 25000000, paid: 0 } },
    },
    payouts: [
      { id: 'pay1', algo: 'sha256', time: now - 60000, dryRun: true, txid: null, amounts: { [ADDR]: 100000000, [OTHER]: 50000000 }, blocks: [914000], fee: 1000, psbt: 'cHNidDEtdGVzdA==', stage: 'created' },
      { id: 'pay2', algo: 'yespower', time: now - 10000, dryRun: false, txid: 'faketxidabc', amounts: { [ADDR]: 25000000 }, blocks: [914001], fee: 500, psbt: 'cHNidDItdGVzdA==', stage: 'sent', hex: 'deadbeef00' },
    ],
  };
  fs.writeFileSync(payoutsFile, JSON.stringify(fixture, null, 2));
  const poolConfig = {
    address: 'iTcPoolAddress00000000000000000000000',
    algos: {
      sha256: { stratumPort: 3333, scheme: 'pplns', pplnsWindow: 1000 },
      yespower: { stratumPort: 3334, scheme: 'prop' },
      ethash: { stratumPort: 3335, scheme: 'solo' },
    },
    payments: { feePercent: 1.5, minPayout: 1, dryRun: true, confirmations: 6 },
  };

  const server = createServer({ payoutsFile, poolConfig, dataFile: null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('fixture server on port ' + port);

  // --- /api/miner/<address>
  const miner = json(await get(port, '/api/miner/' + ADDR));
  const sha = miner.algos.sha256;
  check('miner sha shares=3', sha.shares === 3, String(sha.shares));
  check('miner sha shareDifficultySum=130', sha.shareDifficultySum === 130, String(sha.shareDifficultySum));
  const expectHr = (30 * Math.pow(2, 32)) / 600; // only in-window diffs 10+20
  check('miner sha hashrate windowed', Math.abs(sha.hashrateEstimate - expectHr) < 1, String(sha.hashrateEstimate));
  check('miner sha pending 1.5 ITC', sha.pendingSat === 150000000 && sha.pendingItc === 1.5, sha.pendingItc + ' ITC');
  check('miner sha paid 0.5 ITC', sha.paidSat === 50000000 && sha.paidItc === 0.5);
  check('miner yespower shares=1 (workerName suffix NOT matched)', miner.algos.yespower.shares === 1, String(miner.algos.yespower.shares));
  check('miner totals shares=4', miner.totals.shares === 4, String(miner.totals.shares));
  check('miner totals pendingSat=175000000', miner.totals.pendingSat === 175000000 && miner.totals.pendingItc === 1.75);
  check('miner totals paidSat=50000000', miner.totals.paidSat === 50000000 && miner.totals.paidItc === 0.5);
  check('miner lastShareAt recent', Math.abs(miner.totals.lastShareAt - (now - 1000)) < 5);

  const missing = await get(port, '/api/miner/iTcNoSuchMiner00000000000000000000');
  check('miner 404', missing.status === 404 && json(missing).error === 'miner not found', String(missing.status));

  // --- /api/payouts
  const pays = json(await get(port, '/api/payouts'));
  check('payouts newest first', pays.payouts[0].id === 'pay2' && pays.payouts[1].id === 'pay1');
  check('payout totalSat/totalItc', pays.payouts[1].totalSat === 150000000 && pays.payouts[1].totalItc === 1.5);
  check('payout minersPaid', pays.payouts[1].minersPaid === 2);
  check('payouts pool summary', pays.pool.feePercent === 1.5 && pays.pool.minPayout === 1 && pays.pool.dryRun === true && pays.pool.confirmations === 6, JSON.stringify(pays.pool));
  check('minPayout config is COINS: minPayoutItc=1, minPayoutSat=100000000', pays.pool.minPayoutItc === 1 && pays.pool.minPayoutSat === 100000000, JSON.stringify(pays.pool));
  check('payout batches surface PSBT + stage for external signers',
    pays.payouts[0].psbt === 'cHNidDItdGVzdA==' && pays.payouts[0].stage === 'sent' &&
    pays.payouts[1].psbt === 'cHNidDEtdGVzdA==' && pays.payouts[1].stage === 'created',
    JSON.stringify(pays.payouts.map((p) => ({ id: p.id, stage: p.stage, psbt: p.psbt }))));

  // --- /api/payouts/blocks + /api/blocks?source=store + default /api/blocks
  const pblocks = json(await get(port, '/api/payouts/blocks'));
  check('payouts/blocks count=2 newest first', pblocks.length === 2 && pblocks[0].height === 914001);
  check('payouts/blocks status+rewardItc', pblocks[0].status === 'paid' && pblocks[0].rewardItc === 25 && pblocks[1].status === 'confirmed');
  const sblocks = json(await get(port, '/api/blocks?source=store'));
  check('blocks?source=store matches', sblocks.length === 2 && sblocks[0].status === 'paid');
  const cblocks = json(await get(port, '/api/blocks'));
  check('blocks default = collector (empty array)', Array.isArray(cblocks) && cblocks.length === 0);

  // --- /api/config extensions + back-compat
  const cfg = json(await get(port, '/api/config'));
  check('config scheme per algo', cfg.algos.sha256.scheme === 'pplns' && cfg.algos.yespower.scheme === 'prop' && cfg.algos.ethash.scheme === 'solo');
  check('config pplnsWindow', cfg.algos.sha256.pplnsWindow === 1000);
  check('config payments', cfg.payments.feePercent === 1.5 && cfg.payments.dryRun === true && cfg.payments.minPayoutItc === 1);
  check('config back-compat fields', cfg.coin === 'Interchained (ITC)' && cfg.stratumPorts.ethash === 3335 && Array.isArray(cfg.algoList) && cfg.solo === false);

  // --- /api/config display ports: 5-digit backend ports (nginx stream
  // proxy layout) list as their public ports; stock ports above pass
  // through untouched (covered by the back-compat check).
  const backendConfig = {
    address: poolConfig.address,
    algos: {
      sha256: { stratumPort: 33333, scheme: 'solo' },
      yespower: { stratumPort: 33343, scheme: 'solo' },
      ethash: { stratumPort: 33353, scheme: 'solo' },
    },
  };
  const server2 = createServer({ payoutsFile, poolConfig: backendConfig, dataFile: null });
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const cfg2 = json(await get(server2.address().port, '/api/config'));
  check('config display ports slice the trailing 3', cfg2.stratumPorts.sha256 === 3333 && cfg2.stratumPorts.yespower === 3334 && cfg2.stratumPorts.ethash === 3335, JSON.stringify(cfg2.stratumPorts));
  await new Promise((r) => server2.close(r));

  // --- UI served + new markup present
  const home = await get(port, '/');
  check('GET / 200', home.status === 200);
  for (const needle of ['id="payouts-fee"', 'id="payouts-mode"', 'id="miner-form"', 'id="miner-address"', 'id="blocks-body"', 'data-field="scheme"', 'Pool Payouts', 'Miner Lookup', 'Distribution']) {
    check('UI markup: ' + needle, home.body.includes(needle));
  }
  await new Promise((r) => server.close(r));

  // --- env var route
  process.env.ITC_PAYOUTS_FILE = payoutsFile;
  const envServer = createServer({ dataFile: null });
  await new Promise((r) => envServer.listen(0, '127.0.0.1', r));
  const envMiner = json(await get(envServer.address().port, '/api/miner/' + ADDR));
  check('ITC_PAYOUTS_FILE env honoured', envMiner.totals && envMiner.totals.shares === 4);
  await new Promise((r) => envServer.close(r));
  delete process.env.ITC_PAYOUTS_FILE;

  // --- no fixture, no poolConfig: sane empties, never crash
  const bare = createServer({ payoutsFile: path.join(dir, 'does-not-exist.json'), dataFile: null });
  await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const bp = bare.address().port;
  const bMiner = await get(bp, '/api/miner/' + ADDR);
  check('bare miner 404', bMiner.status === 404);
  const bPays = json(await get(bp, '/api/payouts'));
  check('bare payouts empty + null pool fields', Array.isArray(bPays.payouts) && bPays.payouts.length === 0 && bPays.pool.feePercent === null && bPays.pool.dryRun === null, JSON.stringify(bPays.pool));
  const bBlocks = json(await get(bp, '/api/payouts/blocks'));
  check('bare payouts/blocks []', Array.isArray(bBlocks) && bBlocks.length === 0);
  const bCfg = json(await get(bp, '/api/config'));
  check('bare config solo defaults', bCfg.solo === true && bCfg.algos.sha256.scheme === 'solo' && bCfg.payments.feePercent === null);
  const bHome = await get(bp, '/');
  check('bare GET / 200', bHome.status === 200);
  const bHealth = json(await get(bp, '/health'));
  check('bare /health ok', bHealth.ok === true);
  await new Promise((r) => bare.close(r));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
