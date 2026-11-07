'use strict';

/* Interchained Tri-PoW pool dashboard — vanilla JS, no dependencies.
   All API-supplied strings are rendered with textContent / createElement.
   Static structure lives in index.html; this file only fills it in. */

var ALGOS = ['sha256', 'yespower', 'ethash'];

var ALGO_META = {
  sha256: { label: 'SHA256', kind: 'ASIC', defaultPort: 3333 },
  yespower: { label: 'Yespower', kind: 'CPU', defaultPort: 3334 },
  ethash: { label: 'Ethash', kind: 'GPU', defaultPort: 3335 }
};

var REFRESH_MS = 10000;

var state = {
  ports: { sha256: 3333, yespower: 3334, ethash: 3335 },
  schemes: {},
  payments: null,
  blockStatus: {},
  startedAtMs: null,
  uptimeBaseSeconds: null,
  uptimeFetchedAtMs: null,
  bannerDismissed: false
};

/* ---------- formatting helpers ---------- */

function asNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatHashrate(value) {
  var units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
  var n = asNumber(value);
  var idx = 0;
  while (n >= 1000 && idx < units.length - 1) {
    n = n / 1000;
    idx += 1;
  }
  var text = idx === 0 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, '');
  return text + ' ' + units[idx];
}

function formatCount(value) {
  return String(Math.round(asNumber(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatItcFromSat(sat) {
  var itc = asNumber(sat) / 1e8;
  return itc.toFixed(8).replace(/\.?0+$/, '') + ' ITC';
}

function formatItcValue(itc) {
  var n = asNumber(itc);
  return n.toFixed(8).replace(/\.?0+$/, '') + ' ITC';
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  var d;
  if (typeof value === 'number') {
    // Unix seconds vs milliseconds: seconds are < 1e11 for any realistic date.
    d = new Date(value < 1e11 ? value * 1000 : value);
  } else {
    d = new Date(value);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatRelativeTime(value) {
  var d = toDate(value);
  if (!d) return '—';
  var diffSeconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSeconds < 0) return 'just now';
  if (diffSeconds < 10) return 'just now';
  if (diffSeconds < 60) return diffSeconds + 's ago';
  var minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  return days + 'd ago';
}

function formatDateTime(value) {
  var d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString();
}

function formatUptime(totalSeconds) {
  var s = Math.max(0, Math.floor(asNumber(totalSeconds)));
  var days = Math.floor(s / 86400);
  var hours = Math.floor((s % 86400) / 3600);
  var minutes = Math.floor((s % 3600) / 60);
  var seconds = s % 60;
  var parts = [];
  if (days > 0) parts.push(days + 'd');
  parts.push(hours + 'h');
  parts.push(minutes + 'm');
  parts.push(seconds + 's');
  return parts.join(' ');
}

function truncateHash(hash) {
  var h = String(hash === null || hash === undefined ? '' : hash);
  if (h.length <= 20) return h;
  return h.slice(0, 10) + '…' + h.slice(-8);
}

function normalizeAlgo(value) {
  var a = String(value || '').toLowerCase();
  return ALGOS.indexOf(a) !== -1 ? a : a;
}

/* ---------- DOM helpers ---------- */

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function badgeFor(algo) {
  var a = normalizeAlgo(algo);
  var meta = ALGO_META[a];
  var badge = el('span', 'badge badge-' + (ALGOS.indexOf(a) !== -1 ? a : 'sha256'));
  badge.textContent = meta ? meta.label : String(algo || 'unknown');
  return badge;
}

function field(card, name) {
  return card.querySelector('[data-field="' + name + '"]');
}

/* ---------- rendering: stats ---------- */

function renderStats(stats) {
  if (!stats || typeof stats !== 'object') return;

  var uptimeSeconds = asNumber(stats.uptimeSeconds);
  if (stats.startedAt !== null && stats.startedAt !== undefined) {
    var started = toDate(stats.startedAt);
    if (started) state.startedAtMs = started.getTime();
  }
  if (uptimeSeconds > 0 || state.uptimeBaseSeconds === null) {
    state.uptimeBaseSeconds = uptimeSeconds;
    state.uptimeFetchedAtMs = Date.now();
  }
  updateUptime();

  var algos = (stats.algos && typeof stats.algos === 'object') ? stats.algos : {};
  ALGOS.forEach(function (algo) {
    var card = document.querySelector('[data-algo-card="' + algo + '"]');
    if (!card) return;
    var data = (algos[algo] && typeof algos[algo] === 'object') ? algos[algo] : {};
    var hashrate = asNumber(data.hashrate);
    var accepted = asNumber(data.sharesAccepted);
    var rejected = asNumber(data.sharesRejected);
    var workers = asNumber(data.workers);

    field(card, 'hashrate').textContent = formatHashrate(hashrate);
    field(card, 'workers').textContent = formatCount(workers);
    field(card, 'shares-accepted').textContent = formatCount(accepted);
    field(card, 'shares-rejected').textContent = formatCount(rejected);

    var waiting = field(card, 'waiting');
    if (waiting) waiting.hidden = !(hashrate === 0 && accepted === 0 && workers === 0);

    var lastBlockEl = field(card, 'last-block');
    var lb = data.lastBlock;
    if (lb && typeof lb === 'object') {
      var heightText = lb.height !== null && lb.height !== undefined ? '#' + formatCount(lb.height) : 'Block';
      var when = lb.time !== null && lb.time !== undefined ? ' · ' + formatRelativeTime(lb.time) : '';
      lastBlockEl.textContent = heightText + when;
      lastBlockEl.title = lb.hash ? String(lb.hash) : '';
    } else {
      lastBlockEl.textContent = 'No blocks yet';
      lastBlockEl.title = '';
    }
  });
}

function currentUptimeSeconds() {
  if (state.startedAtMs) {
    return Math.max(0, (Date.now() - state.startedAtMs) / 1000);
  }
  if (state.uptimeBaseSeconds !== null && state.uptimeFetchedAtMs) {
    return state.uptimeBaseSeconds + (Date.now() - state.uptimeFetchedAtMs) / 1000;
  }
  return null;
}

function updateUptime() {
  var node = document.getElementById('uptime');
  if (!node) return;
  var seconds = currentUptimeSeconds();
  node.textContent = seconds === null ? '—' : formatUptime(seconds);
}

/* ---------- rendering: workers ---------- */

function renderWorkers(workers) {
  var tbody = document.getElementById('workers-body');
  var empty = document.getElementById('workers-empty');
  if (!tbody) return;
  var list = Array.isArray(workers) ? workers : [];

  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  if (empty) empty.hidden = list.length > 0;

  list.forEach(function (w) {
    var item = (w && typeof w === 'object') ? w : {};
    var row = document.createElement('tr');

    var nameCell = el('td');
    nameCell.appendChild(el('span', 'worker-name', item.worker || 'unknown'));
    row.appendChild(nameCell);

    var algoCell = el('td');
    algoCell.appendChild(badgeFor(item.algo));
    row.appendChild(algoCell);

    row.appendChild(el('td', null, formatHashrate(item.hashrate)));

    var sharesText = formatCount(item.shares) + ' / ' + formatCount(item.invalidShares);
    row.appendChild(el('td', null, sharesText));

    var connected = item.connected === true || item.connected === 1 || item.connected === 'true';
    var statusCell = el('td');
    statusCell.appendChild(el('span', 'status-pill ' + (connected ? 'status-connected' : 'status-offline'), connected ? '● Connected' : '○ Offline'));
    row.appendChild(statusCell);

    var lastCell = el('td', null, item.lastShareAt ? formatRelativeTime(item.lastShareAt) : '—');
    if (item.lastShareAt) lastCell.title = formatDateTime(item.lastShareAt);
    row.appendChild(lastCell);

    tbody.appendChild(row);
  });
}

/* ---------- rendering: blocks ---------- */

function renderBlocks(blocks) {
  var tbody = document.getElementById('blocks-body');
  var empty = document.getElementById('blocks-empty');
  var list = Array.isArray(blocks) ? blocks : [];
  if (tbody) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    list.forEach(function (b) {
      var item = (b && typeof b === 'object') ? b : {};
      var key = String(item.algo || '').toLowerCase() + ':' + String(item.height);
      var status = item.status || state.blockStatus[key] || null;
      var row = document.createElement('tr');
      row.appendChild(el('td', 'block-height', item.height !== null && item.height !== undefined ? '#' + formatCount(item.height) : '—'));
      var algoCell = el('td');
      algoCell.appendChild(badgeFor(item.algo));
      row.appendChild(algoCell);
      var hashCell = el('td', 'block-hash mono', truncateHash(item.hash));
      if (item.hash) hashCell.title = String(item.hash);
      row.appendChild(hashCell);
      var timeCell = el('td', null, formatRelativeTime(item.time));
      timeCell.title = formatDateTime(item.time);
      row.appendChild(timeCell);
      var statusCell = el('td');
      if (status) {
        statusCell.appendChild(el('span', 'status-pill dist-' + String(status).toLowerCase(), String(status)));
      } else {
        statusCell.textContent = '—';
      }
      row.appendChild(statusCell);
      tbody.appendChild(row);
    });
  }
  if (empty) empty.hidden = list.length > 0;
}

function renderStoreBlocks(blocks) {
  state.blockStatus = {};
  (Array.isArray(blocks) ? blocks : []).forEach(function (b) {
    if (!b || typeof b !== 'object') return;
    state.blockStatus[String(b.algo || '').toLowerCase() + ':' + String(b.height)] = b.status || 'pending';
  });
}

/* ---------- rendering: payouts + miner lookup ---------- */

function renderSchemeBadges() {
  ALGOS.forEach(function (algo) {
    var card = document.querySelector('[data-algo-card="' + algo + '"]');
    if (!card) return;
    var badge = field(card, 'scheme');
    if (!badge) return;
    var scheme = state.schemes[algo];
    badge.textContent = scheme ? String(scheme).toUpperCase() : '—';
    badge.className = 'badge badge-scheme' + (scheme ? ' scheme-' + String(scheme).toLowerCase() : '');
  });
}

/* Payout batch status cell: dry-runs show their PSBT stage, live
 * batches show the txid once sent (or the stage they are stuck at). */
function payoutStatusText(item) {
  if (item.dryRun) return item.stage ? 'dry-run · psbt ' + item.stage : 'dry-run';
  if (item.txid) return truncateHash(item.txid);
  if (item.stage) return 'psbt ' + item.stage;
  return '—';
}

function renderPayouts(data) {
  var pool = (data && typeof data === 'object' && data.pool && typeof data.pool === 'object')
    ? data.pool : (state.payments || {});
  var feeEl = document.getElementById('payouts-fee');
  var minEl = document.getElementById('payouts-min');
  var confEl = document.getElementById('payouts-confirmations');
  var modeEl = document.getElementById('payouts-mode');
  if (feeEl) feeEl.textContent = pool.feePercent !== null && pool.feePercent !== undefined ? String(pool.feePercent) + '%' : '—';
  if (minEl) {
    // Pool config denominates minPayout in ITC coins (see api/server.js
    // paymentsSummary); prefer the explicit Itc/Sat pair when present.
    if (pool.minPayoutItc !== null && pool.minPayoutItc !== undefined) {
      minEl.textContent = String(pool.minPayoutItc) + ' ITC' +
        (pool.minPayoutSat !== null && pool.minPayoutSat !== undefined
          ? ' (' + formatCount(pool.minPayoutSat) + ' sat)' : '');
    } else if (pool.minPayout !== null && pool.minPayout !== undefined) {
      minEl.textContent = String(pool.minPayout) + ' ITC';
    } else {
      minEl.textContent = '—';
    }
  }
  if (confEl) confEl.textContent = pool.confirmations !== null && pool.confirmations !== undefined ? formatCount(pool.confirmations) : '—';
  if (modeEl) {
    if (pool.dryRun === true) {
      modeEl.textContent = 'DRY-RUN — no real payouts';
      modeEl.className = 'badge badge-mode badge-dryrun';
    } else if (pool.dryRun === false) {
      modeEl.textContent = 'LIVE';
      modeEl.className = 'badge badge-mode badge-live';
    } else {
      modeEl.textContent = 'Not configured';
      modeEl.className = 'badge badge-mode';
    }
  }
  var tbody = document.getElementById('payouts-body');
  var empty = document.getElementById('payouts-empty');
  if (!tbody) return;
  var list = (data && Array.isArray(data.payouts)) ? data.payouts : [];
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  if (empty) empty.hidden = list.length > 0;
  list.slice(0, 20).forEach(function (batch) {
    var item = (batch && typeof batch === 'object') ? batch : {};
    var row = document.createElement('tr');
    var timeCell = el('td', null, formatRelativeTime(item.time));
    timeCell.title = formatDateTime(item.time);
    row.appendChild(timeCell);
    var algoCell = el('td');
    algoCell.appendChild(badgeFor(item.algo));
    row.appendChild(algoCell);
    var totalSat = item.totalSat !== undefined ? item.totalSat
      : Object.keys(item.amounts || {}).reduce(function (sum, k) { return sum + asNumber(item.amounts[k]); }, 0);
    row.appendChild(el('td', null, formatItcFromSat(totalSat)));
    var miners = item.minersPaid !== undefined ? item.minersPaid : Object.keys(item.amounts || {}).length;
    row.appendChild(el('td', null, formatCount(miners)));
    row.appendChild(el('td', 'mono', payoutStatusText(item)));
    tbody.appendChild(row);
  });
}

function renderMiner(data) {
  var notFound = document.getElementById('miner-notfound');
  var empty = document.getElementById('miner-empty');
  var result = document.getElementById('miner-result');
  var tbody = document.getElementById('miner-body');
  var totals = document.getElementById('miner-totals');
  if (notFound) notFound.hidden = true;
  if (empty) empty.hidden = true;
  if (result) result.hidden = false;
  if (!tbody || !data) return;
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
  var algos = (data.algos && typeof data.algos === 'object') ? data.algos : {};
  Object.keys(algos).forEach(function (algo) {
    var a = algos[algo] || {};
    if (!asNumber(a.shares) && !asNumber(a.pendingSat) && !asNumber(a.paidSat)) return;
    var row = document.createElement('tr');
    var algoCell = el('td');
    algoCell.appendChild(badgeFor(algo));
    row.appendChild(algoCell);
    row.appendChild(el('td', null, formatCount(a.shares)));
    row.appendChild(el('td', null, formatHashrate(a.hashrateEstimate)));
    row.appendChild(el('td', null, a.lastShareAt ? formatRelativeTime(a.lastShareAt) : '—'));
    row.appendChild(el('td', null, formatItcValue(a.pendingItc) + ' (' + formatCount(a.pendingSat) + ' sat)'));
    row.appendChild(el('td', null, formatItcValue(a.paidItc) + ' (' + formatCount(a.paidSat) + ' sat)'));
    tbody.appendChild(row);
  });
  if (totals && data.totals) {
    totals.textContent = formatCount(data.totals.shares) + ' shares · ' +
      formatHashrate(data.totals.hashrateEstimate) + ' · pending ' +
      formatItcValue(data.totals.pendingItc) + ' · paid ' + formatItcValue(data.totals.paidItc);
  }
}

function renderMinerNotFound() {
  var notFound = document.getElementById('miner-notfound');
  var empty = document.getElementById('miner-empty');
  var result = document.getElementById('miner-result');
  if (notFound) notFound.hidden = false;
  if (empty) empty.hidden = true;
  if (result) result.hidden = true;
}

function lookupMiner(address) {
  if (!address) return;
  fetch('/api/miner/' + encodeURIComponent(address), { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(function (res) {
      if (res.status === 404) { renderMinerNotFound(); return null; }
      if (!res.ok) throw new Error('miner lookup ' + res.status);
      return res.json();
    })
    .then(function (data) { if (data) renderMiner(data); })
    .catch(function () { renderMinerNotFound(); });
}

/* ---------- rendering: connection panel ---------- */

function minerExample(algo, host, port) {
  var url = 'stratum+tcp://' + host + ':' + port;
  if (algo === 'sha256') {
    return 'ASIC dashboard — Pool URL: ' + url + '  ·  Worker: YOUR_ITC_ADDRESS.asic1  ·  Password: x';
  }
  if (algo === 'yespower') {
    return 'cpuminer-opt -a yespower -o ' + url + ' -u YOUR_ITC_ADDRESS.cpu1 -p x';
  }
  return 'ethminer -U -P stratum+tcp://YOUR_ITC_ADDRESS.gpu1:x@' + host + ':' + port;
}

function makeCopyRow(text, isExample) {
  var wrap = el('div', 'copy-row');
  var code = el('code', 'copy-text' + (isExample ? ' example' : ''), text);
  var btn = el('button', 'copy-btn', 'Copy');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Copy to clipboard');
  btn.addEventListener('click', function () {
    function done() {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      // Offline / non-secure fallback: select-free textarea copy.
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
      document.body.removeChild(ta);
      done();
    }
  });
  wrap.appendChild(code);
  wrap.appendChild(btn);
  return wrap;
}

function renderConnection() {
  var container = document.getElementById('connection-list');
  if (!container) return;
  var host = window.location.hostname || 'localhost';

  while (container.firstChild) container.removeChild(container.firstChild);

  ALGOS.forEach(function (algo) {
    var meta = ALGO_META[algo];
    var port = state.ports[algo] || meta.defaultPort;
    var card = el('article', 'connection-card');

    var heading = el('h3');
    heading.appendChild(badgeFor(algo));
    heading.appendChild(el('span', null, meta.label + ' · Port ' + port));
    card.appendChild(heading);

    card.appendChild(el('span', 'copy-label', 'Stratum URL'));
    card.appendChild(makeCopyRow('stratum+tcp://' + host + ':' + port, false));

    card.appendChild(el('span', 'copy-label', 'Example miner'));
    card.appendChild(makeCopyRow(minerExample(algo, host, port), true));

    container.appendChild(card);
  });
}

function renderConfig(config) {
  if (!config || typeof config !== 'object') {
    renderConnection();
    renderSchemeBadges();
    renderPayouts(null);
    return;
  }
  // Accept every shape the API has used: algos as a map
  // ({algo:{algo|name, stratumPort|port, scheme}}), algoList, or an
  // algos array (phase-1 UI expectation).
  var entries = [];
  if (Array.isArray(config.algoList)) entries = entries.concat(config.algoList);
  if (Array.isArray(config.algos)) entries = entries.concat(config.algos);
  else if (config.algos && typeof config.algos === 'object') {
    Object.keys(config.algos).forEach(function (key) {
      var e = config.algos[key] || {};
      entries.push(Object.assign({ algo: e.algo || e.name || key }, e));
    });
  }
  if (config.stratumPorts && typeof config.stratumPorts === 'object') {
    Object.keys(config.stratumPorts).forEach(function (key) {
      entries.push({ algo: key, stratumPort: config.stratumPorts[key] });
    });
  }
  entries.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    var name = normalizeAlgo(entry.algo || entry.name || entry.algorithm);
    if (ALGOS.indexOf(name) === -1) return;
    var port = entry.stratumPort || entry.port;
    if (port) state.ports[name] = asNumber(port) || state.ports[name];
    if (entry.scheme) state.schemes[name] = String(entry.scheme).toLowerCase();
  });
  if (config.payments && typeof config.payments === 'object') {
    state.payments = config.payments;
  }
  renderConnection();
  renderSchemeBadges();
  renderPayouts(null);
}

/* ---------- rendering: fairness (phase 3) ---------- */

function formatSatCoins(sat) {
  return formatItcFromSat(sat) + ' (' + formatCount(sat) + ' sat)';
}

function renderReconcile(rec) {
  var summary = document.getElementById('reconcile-summary');
  var equation = document.getElementById('reconcile-equation');
  var list = document.getElementById('reconcile-discrepancies');
  if (!summary || !rec || typeof rec !== 'object') return;
  var agg = rec.aggregate || {};
  var errors = (rec.discrepancies || []).filter(function (d) { return d.severity !== 'notice'; });
  summary.textContent = rec.balanced
    ? 'Reconciliation: BALANCED across ' + formatCount(rec.settledBlocks) + ' settled block(s).'
    : 'Reconciliation: ' + errors.length + ' discrepancy(ies) — the books do NOT balance; see below.';
  summary.className = rec.balanced ? 'reconcile-ok' : 'reconcile-bad';
  if (equation) {
    equation.hidden = false;
    equation.textContent = 'Rewards in ' + formatSatCoins(agg.rewardInSat) +
      ' = payouts ' + formatSatCoins(agg.payoutsSat) +
      ' + fees ' + formatSatCoins(agg.feeSat) +
      ' + carry-over ' + formatSatCoins(agg.carryOverDeltaSat) +
      (agg.undistributedSat ? ' + undistributed ' + formatSatCoins(agg.undistributedSat) : '');
  }
  if (list) {
    while (list.firstChild) list.removeChild(list.firstChild);
    (rec.discrepancies || []).forEach(function (d) {
      list.appendChild(el('li', null, (d.kind || 'discrepancy') + ': ' + (d.message || '')));
    });
    list.hidden = !(rec.discrepancies || []).length;
  }
}

function renderBreakdownList(listData) {
  var select = document.getElementById('fairness-block-select');
  var empty = document.getElementById('fairness-empty');
  if (!select) return;
  var items = (Array.isArray(listData) ? listData : []).filter(function (b) { return b && b.settled; });
  var previous = select.value;
  while (select.firstChild) select.removeChild(select.firstChild);
  items.forEach(function (b) {
    var opt = document.createElement('option');
    opt.value = String(b.height) + '|' + String(b.algo || '');
    opt.textContent = '#' + b.height + ' · ' + String(b.algo || '') + ' · ' + String(b.scheme || '') +
      ' · ' + formatItcFromSat(b.rewardSat);
    select.appendChild(opt);
  });
  if (previous && items.some(function (b) { return String(b.height) + '|' + String(b.algo || '') === previous; })) {
    select.value = previous;
  }
  if (empty) empty.hidden = items.length > 0;
  select.disabled = items.length === 0;
}

function renderBreakdown(bd) {
  var result = document.getElementById('fairness-result');
  var meta = document.getElementById('fairness-meta');
  var win = document.getElementById('fairness-window');
  var tbody = document.getElementById('fairness-body');
  var totals = document.getElementById('fairness-totals');
  var link = document.getElementById('fairness-ledger-link');
  if (!result || !bd || typeof bd !== 'object') return;
  result.hidden = false;
  if (meta) {
    meta.textContent = 'Block #' + bd.height + ' (' + String(bd.algo) + ', ' + String(bd.scheme).toUpperCase() +
      ', ' + String(bd.status) + ') — reward ' + formatSatCoins(bd.rewardSat) +
      ' · pool fee ' + String(bd.feePercent) + '% = ' + formatSatCoins(bd.feeSat) +
      (bd.matchesRecorded === true ? ' · recompute matches the recorded split ✓'
        : bd.matchesRecorded === false ? ' · RECOMPUTE DOES NOT MATCH THE RECORDED SPLIT ✗' : '');
    meta.className = 'miner-totals' + (bd.matchesRecorded === false ? ' fairness-mismatch' : '');
  }
  if (win && bd.shareWindow) {
    var w = bd.shareWindow;
    win.textContent = 'Share window: ' + String(w.definition) +
      ' · ' + formatCount(w.shareCount) + ' share(s)' +
      (w.windowN ? ' (last ' + w.windowN + ')' : '') +
      (w.prevBlockTime != null ? ' · round opens after t=' + w.prevBlockTime : '') +
      ' · closes at block time t=' + String(w.toTime);
  }
  if (tbody) {
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    (bd.miners || []).forEach(function (m) {
      var row = document.createElement('tr');
      row.appendChild(el('td', 'mono', m.address));
      row.appendChild(el('td', null, formatCount(m.shareCount)));
      row.appendChild(el('td', null, String(m.weight) + ' (' + String(m.weightPercent) + '%)'));
      row.appendChild(el('td', null, formatSatCoins(m.payoutAmountSat)));
      row.appendChild(el('td', null, formatSatCoins(m.paidOutSat)));
      row.appendChild(el('td', null, formatSatCoins(m.carryOverCreatedSat)));
      row.appendChild(el('td', null, formatSatCoins(m.carryOverConsumedSat)));
      tbody.appendChild(row);
    });
  }
  if (totals) {
    totals.textContent = 'Totals: credited ' + formatSatCoins(bd.creditedSat) +
      ' + fee ' + formatSatCoins(bd.feeSat) + ' = reward ' + formatSatCoins(bd.rewardSat) +
      (bd.balanced ? ' ✓ balanced' : ' ✗ DOES NOT BALANCE');
  }
  if (link) link.href = '/api/blocks/' + bd.height + '/ledger?algo=' + encodeURIComponent(String(bd.algo || ''));
}

function loadBreakdown() {
  var select = document.getElementById('fairness-block-select');
  if (!select || !select.value) return;
  var parts = select.value.split('|');
  var url = '/api/blocks/' + encodeURIComponent(parts[0]) + '/breakdown?algo=' + encodeURIComponent(parts[1] || '');
  fetchJson(url).then(function (bd) {
    renderBreakdown(Array.isArray(bd) ? bd[0] : bd);
  }).catch(function () { /* status banner covers API failures */ });
}

/* ---------- fetching / status ---------- */

function fetchJson(path) {
  return fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (res) {
    if (!res.ok) throw new Error(path + ' returned ' + res.status);
    return res.json();
  });
}

function setApiStatus(ok) {
  var dot = document.getElementById('api-dot');
  var text = document.getElementById('api-status-text');
  var banner = document.getElementById('api-banner');
  if (dot) {
    dot.className = 'status-dot ' + (ok ? 'status-ok' : 'status-error');
  }
  if (text) text.textContent = ok ? 'API online' : 'API unreachable';
  if (banner) {
    if (ok) {
      banner.hidden = true;
      state.bannerDismissed = false;
    } else if (!state.bannerDismissed) {
      banner.hidden = false;
    }
  }
}

function refresh() {
  var endpoints = [
    fetchJson('/api/stats'),
    fetchJson('/api/blocks'),
    fetchJson('/api/workers'),
    fetchJson('/api/config'),
    fetchJson('/api/payouts'),
    fetchJson('/api/payouts/blocks'),
    fetchJson('/api/breakdowns'),
    fetchJson('/api/reconcile')
  ];
  return Promise.allSettled(endpoints).then(function (results) {
    var anyOk = results.some(function (r) { return r.status === 'fulfilled'; });
    var allOk = results.every(function (r) { return r.status === 'fulfilled'; });
    setApiStatus(allOk);

    // Render whatever succeeded; a partial failure never blanks good data.
    if (results[0].status === 'fulfilled') renderStats(results[0].value);
    if (results[1].status === 'fulfilled') renderBlocks(results[1].value);
    if (results[2].status === 'fulfilled') renderWorkers(results[2].value);
    if (results[3].status === 'fulfilled') renderConfig(results[3].value);
    else if (anyOk) renderConnection();
    if (results[5] && results[5].status === 'fulfilled') {
      renderStoreBlocks(results[5].value);
      if (results[1].status === 'fulfilled') renderBlocks(results[1].value);
    }
    if (results[4] && results[4].status === 'fulfilled') renderPayouts(results[4].value);
    if (results[6] && results[6].status === 'fulfilled') renderBreakdownList(results[6].value);
    if (results[7] && results[7].status === 'fulfilled') renderReconcile(results[7].value);
    return allOk;
  }).catch(function () {
    // Promise.allSettled should not reject, but never let refresh crash the loop.
    setApiStatus(false);
    return false;
  });
}

/* ---------- boot ---------- */

function init() {
  var dismiss = document.getElementById('api-banner-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', function () {
      state.bannerDismissed = true;
      var banner = document.getElementById('api-banner');
      if (banner) banner.hidden = true;
    });
  }

  var fairnessLoad = document.getElementById('fairness-load');
  if (fairnessLoad) fairnessLoad.addEventListener('click', loadBreakdown);
  var fairnessSelect = document.getElementById('fairness-block-select');
  if (fairnessSelect) fairnessSelect.addEventListener('change', loadBreakdown);

  var minerForm = document.getElementById('miner-form');
  if (minerForm) {
    minerForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var input = document.getElementById('miner-address');
      lookupMiner(input ? input.value.trim() : '');
    });
  }

  renderConnection();
  renderSchemeBadges();
  renderPayouts(null);
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(updateUptime, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
