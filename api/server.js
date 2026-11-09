'use strict';
/*
 * Interchained tri-PoW solo pool - stats/API + dashboard static server.
 *
 * Zero dependencies: Node.js builtins only (http, fs, path, url).
 * Standalone:  node api/server.js        (ITC_API_PORT, else PORT, else 8080)
 * In-process:  const { createServer, StatsCollector } = require('./server');
 *              const collector = new StatsCollector();
 *              collector.attach(poolInstance, 'sha256'); // per algo
 *              createServer({ collector }).listen(8080);
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const StatsCollector = require('./collector');
const payoutsBreakdown = require('../lib/payouts/breakdown');
const payoutsReconcile = require('../lib/payouts/reconcile');
const payoutsStorePath = require('../lib/payouts/storePath');
const chatStoreModule = require('./chatStore');
const vitalsStoreModule = require('./vitalsStore');

const ALGOS = ['sha256', 'yespower', 'ethash'];
const STRATUM_PORTS = { sha256: 3333, yespower: 3334, ethash: 3335 };
const DEFAULT_PORT = 8080;
const DEFAULT_UI_DIR = path.join(__dirname, '..', 'ui');
/* The payouts store path itself is resolved by the single shared
 * resolver (lib/payouts/storePath.js) — the same one the pool
 * process writes through — in createServer below. */
const WINDOW_SECONDS = 600;
const SAT_PER_ITC = 1e8;

/* ------------------------------------------------------------------ *
 * Phase 2: group payouts store (READ-ONLY for this lane).
 * Written by the payouts lane; shape (fixed contract):
 *   { version: 1,
 *     shares:  [{algo, worker, workerName, difficulty, time, height}],
 *     blocks:  [{algo, height, hash, reward(sat), finder, time, scheme,
 *                status, confirmations, payoutId}],
 *     balances:{ algo: { address: {pending(sat), paid(sat)} } },
 *     payouts: [{id, algo, time, dryRun, txid, amounts:{addr:sat},
 *                blocks:[heights], fee(sat)}] }
 * A missing/corrupt file is normal (phase-1-only deployments): every
 * reader below falls back to an empty store and never throws.
 * Miner hashrate source: the payouts store (NOT the collector), so
 * /api/miner works standalone; same diff-1 convention as collector.js:
 *   hashrate = sum(share difficulties in 600s window) * 2^32 / 600
 * ------------------------------------------------------------------ */
function emptyPayoutsStore() {
  return { version: 1, shares: [], blocks: [], balances: {}, payouts: [] };
}

function loadPayoutsStore(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return emptyPayoutsStore();
    return {
      version: data.version != null ? data.version : 1,
      shares: Array.isArray(data.shares) ? data.shares : [],
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      balances:
        data.balances && typeof data.balances === 'object' ? data.balances : {},
      payouts: Array.isArray(data.payouts) ? data.payouts : [],
    };
  } catch (_) {
    return emptyPayoutsStore();
  }
}

function satToItc(sat) {
  const n = Number(sat);
  return Number.isFinite(n) ? n / SAT_PER_ITC : 0;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* Payments summary from a pool config object (options.poolConfig).
 * NOTE (phase-2 integration reconciliation): in the POOL CONFIG the
 * payments.minPayout field is denominated in COINS (ITC) -- that is
 * what lib/payouts/payments.js consumes (coinsToSat) and what
 * config/README.md documents. (The payouts STORE, in contrast, is all
 * satoshis.) So here the verbatim value is coins: minPayoutItc is the
 * value itself and minPayoutSat is derived. */
function paymentsSummary(poolConfig) {
  const p =
    poolConfig && poolConfig.payments && typeof poolConfig.payments === 'object'
      ? poolConfig.payments
      : {};
  const minPayout = p.minPayout != null ? finiteOr(p.minPayout, null) : null;
  return {
    feePercent: p.feePercent != null ? finiteOr(p.feePercent, null) : null,
    minPayout,
    minPayoutSat: minPayout != null ? Math.round(minPayout * SAT_PER_ITC) : null,
    minPayoutItc: minPayout,
    dryRun: p.dryRun != null ? !!p.dryRun : null,
    confirmations: p.confirmations != null ? finiteOr(p.confirmations, null) : null,
  };
}

function algoConfig(poolConfig, algo) {
  const a =
    poolConfig && poolConfig.algos && typeof poolConfig.algos === 'object'
      ? poolConfig.algos[algo]
      : null;
  const entry = a && typeof a === 'object' ? a : {};
  return {
    algo,
    stratumPort: entry.stratumPort != null
      ? finiteOr(entry.stratumPort, STRATUM_PORTS[algo])
      : STRATUM_PORTS[algo],
    // No poolConfig -> phase-1 solo default, reported honestly as such.
    scheme: entry.scheme ? String(entry.scheme).toLowerCase() : 'solo',
    pplnsWindow: entry.pplnsWindow != null ? entry.pplnsWindow : null,
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PLACEHOLDER_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Interchained Pool</title></head><body>',
  '<h1>Interchained tri-PoW Pool</h1>',
  '<p>The dashboard is not built yet. The stats API is live at ' +
    '<a href="/api/stats">/api/stats</a>.</p>',
  '</body></html>',
  '',
].join('\n');

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    /* Live pool data must never be cached — not by a browser, not
       by a CDN edge. A cached /api/stats reads as empty stats. */
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function configPayload(poolConfig) {
  const algos = {};
  const algoList = [];
  const stratumPorts = {};
  for (const algo of ALGOS) {
    const entry = algoConfig(poolConfig, algo);
    algos[algo] = entry;
    algoList.push(entry);
    stratumPorts[algo] = entry.stratumPort;
  }
  const payments = paymentsSummary(poolConfig);
  return {
    // Back-compat: true exactly when every algo is solo (always the
    // case with no poolConfig, preserving the phase-1 payload).
    solo: ALGOS.every((a) => algos[a].scheme === 'solo'),
    coin: 'Interchained (ITC)',
    algos,
    algoList,
    stratumPorts,
    payments,
    // Flat mirrors of the payments summary for simple consumers.
    feePercent: payments.feePercent,
    minPayout: payments.minPayout,
    dryRun: payments.dryRun,
    poolAddress:
      poolConfig && poolConfig.address != null ? poolConfig.address : null,
    // The host miners should point at. A deployment property (pool
    // config / ITC_STRATUM_HOST), never the hostname the dashboard
    // happens to be viewed through — the UI used to echo
    // location.hostname, so browsing via any other name (e.g.
    // mine.interchained.org) produced wrong connect strings.
    stratumHost:
      poolConfig && poolConfig.stratumHost
        ? String(poolConfig.stratumHost)
        : 'stratum.interchained.org',
    poolConfigProvided: !!poolConfig,
  };
}

/* GET /api/miner/<address> payload, or null when the address has no
 * shares and no balances in the payouts store (caller sends 404). */
function minerPayload(store, address) {
  const algoNames = new Set(ALGOS);
  for (const s of store.shares) if (s && s.algo) algoNames.add(String(s.algo).toLowerCase());
  for (const a of Object.keys(store.balances)) algoNames.add(String(a).toLowerCase());

  const now = Date.now();
  const cutoff = now - WINDOW_SECONDS * 1000;
  const algos = {};
  let found = false;
  const totals = {
    shares: 0, shareDifficultySum: 0, hashrateEstimate: 0,
    pendingSat: 0, paidSat: 0, pendingItc: 0, paidItc: 0, lastShareAt: null,
  };

  for (const algo of algoNames) {
    let shares = 0;
    let shareDifficultySum = 0;
    let windowDiff = 0;
    let lastShareAt = null;
    for (const s of store.shares) {
      if (!s || String(s.algo || '').toLowerCase() !== algo) continue;
      if (s.worker !== address) continue; // exact payout address only
      const diff = finiteOr(s.difficulty, 1);
      const t = finiteOr(s.time, 0);
      shares += 1;
      shareDifficultySum += diff;
      if (t >= cutoff) windowDiff += diff;
      if (t && (lastShareAt == null || t > lastShareAt)) lastShareAt = t;
    }
    const balForAlgo =
      store.balances[algo] && typeof store.balances[algo] === 'object'
        ? store.balances[algo][address]
        : null;
    const hasBalance = !!(balForAlgo && typeof balForAlgo === 'object');
    if (shares > 0 || hasBalance) found = true;
    const pendingSat = hasBalance ? finiteOr(balForAlgo.pending, 0) : 0;
    const paidSat = hasBalance ? finiteOr(balForAlgo.paid, 0) : 0;
    const entry = {
      shares,
      shareDifficultySum,
      hashrateEstimate: (windowDiff * Math.pow(2, 32)) / WINDOW_SECONDS,
      lastShareAt,
      pendingSat,
      paidSat,
      pendingItc: satToItc(pendingSat),
      paidItc: satToItc(paidSat),
    };
    algos[algo] = entry;
    totals.shares += entry.shares;
    totals.shareDifficultySum += entry.shareDifficultySum;
    totals.hashrateEstimate += entry.hashrateEstimate;
    totals.pendingSat += entry.pendingSat;
    totals.paidSat += entry.paidSat;
    if (entry.lastShareAt != null &&
        (totals.lastShareAt == null || entry.lastShareAt > totals.lastShareAt)) {
      totals.lastShareAt = entry.lastShareAt;
    }
  }
  if (!found) return null;
  totals.pendingItc = satToItc(totals.pendingSat);
  totals.paidItc = satToItc(totals.paidSat);
  return { address, algos, totals };
}

function enrichPayout(p) {
  const amounts = p && p.amounts && typeof p.amounts === 'object' ? p.amounts : {};
  let totalSat = 0;
  for (const addr of Object.keys(amounts)) totalSat += finiteOr(amounts[addr], 0);
  return Object.assign({}, p, {
    amounts,
    totalSat,
    totalItc: satToItc(totalSat),
    total: totalSat,
    minersPaid: Object.keys(amounts).length,
    miners: Object.keys(amounts).length,
    feeSat: p ? finiteOr(p.fee, 0) : 0,
    feeItc: satToItc(p ? finiteOr(p.fee, 0) : 0),
  });
}

function enrichStoreBlock(b) {
  const rewardSat = finiteOr(b && b.reward, 0);
  return Object.assign({}, b, {
    rewardSat,
    rewardItc: satToItc(rewardSat),
    status: b && b.status ? b.status : 'pending',
    scheme: b && b.scheme ? b.scheme : null,
  });
}

function storeBlocksPayload(store, limit) {
  const blocks = store.blocks
    .filter((b) => b && typeof b === 'object')
    .map(enrichStoreBlock);
  blocks.sort((x, y) =>
    finiteOr(y.time, 0) - finiteOr(x.time, 0) ||
    finiteOr(y.height, 0) - finiteOr(x.height, 0));
  const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
  return blocks.slice(0, n);
}

/**
 * createServer([options | collector])
 * @param {object} [options]
 * @param {StatsCollector} [options.collector] shared collector (a fresh one
 *        is created when omitted)
 * @param {string} [options.uiDir] static root (default: ../ui)
 * @param {string|null} [options.dataFile] forwarded to a fresh collector
 * @param {string} [options.payoutsFile] payouts store path (phase 2).
 *        Resolves through the shared lib/payouts/storePath.js —
 *        explicit path, env ITC_PAYMENTS_DATA_FILE, the storeConfig's
 *        payments.dataFile, legacy env ITC_PAYOUTS_FILE, then
 *        api/data/payouts.json — the same file the pool process
 *        writes. Read fresh on every phase-2 request; absence is
 *        tolerated.
 * @param {object} [options.storeConfig] parsed pool config, used only
 *        for its payments.dataFile during path resolution (the
 *        standalone entry supplies it from the config file).
 * @param {object} [options.poolConfig] pool config object
 *        ({address, algos:{algo:{stratumPort, scheme, pplnsWindow}},
 *          payments:{feePercent, minPayout, dryRun, confirmations}})
 *        surfaced by /api/config and /api/payouts.
 * Returns an http.Server that is NOT yet listening.
 * Passing a StatsCollector directly as the argument also works.
 */
function createServer(options) {
  let opts = options || {};
  if (opts && typeof opts.recordShare === 'function' && typeof opts.getStats === 'function') {
    opts = { collector: opts };
  }
  const collector =
    opts.collector || new StatsCollector({ dataFile: opts.dataFile });
  const uiDir = opts.uiDir || DEFAULT_UI_DIR;
  const payoutsFile = payoutsStorePath.resolvePayoutsStorePath({
    explicit: opts.payoutsFile,
    config: opts.storeConfig || null,
    env: process.env,
  });
  const poolConfig =
    opts.poolConfig && typeof opts.poolConfig === 'object' ? opts.poolConfig : null;
  const readStore = () => loadPayoutsStore(payoutsFile);

  /* Pool chat (NEDB embedded — see api/chatStore.js). The store is
     created lazily on the first chat request so a missing
     nedb-engine install degrades chat to 503 and nothing else. */
  let chat = null;
  const getChat = () => {
    if (!chat) chat = chatStoreModule.createChatStore({ dir: opts.chatDir });
    return chat;
  };

  /* Pool vitals cache (NEDB embedded — see api/vitalsStore.js). The
     host process (start.js) injects its store via opts.vitalsStore;
     any other server of this dashboard opens the same store itself,
     so the network panel and the chart history work no matter which
     process serves the page. A missing engine degrades the cache to
     "unavailable" and nothing else. */
  let vitals = opts.vitalsStore || null;
  let vitalsFailed = false;
  const getVitals = () => {
    if (vitals || vitalsFailed) return vitals;
    try {
      vitals = vitalsStoreModule.createVitalsStore({ dir: opts.vitalsDir });
    } catch (_) {
      // NEDB is single-opener: when the pool process holds the store
      // (the normal case) this open is refused — the mirror file
      // below is the read path then, not an error worth repeating.
      vitalsFailed = true;
      vitals = null;
    }
    return vitals;
  };
  const getVitalsMirror = () => {
    try { return vitalsStoreModule.readMirrorFile(opts.vitalsMirrorFile); }
    catch (_) { return null; }
  };
  const filterSamples = (samples, parsed) => {
    let out = Array.isArray(samples) ? samples.slice() : [];
    const sinceRaw = parsed.searchParams.get('since');
    if (sinceRaw != null && Number.isFinite(Number(sinceRaw))) {
      const since = Number(sinceRaw);
      out = out.filter((s) => s && typeof s.t === 'number' && s.t >= since);
    }
    const limitRaw = parsed.searchParams.get('limit');
    let limit = limitRaw != null && Number(limitRaw) > 0 ? Number(limitRaw) : 10000;
    limit = Math.min(limit, 50000);
    if (out.length > limit) out = out.slice(out.length - limit);
    return out;
  };
  const chatRate = new Map(); // ip -> { last: ts, minute: [ts] }
  const chatRateOk = (ip) => {
    const now = Date.now();
    let rec = chatRate.get(ip);
    if (!rec) { rec = { last: 0, minute: [] }; chatRate.set(ip, rec); }
    rec.minute = rec.minute.filter((t) => now - t < 60000);
    if (now - rec.last < 1200) return false;
    if (rec.minute.length >= 20) return false;
    rec.last = now;
    rec.minute.push(now);
    return true;
  };
  const handleChatPost = (req, res) => {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (!chatRateOk(ip)) {
      sendJson(res, 429, { error: 'slow down — one message per second or so' });
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        sendJson(res, 413, { error: 'message too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (_) { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      try {
        const message = getChat().post(body && body.author, body && body.text);
        sendJson(res, 201, { message });
      } catch (e) {
        if (e && e.code === 'CHAT_BAD_MESSAGE') sendJson(res, 400, { error: e.message });
        else sendJson(res, 503, { error: 'chat unavailable' });
      }
    });
    req.on('error', () => { /* client went away; nothing to store */ });
  };

  const server = http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    const pathname = parsed.pathname;

    // ------------------------------------------------------------ pool chat
    if (pathname === '/api/chat') {
      if (req.method === 'POST') { handleChatPost(req, res); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          const store = getChat();
          const limit = parsed.searchParams.get('limit');
          sendJson(res, 200, { messages: store.list(limit ? Number(limit) : undefined), status: store.status() });
        } catch (e) {
          sendJson(res, 503, { error: 'chat unavailable' });
        }
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (pathname === '/api/chat/status') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      try { sendJson(res, 200, getChat().status()); }
      catch (e) { sendJson(res, 503, { error: 'chat unavailable' }); }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // ------------------------------------------------------------ JSON API
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/stats') {
      sendJson(res, 200, collector.getStats());
      return;
    }
    if (pathname === '/api/blocks') {
      const limit = parsed.searchParams.get('limit');
      // Phase 2: ?source=store|payouts returns payouts-store blocks with
      // distribution status; default (no source) is the phase-1
      // collector behaviour, unchanged.
      const source = (parsed.searchParams.get('source') || '').toLowerCase();
      if (source === 'store' || source === 'payouts') {
        sendJson(res, 200, storeBlocksPayload(readStore(), limit ? Number(limit) : undefined));
        return;
      }
      sendJson(res, 200, collector.getBlocks(limit ? Number(limit) : undefined));
      return;
    }
    if (pathname === '/api/workers') {
      sendJson(res, 200, collector.getWorkers());
      return;
    }
    if (pathname === '/api/config') {
      sendJson(res, 200, configPayload(poolConfig));
      return;
    }
    if (pathname === '/api/network') {
      /* Chain vitals from the daemon, polled by the host process
         (start.js) and injected as options.networkProvider. When no
         provider is injected (standalone server), fall back to the
         NEDB vitals cache the pool process keeps fresh — the
         snapshot's own updatedAt shows how old the cached read is.
         With neither, report unavailable honestly. */
      let net = null;
      try { net = typeof opts.networkProvider === 'function' ? opts.networkProvider() : null; }
      catch (_) { net = null; }
      if (!net) {
        try {
          const v = getVitals();
          if (v) net = v.readNetwork();
        } catch (_) { net = null; }
      }
      if (!net) {
        const mirror = getVitalsMirror();
        if (mirror && mirror.network && mirror.network.available) net = mirror.network;
      }
      sendJson(res, 200, net || { available: false });
      return;
    }
    if (pathname === '/api/history') {
      /* Hashrate history from the NEDB vitals cache: samples the pool
         process appends every 30 s ({t, height, sha256, yespower,
         ethash}). Query: ?since=<ms epoch>&limit=<n>. The dashboard
         seeds its charts from this so history survives reboots and
         page loads. */
      let samples = null;
      try {
        const v = getVitals();
        if (v) {
          samples = v.listSamples({
            since: parsed.searchParams.get('since') != null ? Number(parsed.searchParams.get('since')) : undefined,
            limit: parsed.searchParams.get('limit') != null ? Number(parsed.searchParams.get('limit')) : undefined
          });
        }
      } catch (_) { samples = null; }
      if (!samples) {
        const mirror = getVitalsMirror();
        if (mirror) samples = filterSamples(mirror.samples, parsed);
      }
      if (samples) sendJson(res, 200, { available: true, samples });
      else sendJson(res, 200, { available: false, samples: [] });
      return;
    }
    // ------------------------------------------------------ phase 2 API
    if (pathname === '/api/payouts') {
      const store = readStore();
      const payouts = store.payouts
        .filter((p) => p && typeof p === 'object')
        .map(enrichPayout)
        .sort((x, y) => finiteOr(y.time, 0) - finiteOr(x.time, 0))
        .slice(0, 100);
      sendJson(res, 200, { payouts, pool: paymentsSummary(poolConfig) });
      return;
    }
    if (pathname === '/api/payouts/blocks') {
      const limit = parsed.searchParams.get('limit');
      sendJson(res, 200, storeBlocksPayload(readStore(), limit ? Number(limit) : undefined));
      return;
    }
    // ------------------------------------------------------ phase 3 fairness API
    // Read-only audit surface (see docs/FAIRNESS.md). The options handed
    // to the breakdown/recompute modules come from the SAME pool config
    // the payouts processor runs with, so a recompute here is directly
    // comparable to a miner's offline run of scripts/verify-payout.js.
    const fairnessOptions = () => {
      const payments = paymentsSummary(poolConfig);
      const schemes = {};
      for (const algo of ALGOS) {
        const entry = algoConfig(poolConfig, algo);
        schemes[algo] = { scheme: entry.scheme, pplnsWindow: entry.pplnsWindow };
      }
      return {
        feePercent: payments.feePercent != null ? payments.feePercent : undefined,
        minPayoutSat: payments.minPayoutSat != null ? payments.minPayoutSat : undefined,
        schemes,
      };
    };
    if (pathname === '/api/reconcile') {
      sendJson(res, 200, payoutsReconcile.reconcile(readStore()));
      return;
    }
    if (pathname === '/api/breakdowns') {
      const limit = parsed.searchParams.get('limit');
      const all = payoutsBreakdown.listBreakdowns(readStore(), fairnessOptions());
      const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
      sendJson(res, 200, all.slice(0, n));
      return;
    }
    const blockRoute = pathname.match(/^\/api\/blocks\/(\d+)\/(breakdown|ledger)$/);
    if (blockRoute) {
      const height = Number(blockRoute[1]);
      const algoParam = (parsed.searchParams.get('algo') || '').toLowerCase() || undefined;
      const opts = Object.assign(fairnessOptions(), { algo: algoParam });
      const store = readStore();
      const payload = blockRoute[2] === 'breakdown'
        ? payoutsBreakdown.breakdownForHeight(store, height, opts)
        : payoutsBreakdown.ledgerExport(store, height, opts);
      if (!payload) {
        sendJson(res, 404, { error: 'block not found' });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }
    if (pathname.startsWith('/api/miner/')) {
      let address = '';
      try {
        address = decodeURIComponent(pathname.slice('/api/miner/'.length));
      } catch (_) {
        address = '';
      }
      const payload = address ? minerPayload(readStore(), address) : null;
      if (!payload) {
        sendJson(res, 404, { error: 'miner not found' });
        return;
      }
      sendJson(res, 200, payload);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // -------------------------------------------------------------- static
    serveStatic(req, res, uiDir, pathname);
  });

  // Exposed for integration/tests: the collector this server reports on.
  server.collector = collector;
  server.payoutsFile = payoutsFile;
  server.poolConfig = poolConfig;
  return server;
}

function serveStatic(req, res, uiDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const uiRoot = path.resolve(uiDir);
  const filePath = path.resolve(uiRoot, rel);

  // Path traversal guard: the resolved path must stay inside ui/.
  if (filePath !== uiRoot && !filePath.startsWith(uiRoot + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel === 'index.html') {
        // No built dashboard (yet): built-in placeholder, still a 200 so
        // a browser landing on / sees a page, not an error.
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end();
        } else {
          sendHtml(res, 200, PLACEHOLDER_HTML);
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext] || 'application/octet-stream';
    /* Cache policy (the dashboard sits behind Cloudflare in
       production): code and styles revalidate on EVERY load via
       Last-Modified, so a deploy is visible on the next refresh —
       no heuristic caching of styles.css, ever. The nedb-wasm
       engine binary is content-pinned and caches for a year;
       media gets a day. index.html also version-stamps its asset
       URLs (?v=) as a second bust. */
    let cacheControl;
    if (ext === '.wasm') cacheControl = 'public, max-age=31536000, immutable';
    else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2'].includes(ext)) cacheControl = 'public, max-age=86400';
    else cacheControl = 'no-cache';
    const lastModified = stat.mtime.toUTCString();
    const ims = req.headers['if-modified-since'];
    if (ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000) {
      res.writeHead(304, { 'Cache-Control': cacheControl, 'Last-Modified': lastModified });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'Last-Modified': lastModified,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) sendJson(res, 500, { error: 'read error' });
      else res.destroy();
    });
    stream.pipe(res);
  });
}

module.exports = { createServer, StatsCollector };

if (require.main === module) {
  // ITC_API_PORT (the phase-3 env layer, see lib/envConfig.js) wins;
  // PORT remains as the legacy standalone override.
  const port = Number(process.env.ITC_API_PORT) || Number(process.env.PORT) || DEFAULT_PORT;
  const collector = new StatsCollector();
  /* Reader coherence: resolve the payouts store from the SAME pool
   * config the pool process loads (ITC_POOL_CONFIG or the default
   * config path), so a payments.dataFile set there — not just the
   * env knobs — points this standalone reader at the writer's file.
   * A missing/unparseable config is fine: env + default still apply. */
  let storeConfig = null;
  try {
    const cfgPath = process.env.ITC_POOL_CONFIG
      ? path.resolve(process.env.ITC_POOL_CONFIG)
      : path.join(__dirname, '..', 'config', 'interchained-mainnet.json');
    storeConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    storeConfig = null;
  }
  const server = createServer({ collector, storeConfig });
  server.listen(port, () => {
    console.log(
      'ITC pool stats/API listening on port ' + port +
        ' (standalone collector, no pools attached - zeros are correct)'
    );
  });
  const shutdown = () => {
    try { collector.flush(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
