'use strict';

/* Interchained Tri-PoW pool dashboard — vanilla JS, no dependencies.
   All API-supplied strings are rendered with textContent / createElement.
   Static structure lives in index.html; this file only fills it in.
   Charts seed from the pool's NEDB vitals cache (/api/history — the
   30 s sample series the pool process persists) and then keep
   accumulating live /api/stats samples in a client-side ring buffer,
   so the history survives reboots and page loads alike. */

var ALGOS = ['sha256', 'yespower', 'ethash'];

var ALGO_META = {
  sha256:   { label: 'SHA256',   kind: 'ASIC', defaultPort: 3333, color: '#ff5252' },
  yespower: { label: 'Yespower', kind: 'CPU',  defaultPort: 3334, color: '#46e046' },
  ethash:   { label: 'Ethash',   kind: 'GPU',  defaultPort: 3335, color: '#38b6ff' }
};

var REFRESH_MS = 10000;
var HISTORY_MAX = 90; /* 90 samples x 10s = 15 minutes of live chart */

var state = {
  ports: { sha256: 3333, yespower: 3334, ethash: 3335 },
  schemes: {},
  mode: null,
  payments: null,
  poolAddress: null,
  stratumHost: null,
  startedAtMs: null,
  uptimeBaseSeconds: null,
  uptimeFetchedAtMs: null,
  history: { sha256: [], yespower: [], ethash: [] },
  openBreakdowns: {}
};

/* ---------------- helpers ---------------- */

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function asNumber(value) {
  var n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fetchJson(url) {
  return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

var HASH_UNITS = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];

function splitHashrate(value) {
  var v = asNumber(value);
  if (v == null || v <= 0) return { num: '0', unit: 'H/s' };
  var i = 0;
  while (v >= 1000 && i < HASH_UNITS.length - 1) { v /= 1000; i++; }
  var num = v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  return { num: num, unit: HASH_UNITS[i] };
}

function formatHashrate(value) {
  var s = splitHashrate(value);
  return s.num + ' ' + s.unit;
}

function formatCount(value) {
  var v = asNumber(value);
  if (v == null) return '—';
  return Math.round(v).toLocaleString('en-US');
}

function formatItcFromSat(sat) {
  var v = asNumber(sat);
  if (v == null) return '—';
  var coins = v / 1e8;
  return coins.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 }) + ' ITC';
}

function toDate(value) {
  if (value == null) return null;
  var n = Number(value);
  if (Number.isFinite(n)) {
    /* collector times are ms; store times are seconds */
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatRelativeTime(value) {
  var d = toDate(value);
  if (!d) return '—';
  var secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return secs + 's ago';
  var mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function formatDateTime(value) {
  var d = toDate(value);
  if (!d) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatUptime(totalSeconds) {
  var s = Math.max(0, Math.floor(totalSeconds || 0));
  var d = Math.floor(s / 86400); s -= d * 86400;
  var h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function truncateHash(hash) {
  if (!hash) return '—';
  var h = String(hash);
  return h.length > 20 ? h.slice(0, 10) + '…' + h.slice(-8) : h;
}

function normalizeAlgo(a) {
  var s = String(a || '').toLowerCase();
  return ALGO_META[s] ? s : null;
}

/* ---------------- charts ---------------- */

function drawSeries(canvas, seriesList) {
  if (!canvas || !canvas.clientWidth) return;
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  var ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  seriesList.forEach(function (series) {
    var pts = series.points;
    if (!pts || pts.length < 2) return;
    var max = 0;
    pts.forEach(function (p) { if (p.v > max) max = p.v; });
    if (max <= 0) return;
    var minT = pts[0].t, maxT = pts[pts.length - 1].t;
    if (maxT === minT) return;
    function X(t) { return ((t - minT) / (maxT - minT)) * (w - 4) + 2; }
    function Y(v) { return h - 4 - (v / max) * (h - 12); }
    ctx.beginPath();
    pts.forEach(function (p, i) { if (i === 0) ctx.moveTo(X(p.t), Y(p.v)); else ctx.lineTo(X(p.t), Y(p.v)); });
    ctx.strokeStyle = series.color; ctx.lineWidth = 1.8; ctx.stroke();
    ctx.lineTo(X(maxT), h); ctx.lineTo(X(minT), h); ctx.closePath();
    ctx.globalAlpha = 0.10; ctx.fillStyle = series.color; ctx.fill(); ctx.globalAlpha = 1;
  });
}

function pushHistory(algo, value) {
  var arr = state.history[algo];
  arr.push({ t: Date.now(), v: Math.max(0, value || 0) });
  while (arr.length > HISTORY_MAX) arr.shift();
}

/* Seed the chart history from the vitals cache. The stored series is
   30 s samples kept indefinitely; the chart ring holds HISTORY_MAX
   points, so stride across the returned range to show ALL of it at
   reduced resolution rather than only the newest slice. Live points
   already collected stay (they are newer than any stored sample);
   seeded points older than the first live point are prepended. */
var historySeeded = false;
function seedHistory() {
  if (historySeeded) return;
  historySeeded = true;
  fetchJson('/api/history?limit=10000').then(function (res) {
    if (!res || !res.available || !Array.isArray(res.samples) || !res.samples.length) return;
    var samples = res.samples;
    ALGOS.forEach(function (a) {
      var live = state.history[a];
      var cutoff = live.length ? live[0].t : Infinity;
      var stored = [];
      samples.forEach(function (s) {
        if (s && typeof s.t === 'number' && s.t < cutoff) {
          stored.push({ t: s.t, v: Math.max(0, asNumber(s[a]) || 0) });
        }
      });
      if (!stored.length) return;
      var stride = Math.max(1, Math.ceil(stored.length / HISTORY_MAX));
      var seeded = [];
      for (var i = 0; i < stored.length; i += stride) seeded.push(stored[i]);
      if (seeded[seeded.length - 1] !== stored[stored.length - 1]) seeded.push(stored[stored.length - 1]);
      state.history[a] = seeded.concat(live).slice(-HISTORY_MAX);
    });
    drawCharts();
  }).catch(function () {});
}

function drawCharts() {
  drawSeries(document.getElementById('hero-chart'), ALGOS.map(function (a) {
    return { color: ALGO_META[a].color, points: state.history[a] };
  }));
  ALGOS.forEach(function (a) {
    var c = document.querySelector('canvas.algo-spark[data-algo="' + a + '"]');
    if (c) drawSeries(c, [{ color: ALGO_META[a].color, points: state.history[a] }]);
  });
}

/* ---------------- rendering: chrome ---------------- */

function setApiStatus(ok, text) {
  var dot = document.getElementById('api-dot');
  dot.className = 'dot ' + (ok ? 'on' : 'off');
  document.getElementById('api-status-text').textContent = text;
}

function currentUptimeSeconds() {
  if (state.uptimeBaseSeconds == null || state.uptimeFetchedAtMs == null) return null;
  return state.uptimeBaseSeconds + Math.max(0, (Date.now() - state.uptimeFetchedAtMs) / 1000);
}

function updateUptime() {
  var s = currentUptimeSeconds();
  document.getElementById('uptime-chip').textContent = 'uptime ' + (s == null ? '—' : formatUptime(s));
}

/* ---------------- rendering: hero + algo cards ---------------- */

function renderStats(stats) {
  var algos = (stats && stats.algos) || {};
  var totalHash = 0, totalWorkers = 0, totalBlocks = 0, acc = 0, rej = 0;
  ALGOS.forEach(function (a) {
    var s = algos[a] || {};
    var hr = asNumber(s.hashrate) || 0;
    totalHash += hr;
    totalWorkers += asNumber(s.workers) || 0;
    totalBlocks += asNumber(s.blocksFound) || 0;
    acc += asNumber(s.sharesAccepted) || 0;
    rej += asNumber(s.sharesRejected) || 0;
    pushHistory(a, hr);
  });
  var hero = document.getElementById('hero-hashrate');
  hero.textContent = '';
  var split = splitHashrate(totalHash);
  hero.appendChild(document.createTextNode(split.num));
  var unit = el('span', 'unit', split.unit);
  hero.appendChild(unit);
  document.getElementById('hero-workers').textContent = formatCount(totalWorkers);
  document.getElementById('hero-blocks').textContent = formatCount(totalBlocks);
  document.getElementById('hero-shares').textContent = formatCount(acc);
  var tot = acc + rej;
  document.getElementById('hero-reject').textContent = tot > 0 ? (100 * rej / tot).toFixed(2) + '%' : '0%';
  if (stats && stats.startedAt != null) {
    var st = toDate(stats.startedAt);
    if (st) state.startedAtMs = st.getTime();
  }
  if (stats && stats.uptimeSeconds != null) {
    state.uptimeBaseSeconds = asNumber(stats.uptimeSeconds);
    state.uptimeFetchedAtMs = Date.now();
  }
  renderAlgoCards(algos);
  drawCharts();
}

function schemeBadge(algo) {
  var scheme = state.schemes[algo] || 'solo';
  var b = el('span', 'badge ' + (scheme === 'solo' ? 'solo' : 'group'), scheme);
  return b;
}

function connectUrl(algo) {
  /* The stratum host is a deployment property served by /api/config —
     NOT the hostname this page was browsed through (viewing via
     mine.interchained.org used to put that in the connect strings). */
  var host = state.stratumHost || 'stratum.interchained.org';
  return 'stratum+tcp://' + host + ':' + state.ports[algo];
}

function makeCopyRow(algo) {
  var row = el('div', 'connect-row');
  row.appendChild(el('span', 'connect-url mono', connectUrl(algo)));
  var btn = el('button', 'copy-btn', 'COPY');
  btn.type = 'button';
  btn.addEventListener('click', function () {
    var url = connectUrl(algo);
    function done() {
      btn.textContent = 'COPIED';
      btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'COPY'; btn.classList.remove('copied'); }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, done);
    } else { done(); }
  });
  row.appendChild(btn);
  return row;
}

function algoRow(k, vNode) {
  var row = el('div', 'algo-row');
  row.appendChild(el('span', 'k', k));
  var v = el('span', 'v');
  if (typeof vNode === 'string') v.textContent = vNode; else v.appendChild(vNode);
  row.appendChild(v);
  return row;
}

function renderAlgoCards(algos) {
  var grid = document.getElementById('algo-grid');
  grid.textContent = '';
  ALGOS.forEach(function (a) {
    var meta = ALGO_META[a];
    var s = algos[a] || {};
    var card = el('div', 'algo-card');
    card.setAttribute('data-algo', a);
    var head = el('div', 'algo-head');
    head.appendChild(el('span', 'algo-name', meta.label));
    head.appendChild(el('span', 'algo-kind', meta.kind));
    card.appendChild(head);
    var hr = splitHashrate(asNumber(s.hashrate) || 0);
    var hrNode = el('div', 'algo-hashrate mono');
    hrNode.appendChild(document.createTextNode(hr.num));
    hrNode.appendChild(el('span', 'unit', hr.unit));
    card.appendChild(hrNode);
    var spark = document.createElement('canvas');
    spark.className = 'algo-spark';
    spark.setAttribute('data-algo', a);
    card.appendChild(spark);
    var rows = el('div', 'algo-rows');
    rows.appendChild(algoRow('Miners', formatCount(s.workers)));
    rows.appendChild(algoRow('Shares', formatCount(s.sharesAccepted) + ' / ' + formatCount(s.sharesRejected) + ' rej'));
    rows.appendChild(algoRow('Blocks found', formatCount(s.blocksFound)));
    var lb = s.lastBlock;
    rows.appendChild(algoRow('Last block', lb && lb.height != null ? '#' + formatCount(lb.height) + ' · ' + formatRelativeTime(lb.time) : '—'));
    var schemeRow = algoRow('Scheme', '');
    schemeRow.querySelector('.v').appendChild(schemeBadge(a));
    rows.appendChild(schemeRow);
    rows.appendChild(algoRow('Stratum port', String(state.ports[a])));
    card.appendChild(rows);
    card.appendChild(makeCopyRow(a));
    grid.appendChild(card);
  });
  drawCharts();
}

/* ---------------- rendering: workers ---------------- */

function renderWorkers(workers) {
  var tbody = document.querySelector('#workers-table tbody');
  tbody.textContent = '';
  var list = Array.isArray(workers) ? workers.slice() : [];
  list.sort(function (x, y) { return (asNumber(y.hashrate) || 0) - (asNumber(x.hashrate) || 0); });
  var online = list.filter(function (w) { return w.connected; }).length;
  document.getElementById('workers-note').textContent = list.length ? online + ' online · ' + list.length + ' known' : '';
  document.getElementById('workers-empty').classList.toggle('hidden', list.length > 0);
  document.getElementById('workers-table').classList.toggle('hidden', list.length === 0);
  list.forEach(function (w) {
    var algo = normalizeAlgo(w.algo);
    var tr = document.createElement('tr');
    var nameTd = el('td', 'worker-name', String(w.worker || '—'));
    nameTd.title = String(w.worker || '');
    tr.appendChild(nameTd);
    var algoTd = document.createElement('td');
    if (algo) {
      var chip = el('span', 'algo-chip ' + algo);
      algoTd.appendChild(chip);
      algoTd.appendChild(document.createTextNode(ALGO_META[algo].label));
    } else { algoTd.textContent = '—'; }
    tr.appendChild(algoTd);
    tr.appendChild(el('td', 'num', formatHashrate(w.hashrate)));
    tr.appendChild(el('td', 'num', formatCount(w.shares)));
    tr.appendChild(el('td', 'num', formatCount(w.invalidShares)));
    tr.appendChild(el('td', null, formatRelativeTime(w.lastShareAt)));
    var statusTd = document.createElement('td');
    statusTd.appendChild(el('span', 'status-dot ' + (w.connected ? 'on' : 'off')));
    tr.appendChild(statusTd);
    tbody.appendChild(tr);
  });
}

/* ---------------- rendering: blocks ---------------- */

function renderBlocks(collectorBlocks, storeBlocks) {
  var list = document.getElementById('blocks-list');
  list.textContent = '';
  var storeByHeight = {};
  (Array.isArray(storeBlocks) ? storeBlocks : []).forEach(function (b) {
    if (b && b.height != null) storeByHeight[String(b.height)] = b;
  });
  var blocks = (Array.isArray(collectorBlocks) ? collectorBlocks : []).slice(0, 30);
  document.getElementById('blocks-empty').classList.toggle('hidden', blocks.length > 0);
  var maxHeight = null;
  blocks.forEach(function (b) {
    var algo = normalizeAlgo(b.algo);
    var store = b.height != null ? storeByHeight[String(b.height)] : null;
    if (b.height != null && (maxHeight == null || Number(b.height) > maxHeight)) maxHeight = Number(b.height);
    var row = el('div', 'block-row');
    var left = document.createElement('div');
    var h = el('div', 'block-height mono', b.height != null ? '#' + formatCount(b.height) : '—');
    left.appendChild(h);
    if (algo) {
      var chipWrap = document.createElement('div');
      var chip = el('span', 'algo-chip ' + algo);
      chipWrap.appendChild(chip);
      chipWrap.appendChild(el('span', null, ALGO_META[algo].label));
      chipWrap.style.fontSize = '12px';
      chipWrap.style.color = 'var(--muted)';
      left.appendChild(chipWrap);
    }
    row.appendChild(left);
    var mid = document.createElement('div');
    mid.appendChild(el('div', 'block-hash', truncateHash(b.hash)));
    mid.appendChild(el('div', 'block-meta', formatRelativeTime(b.time) + ' · ' + formatDateTime(b.time)));
    row.appendChild(mid);
    var right = el('div', 'block-right');
    if (store && store.rewardItc != null) right.appendChild(el('div', 'block-reward', Number(store.rewardItc).toFixed(4) + ' ITC'));
    var statusText = store && store.status ? String(store.status) : 'found';
    var status = el('div', 'block-status' + (statusText === 'confirmed' || statusText === 'settled' ? ' confirmed' : ''), statusText);
    right.appendChild(status);
    row.appendChild(right);
    list.appendChild(row);
  });
  if (maxHeight != null) document.getElementById('height-chip').textContent = '⛓ #' + formatCount(maxHeight);
}

/* ---------------- rendering: fairness ---------------- */

function fairStat(value, label) {
  var box = el('div', 'fair-stat');
  box.appendChild(el('div', 'v', value));
  box.appendChild(el('div', 'k', label));
  return box;
}

function renderReconcile(rec) {
  var verdict = document.getElementById('reconcile-verdict');
  var statsBox = document.getElementById('fairness-stats');
  var eq = document.getElementById('reconcile-equation');
  statsBox.textContent = '';
  eq.textContent = '';
  if (!rec || typeof rec !== 'object') {
    verdict.textContent = 'unavailable';
    verdict.className = 'verdict';
    return;
  }
  var agg = rec.aggregate || {};
  var errors = (rec.discrepancies || []).filter(function (d) { return d && d.severity === 'error'; }).length;
  if (rec.balanced && errors === 0) {
    verdict.textContent = '✓ Books balanced';
    verdict.className = 'verdict ok';
  } else {
    verdict.textContent = '⚠ ' + errors + ' discrepancies';
    verdict.className = 'verdict bad';
  }
  statsBox.appendChild(fairStat(formatCount(rec.settledBlocks), 'settled blocks'));
  statsBox.appendChild(fairStat(formatItcFromSat(agg.rewardInSat), 'rewards in'));
  statsBox.appendChild(fairStat(formatItcFromSat(agg.payoutsSat), 'paid out'));
  statsBox.appendChild(fairStat(formatItcFromSat(agg.feeSat), 'pool fees'));
  if (agg.equation) {
    eq.appendChild(document.createTextNode(agg.equation + '  '));
    var holds = agg.holds === true;
    eq.appendChild(el('span', holds ? 'holds' : 'fails', holds ? '· HOLDS' : '· FAILS'));
  }
}

function breakdownAmount(m) {
  var v = asNumber(m.amountSat != null ? m.amountSat : (m.splitSat != null ? m.splitSat : (m.creditedSat != null ? m.creditedSat : m.paidSat)));
  return v;
}

function renderBreakdownDetail(container, payload, height) {
  container.textContent = '';
  if (!payload || typeof payload !== 'object') {
    container.appendChild(el('div', 'empty', 'No breakdown available for block ' + height + '.'));
    return;
  }
  var miners = Array.isArray(payload.miners) ? payload.miners : [];
  var summary = el('div', 'block-meta');
  var reward = payload.rewardItc != null ? Number(payload.rewardItc).toFixed(4) + ' ITC reward' :
    (payload.rewardSat != null ? formatItcFromSat(payload.rewardSat) + ' reward' :
    (payload.reward != null ? formatItcFromSat(payload.reward) + ' reward' : ''));
  var fee = payload.feeItc != null ? Number(payload.feeItc).toFixed(4) + ' ITC fee' :
    (payload.feeSat != null ? formatItcFromSat(payload.feeSat) + ' fee' : '');
  summary.textContent = [reward, fee, miners.length + ' miners'].filter(Boolean).join(' · ');
  container.appendChild(summary);
  if (payload.recomputedMatches != null) {
    var m = el('div', 'block-meta', payload.recomputedMatches
      ? '✓ Recorded split matches an independent recomputation from the share ledger.'
      : '⚠ Recorded split does NOT match a recomputation from the share ledger.');
    m.style.marginTop = '4px';
    container.appendChild(m);
  }
  if (miners.length) {
    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    ['Miner', 'Amount', 'Credited', 'Paid', 'Carry'].forEach(function (label, i) {
      htr.appendChild(el('th', i > 0 ? 'num' : null, label));
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    miners.forEach(function (miner) {
      var tr = document.createElement('tr');
      var addr = el('td', 'worker-name', String(miner.address || miner.worker || '—'));
      addr.title = String(miner.address || '');
      tr.appendChild(addr);
      var amt = breakdownAmount(miner);
      tr.appendChild(el('td', 'num', amt != null ? formatItcFromSat(amt) : '—'));
      tr.appendChild(el('td', 'num', miner.creditedSat != null ? formatItcFromSat(miner.creditedSat) : '—'));
      tr.appendChild(el('td', 'num', miner.paidSat != null ? formatItcFromSat(miner.paidSat) : '—'));
      tr.appendChild(el('td', 'num', miner.carrySat != null ? formatItcFromSat(miner.carrySat) : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }
  var ledgerLink = document.createElement('a');
  ledgerLink.href = '/api/blocks/' + encodeURIComponent(height) + '/ledger';
  ledgerLink.textContent = 'Raw share ledger for this block →';
  ledgerLink.style.fontSize = '12.5px';
  var linkWrap = el('div');
  linkWrap.style.marginTop = '10px';
  linkWrap.appendChild(ledgerLink);
  container.appendChild(linkWrap);
}

function renderBreakdowns(list) {
  var box = document.getElementById('breakdown-list');
  box.textContent = '';
  var items = Array.isArray(list) ? list.slice(0, 25) : [];
  document.getElementById('breakdown-empty').classList.toggle('hidden', items.length > 0);
  items.forEach(function (b) {
    var algo = normalizeAlgo(b.algo);
    var height = b.height;
    var wrap = el('div', 'breakdown-row');
    var head = el('button', 'breakdown-head');
    head.type = 'button';
    head.appendChild(el('span', 'h mono', height != null ? '#' + formatCount(height) : '—'));
    if (algo) {
      var chipWrap = document.createElement('span');
      chipWrap.appendChild(el('span', 'algo-chip ' + algo));
      chipWrap.appendChild(document.createTextNode(ALGO_META[algo].label));
      head.appendChild(chipWrap);
    }
    var mid = el('span', 'grow block-meta');
    var rewardTxt = b.rewardItc != null ? Number(b.rewardItc).toFixed(4) + ' ITC' :
      (b.rewardSat != null ? formatItcFromSat(b.rewardSat) : (b.reward != null ? formatItcFromSat(b.reward) : ''));
    var minersTxt = b.minersPaid != null ? b.minersPaid + ' miners' :
      (Array.isArray(b.miners) ? b.miners.length + ' miners' : (b.miners != null ? b.miners + ' miners' : ''));
    mid.textContent = [rewardTxt, minersTxt, b.scheme ? String(b.scheme) : '', b.time ? formatRelativeTime(b.time) : ''].filter(Boolean).join(' · ');
    head.appendChild(mid);
    if (b.recomputedMatches != null) {
      head.appendChild(el('span', 'match ' + (b.recomputedMatches ? 'yes' : 'no'),
        b.recomputedMatches ? '✓ RECOMPUTED MATCH' : '⚠ MISMATCH'));
    }
    head.appendChild(el('span', 'panel-note', state.openBreakdowns[String(height)] ? 'hide' : 'view split'));
    var body = el('div', 'breakdown-body hidden');
    head.addEventListener('click', function () {
      var key = String(height);
      if (state.openBreakdowns[key]) {
        state.openBreakdowns[key] = false;
        body.classList.add('hidden');
        head.querySelector('.panel-note').textContent = 'view split';
        return;
      }
      state.openBreakdowns[key] = true;
      body.classList.remove('hidden');
      head.querySelector('.panel-note').textContent = 'hide';
      body.textContent = '';
      body.appendChild(el('div', 'empty', 'Recomputing the split from the raw ledger…'));
      fetchJson('/api/blocks/' + encodeURIComponent(height) + '/breakdown')
        .then(function (payload) { renderBreakdownDetail(body, payload, height); })
        .catch(function () { body.textContent = ''; body.appendChild(el('div', 'empty', 'Breakdown unavailable for this block.')); });
    });
    wrap.appendChild(head);
    wrap.appendChild(body);
    box.appendChild(wrap);
    if (state.openBreakdowns[String(height)]) {
      state.openBreakdowns[String(height)] = false;
      head.click();
    }
  });
}

/* ---------------- rendering: payouts ---------------- */

function renderPayouts(payload) {
  var list = document.getElementById('payouts-list');
  list.textContent = '';
  var payouts = payload && Array.isArray(payload.payouts) ? payload.payouts : [];
  document.getElementById('payouts-empty').classList.toggle('hidden', payouts.length > 0);
  var pool = (payload && payload.pool) || state.payments || {};
  var noteParts = [];
  if (pool.feePercent != null) noteParts.push('fee ' + pool.feePercent + '%');
  if (pool.minPayoutItc != null) noteParts.push('min payout ' + pool.minPayoutItc + ' ITC');
  if (pool.confirmations != null) noteParts.push(pool.confirmations + ' confirmations');
  document.getElementById('payouts-note').textContent = noteParts.join(' · ');
  payouts.slice(0, 25).forEach(function (p) {
    var row = el('div', 'payout-row');
    var left = document.createElement('div');
    if (p.dryRun) left.appendChild(el('span', 'badge dry', 'dry run'));
    else left.appendChild(el('span', 'badge live-pay', 'live'));
    var algo = normalizeAlgo(p.algo);
    if (algo) {
      var chipWrap = document.createElement('span');
      chipWrap.style.marginLeft = '8px';
      chipWrap.appendChild(el('span', 'algo-chip ' + algo));
      chipWrap.appendChild(document.createTextNode(ALGO_META[algo].label));
      left.appendChild(chipWrap);
    }
    row.appendChild(left);
    var mid = document.createElement('div');
    mid.appendChild(el('div', 'payout-total', p.totalItc != null ? Number(p.totalItc).toFixed(4) + ' ITC' : '—'));
    var blocksTxt = Array.isArray(p.blocks) && p.blocks.length ? 'blocks ' + p.blocks.map(function (h) { return '#' + h; }).join(', ') : '';
    mid.appendChild(el('div', 'payout-meta', [blocksTxt, formatDateTime(p.time)].filter(Boolean).join(' · ')));
    row.appendChild(mid);
    var right = el('div', 'payout-right');
    right.appendChild(document.createTextNode((p.minersPaid != null ? p.minersPaid : 0) + ' miners paid'));
    if (p.feeItc) {
      right.appendChild(document.createElement('br'));
      right.appendChild(document.createTextNode('fee ' + Number(p.feeItc).toFixed(4) + ' ITC'));
    }
    if (p.txid) {
      right.appendChild(document.createElement('br'));
      var tx = el('span', 'mono', truncateHash(p.txid));
      tx.style.fontSize = '11px';
      right.appendChild(tx);
    }
    row.appendChild(right);
    list.appendChild(row);
  });
}

/* ---------------- miner lookup ---------------- */

function renderMiner(payload) {
  var box = document.getElementById('miner-result');
  box.textContent = '';
  var card = el('div', 'miner-card');
  card.appendChild(el('div', 'miner-addr', String(payload.address || '')));
  var totals = payload.totals || {};
  var grid = el('div', 'miner-grid');
  grid.appendChild(fairStat(formatHashrate(totals.hashrateEstimate), 'hashrate (10m)'));
  grid.appendChild(fairStat(formatCount(totals.shares), 'shares'));
  grid.appendChild(fairStat(totals.pendingItc != null ? Number(totals.pendingItc).toFixed(4) + ' ITC' : '—', 'pending'));
  grid.appendChild(fairStat(totals.paidItc != null ? Number(totals.paidItc).toFixed(4) + ' ITC' : '—', 'paid'));
  card.appendChild(grid);
  var algos = payload.algos || {};
  ALGOS.forEach(function (a) {
    var e = algos[a];
    if (!e) return;
    var row = el('div', 'algo-row');
    var k = el('span', 'k');
    k.appendChild(el('span', 'algo-chip ' + a));
    k.appendChild(document.createTextNode(ALGO_META[a].label));
    row.appendChild(k);
    row.appendChild(el('span', 'v', formatHashrate(e.hashrateEstimate) + ' · ' + formatCount(e.shares) + ' shares · last ' + formatRelativeTime(e.lastShareAt)));
    card.appendChild(row);
  });
  box.appendChild(card);
}

function lookupMiner(address) {
  var box = document.getElementById('miner-result');
  box.textContent = '';
  box.appendChild(el('div', 'empty', 'Looking up ' + address + '…'));
  fetchJson('/api/miner/' + encodeURIComponent(address))
    .then(renderMiner)
    .catch(function () {
      box.textContent = '';
      box.appendChild(el('div', 'lookup-error', 'No shares or balances found for that address yet. Solo miners are paid by the coinbase directly and may not appear here.'));
    });
}

/* ---------------- config ---------------- */

function renderConfig(cfg) {
  if (!cfg) return;
  if (cfg.stratumPorts) {
    ALGOS.forEach(function (a) {
      var p = asNumber(cfg.stratumPorts[a]);
      if (p) state.ports[a] = p;
    });
  }
  if (cfg.algos) {
    ALGOS.forEach(function (a) {
      if (cfg.algos[a] && cfg.algos[a].scheme) state.schemes[a] = String(cfg.algos[a].scheme).toLowerCase();
    });
  }
  if (cfg.payments) state.payments = cfg.payments;
  if (cfg.poolAddress) state.poolAddress = cfg.poolAddress;
  if (cfg.stratumHost) state.stratumHost = cfg.stratumHost;
  applyMode();
  var dry = state.mode === 'group' && state.payments && state.payments.dryRun;
  document.getElementById('dryrun-banner').classList.toggle('hidden', !dry);
}

/* One page, one direction: the pool runs SOLO or it runs a group
   scheme (PROP / PPLNS) — decided by the operator's env
   (ITC_<ALGO>_SCHEME), never both at once. Any group lane makes the
   page a group page (fairness + payouts); all-solo makes it a solo
   page (coinbase pays the finder, nothing to split). */
function applyMode() {
  var group = ALGOS.some(function (a) {
    var s = state.schemes[a];
    return s && s !== 'solo';
  });
  var mode = group ? 'group' : 'solo';
  if (state.mode === mode) return;
  state.mode = mode;
  document.body.classList.toggle('mode-group', group);
  document.body.classList.toggle('mode-solo', !group);
  var sub = document.getElementById('hero-sub');
  if (sub) sub.textContent = group
    ? 'Group mining — PROP / PPLNS splits, published and recomputable to the satoshi.'
    : 'Solo mining — every block pays its finder directly, in full. No splits, no fees.';
  document.dispatchEvent(new CustomEvent('poolmode', { detail: { mode: mode } }));
}

/* ---------------- refresh ---------------- */

/* ---------------- network vitals (daemon, via /api/network) -------- */
function fmtDiff(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (v >= 100) return v.toFixed(1);
  if (v >= 1) return v.toFixed(3);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}
function gid(id) { return document.getElementById(id); }
function renderNetwork(net) {
  var statusEl = gid('net-status');
  var heroNet = gid('hero-net');
  if (!net || !net.available) {
    gid('net-height').textContent = '—';
    gid('net-total-hr').textContent = '—';
    gid('net-peers').textContent = '—';
    gid('net-rows').textContent = '';
    if (statusEl) statusEl.textContent = 'NETWORK: UNAVAILABLE (STANDALONE API)';
    if (heroNet) heroNet.textContent = '';
    return;
  }
  gid('net-height').textContent = Number(net.height).toLocaleString('en-US');
  gid('net-total-hr').textContent = formatHashrate(net.networkHashrate ? net.networkHashrate.total : null);
  gid('net-peers').textContent = net.peers != null ? String(net.peers) : '—';
  var rows = gid('net-rows');
  rows.textContent = '';
  ALGOS.forEach(function (algo) {
    var meta = ALGO_META[algo];
    var row = document.createElement('div');
    row.className = 'net-row';
    row.style.borderLeftColor = meta.color;
    var name = document.createElement('span');
    name.className = 'net-row-name';
    name.style.color = meta.color;
    name.textContent = meta.label.toUpperCase();
    var diff = document.createElement('span');
    diff.className = 'net-row-val';
    diff.textContent = 'difficulty ' + fmtDiff(net.difficulty ? net.difficulty[algo] : null);
    var hr = document.createElement('span');
    hr.className = 'net-row-val';
    hr.textContent = 'network ' + formatHashrate(net.networkHashrate ? net.networkHashrate[algo] : null);
    row.appendChild(name);
    row.appendChild(diff);
    row.appendChild(hr);
    rows.appendChild(row);
  });
  if (statusEl) {
    statusEl.textContent = 'NETWORK: LIVE · UPDATED ' + (net.updatedAt ? new Date(net.updatedAt).toLocaleTimeString('en-US', { hour12: false }) : '—');
  }
  if (heroNet) {
    heroNet.textContent = '🌐 NETWORK ' + formatHashrate(net.networkHashrate ? net.networkHashrate.total : null) +
      ' · HEIGHT ' + Number(net.height).toLocaleString('en-US') +
      (net.peers != null ? ' · ' + net.peers + ' PEERS' : '');
  }
}

function refresh() {
  var jobs = [
    fetchJson('/health').then(function () { setApiStatus(true, 'live'); }).catch(function () { setApiStatus(false, 'api offline'); }),
    fetchJson('/api/stats').then(renderStats).catch(function () {}),
    fetchJson('/api/config').then(renderConfig).catch(function () {}),
    fetchJson('/api/workers').then(renderWorkers).catch(function () {}),
    fetchJson('/api/payouts').then(renderPayouts).catch(function () {}),
    fetchJson('/api/network').then(renderNetwork).catch(function () { renderNetwork(null); }),
    fetchJson('/api/reconcile').then(renderReconcile).catch(function () { renderReconcile(null); })
  ];
  var blocksPromise = fetchJson('/api/blocks?limit=30').catch(function () { return []; });
  var storePromise = fetchJson('/api/blocks?limit=30&source=store').catch(function () { return []; });
  jobs.push(Promise.all([blocksPromise, storePromise]).then(function (r) { renderBlocks(r[0], r[1]); }));
  jobs.push(fetchJson('/api/breakdowns').then(renderBreakdowns).catch(function () {}));
  return Promise.all(jobs);
}

function init() {
  document.getElementById('lookup-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = document.getElementById('lookup-input').value.trim();
    if (value) lookupMiner(value);
  });
  var params = new URLSearchParams(window.location.search);
  var prefill = params.get('miner');
  if (prefill) {
    document.getElementById('lookup-input').value = prefill;
    lookupMiner(prefill);
  }
  seedHistory();
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(updateUptime, 1000);
  window.addEventListener('resize', drawCharts);
}

document.addEventListener('DOMContentLoaded', init);
