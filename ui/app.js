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
  var listEl = document.getElementById('blocks-list');
  var empty = document.getElementById('blocks-empty');
  if (!listEl) return;
  var list = Array.isArray(blocks) ? blocks : [];

  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
  if (empty) empty.hidden = list.length > 0;

  list.forEach(function (b) {
    var item = (b && typeof b === 'object') ? b : {};
    var row = el('li', 'block-row');
    row.appendChild(el('span', 'block-height', item.height !== null && item.height !== undefined ? '#' + formatCount(item.height) : '—'));
    row.appendChild(badgeFor(item.algo));
    var hashSpan = el('span', 'block-hash mono', truncateHash(item.hash));
    if (item.hash) hashSpan.title = String(item.hash);
    row.appendChild(hashSpan);
    var timeSpan = el('span', 'block-time', formatRelativeTime(item.time));
    timeSpan.title = formatDateTime(item.time);
    row.appendChild(timeSpan);
    listEl.appendChild(row);
  });
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
  if (!config || typeof config !== 'object' || !Array.isArray(config.algos)) {
    renderConnection();
    return;
  }
  config.algos.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    var name = normalizeAlgo(entry.name);
    if (ALGOS.indexOf(name) !== -1 && entry.port) {
      state.ports[name] = asNumber(entry.port) || state.ports[name];
    }
  });
  renderConnection();
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
    fetchJson('/api/config')
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

  renderConnection();
  refresh();
  setInterval(refresh, REFRESH_MS);
  setInterval(updateUptime, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
