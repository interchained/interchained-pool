'use strict';
/*
 * scripts/test-network-render.js — regression test for the NETWORK.EXE
 * panel render path (ui/app.js renderNetwork).
 *
 * The bug this guards: renderNetwork called fmtHashrate(), a function
 * that does not exist (the helper is formatHashrate). Every refresh
 * threw a ReferenceError mid-render; the fetch chain's .catch then
 * re-rendered with null, so the panel permanently showed
 * "NETWORK: UNAVAILABLE (STANDALONE API)" while /api/network was
 * healthy. Server-side tests could not see it — the API was fine;
 * only executing the real app.js against a live-shaped payload shows it.
 *
 * Executes ui/app.js in a vm with a stub DOM, routes fetch() for
 * /api/network to a payload shaped exactly like the daemon-backed
 * snapshot, fires init(), and asserts the panel renders LIVE values.
 * Also asserts the genuinely-unavailable path still renders UNAVAILABLE.
 * Run: node scripts/test-network-render.js
 */
var fs = require('fs');
var vm = require('vm');

var src = fs.readFileSync(require('path').join(__dirname, '..', 'ui', 'app.js'), 'utf8');
var failures = 0;
function check(name, cond, extra) { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); if (!cond) failures++; }

var LIVE_NETWORK = {
  available: true, height: 914641, peers: 7,
  difficulty: { sha256: 120711.1231028668, yespower: 0.0003864453635660998, ethash: 0.06498541831729067 },
  networkHashrate: { total: 391928.9102658621, sha256: 0, yespower: 15146.03336616597, ethash: 376782.8768996961 },
  updatedAt: 1794238193785
};

function makeEl(tag) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
    className: '', _text: '', clientWidth: 0, clientHeight: 0, width: 0, height: 0, value: '',
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function (c) { el.children.push(c); return c; },
    addEventListener: function () {}, removeEventListener: function () {},
    querySelector: function () { return makeEl('span'); }, querySelectorAll: function () { return []; },
    getContext: function () { return new Proxy({}, { get: function () { return function () {}; } }); }
  };
  Object.defineProperty(el, 'textContent', {
    get: function () { return el._text + el.children.map(function (c) { return c && c.textContent ? c.textContent : ''; }).join(''); },
    set: function (v) { el._text = String(v); el.children = []; }
  });
  return el;
}

var byId = {};
var docHandlers = {};
var documentStub = {
  getElementById: function (id) { if (!byId[id]) byId[id] = makeEl('div'); return byId[id]; },
  createElement: function (tag) { return makeEl(tag); },
  createTextNode: function (t) { return { textContent: String(t), data: String(t) }; },
  querySelector: function () { return makeEl('div'); },
  querySelectorAll: function () { return []; },
  addEventListener: function (ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn); },
  dispatchEvent: function () { return true; }
};

function fetchStub(url) {
  var data;
  if (url.indexOf('/api/network') === 0) data = LIVE_NETWORK;
  else if (url.indexOf('/api/history') === 0) data = { available: true, samples: [] };
  else if (url.indexOf('/api/stats') === 0) data = { algos: {} };
  else if (url.indexOf('/api/config') === 0) data = { schemes: { sha256: 'solo', yespower: 'solo', ethash: 'solo' }, payments: { enabled: false }, stratumHost: 'stratum.interchained.org' };
  else if (url.indexOf('/api/workers') === 0) data = [];
  else if (url.indexOf('/api/blocks') === 0) data = [];
  else if (url.indexOf('/api/breakdowns') === 0) data = [];
  else if (url.indexOf('/api/reconcile') === 0) data = { balanced: true, aggregate: {}, perBlock: [], settledBlocks: 0 };
  else data = {};
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
}

var sandbox = {
  document: documentStub,
  fetch: fetchStub,
  CustomEvent: function (name, opts) { this.type = name; this.detail = opts && opts.detail; },
  setInterval: function () { return 1; },
  setTimeout: setTimeout,
  clearInterval: function () {},
  URLSearchParams: URLSearchParams,
  navigator: {},
  location: { search: '', hostname: 'mine.interchained.org' },
  addEventListener: function () {},
  console: console
};
sandbox.window = sandbox;
sandbox.window.location = sandbox.location;
vm.createContext(sandbox);

var errors = [];
process.on('unhandledRejection', function (e) { errors.push('unhandledRejection: ' + (e && e.message)); });

function runOnce(networkPayload) {
  byId = {}; docHandlers = {};
  var sb = Object.assign({}, sandbox);
  sb.fetch = function (url) {
    var data;
    if (url.indexOf('/api/network') === 0) data = networkPayload;
    else if (url.indexOf('/api/history') === 0) data = { available: true, samples: [] };
    else if (url.indexOf('/api/stats') === 0) data = { algos: {} };
    else if (url.indexOf('/api/config') === 0) data = { schemes: { sha256: 'solo', yespower: 'solo', ethash: 'solo' }, payments: { enabled: false }, stratumHost: 'stratum.interchained.org' };
    else if (url.indexOf('/api/workers') === 0) data = [];
    else if (url.indexOf('/api/blocks') === 0) data = [];
    else if (url.indexOf('/api/breakdowns') === 0) data = [];
    else if (url.indexOf('/api/reconcile') === 0) data = { balanced: true, aggregate: {}, perBlock: [], settledBlocks: 0 };
    else data = {};
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
  };
  sb.document = documentStub;
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'ui/app.js' });
  (docHandlers['DOMContentLoaded'] || []).forEach(function (fn) { fn(); });
  return new Promise(function (resolve) { setTimeout(resolve, 300); });
}

(async function () {
  await runOnce(LIVE_NETWORK);
  check('panel reports LIVE with a healthy payload', (byId['net-status'] || {}).textContent.indexOf('NETWORK: LIVE') === 0, (byId['net-status'] || {}).textContent);
  check('height rendered', (byId['net-height'] || {}).textContent === '914,641', (byId['net-height'] || {}).textContent);
  check('total hashrate rendered', (byId['net-total-hr'] || {}).textContent === '392 kH/s', (byId['net-total-hr'] || {}).textContent);
  check('three lane rows rendered', byId['net-rows'] && byId['net-rows'].children.length === 3, byId['net-rows'] && byId['net-rows'].children.length);
  var rowsText = byId['net-rows'] ? byId['net-rows'].textContent : '';
  check('lane rows carry difficulty + hashrate', rowsText.indexOf('YESPOWER') !== -1 && rowsText.indexOf('difficulty') !== -1 && rowsText.indexOf('network') !== -1, rowsText.slice(0, 80));

  await runOnce({ available: false });
  check('unavailable payload still renders UNAVAILABLE', (byId['net-status'] || {}).textContent.indexOf('NETWORK: UNAVAILABLE') === 0, (byId['net-status'] || {}).textContent);

  if (errors.length) check('no unhandled rejections during render', false, errors.join(' | '));
  console.log(failures === 0 ? 'ALL NETWORK RENDER CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
