'use strict';
/**
 * scripts/test-dashboard.js — headless verification of the pool dashboard
 * (phase-3 gap d: previously only "the server serves it" was checked).
 * Run:  node scripts/test-dashboard.js
 *
 * What it does:
 *   1. Starts api/server.js (in-process createServer) on an ephemeral
 *      port with a StatsCollector seeded with KNOWN stats (shares,
 *      workers, a block), a seeded payouts store file, and a pool
 *      config (schemes + payments summary).
 *   2. Fetches the dashboard page over HTTP exactly as the server
 *      serves it (GET / -> ui/index.html).
 *   3. Executes ui/app.js against that page with a fetch() that talks
 *      to the REAL server, then asserts the phase-2 panels populate
 *      from the live API data: algo cards (hashrate / workers / share
 *      counts / scheme badge / last block), workers table, blocks
 *      table (incl. distribution status from the payouts store),
 *      payouts summary + batch table, connection panel, API status —
 *      i.e. the DOM ends up containing the SEEDED values, not the
 *      static placeholders baked into index.html.
 *   Selectors are phase-2 panels only (data-algo-card / data-field,
 *   workers-body, blocks-body, payouts-*) — no dependency on other
 *   lanes' fairness-panel work.
 *
 * RENDERING ENGINE: jsdom could NOT be installed in this environment
 * (`npm install jsdom` fails with EPERM lchown in npm's reify step —
 * tried with the default and a scratch cache), so this file carries
 * the smallest DOM/window/fetch shim that lets ui/app.js execute for
 * real: an HTML parser for the served page, createElement /
 * appendChild / textContent / classList / querySelector('[attr="v"]')
 * / getElementById, and event-listener registration (handlers are
 * stored, never fired — rendering paths only). Everything app.js
 * renders goes through the shim; every byte it renders with comes
 * from the live HTTP API. If jsdom becomes installable, swapping the
 * shim for JSDOM is a local change to this file only.
 */

var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var createServer = require('../api/server').createServer;
var StatsCollector = require('../api/server').StatsCollector;

var failures = 0;
function check(name, cond, extra) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) failures++;
}

/* ================= minimal DOM shim ================= */
var VOID_TAGS = { meta: 1, link: 1, input: 1, br: 1, hr: 1, img: 1, source: 1, col: 1 };
var ENTITIES = { times: '×', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
function decodeEntities(s) {
    return s.replace(/&([\w#]+);/g, function (m, e) { return ENTITIES[e] !== undefined ? ENTITIES[e] : m; });
}
function TextNode(text) { this.nodeType = 3; this.data = text; this.parentNode = null; }
function El(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this.title = '';
    this.value = '';
    this.style = {};
    this._listeners = {};
}
Object.defineProperty(El.prototype, 'firstChild', { get: function () { return this.childNodes[0] || null; } });
Object.defineProperty(El.prototype, 'textContent', {
    get: function () {
        var out = '';
        (function walk(n) {
            for (var i = 0; i < n.childNodes.length; i++) {
                var c = n.childNodes[i];
                if (c.nodeType === 3) out += c.data; else walk(c);
            }
        })(this);
        return out;
    },
    set: function (v) {
        this.childNodes = [];
        if (v !== '' && v !== null && v !== undefined) {
            var t = new TextNode(String(v)); t.parentNode = this; this.childNodes.push(t);
        }
    }
});
Object.defineProperty(El.prototype, 'classList', {
    get: function () {
        var self = this;
        function parts() { return self.className ? self.className.split(/\s+/).filter(Boolean) : []; }
        return {
            add: function (c) { var p = parts(); if (p.indexOf(c) === -1) { p.push(c); self.className = p.join(' '); } },
            remove: function (c) { self.className = parts().filter(function (x) { return x !== c; }).join(' '); },
            contains: function (c) { return parts().indexOf(c) !== -1; }
        };
    }
});
El.prototype.appendChild = function (child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this; this.childNodes.push(child); return child;
};
El.prototype.removeChild = function (child) {
    var i = this.childNodes.indexOf(child);
    if (i !== -1) { this.childNodes.splice(i, 1); child.parentNode = null; }
    return child;
};
El.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
};
El.prototype.getAttribute = function (name) {
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
};
El.prototype.addEventListener = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
};
El.prototype.querySelector = function (selector) {
    var m = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (!m) throw new Error('shim querySelector supports only [attr="value"], got: ' + selector);
    var found = null;
    (function walk(n) {
        for (var i = 0; i < n.childNodes.length && !found; i++) {
            var c = n.childNodes[i];
            if (c.nodeType !== 1) continue;
            if (c.attributes[m[1]] === m[2]) { found = c; return; }
            walk(c);
        }
    })(this);
    return found;
};

function parseHtml(html) {
    var root = new El('#document');
    var stack = [root];
    var tokenRe = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/[a-zA-Z][^>]*>|<[a-zA-Z][^>]*>|[^<]+/g;
    var match;
    while ((match = tokenRe.exec(html)) !== null) {
        var tok = match[0];
        if (tok.charAt(0) !== '<') {
            var text = decodeEntities(tok);
            if (text) { var tn = new TextNode(text); tn.parentNode = stack[stack.length - 1]; stack[stack.length - 1].childNodes.push(tn); }
            continue;
        }
        if (tok.indexOf('<!--') === 0 || /^<!DOCTYPE/i.test(tok)) continue;
        if (tok.charAt(1) === '/') {
            var closeTag = tok.slice(2, -1).trim().toUpperCase();
            for (var i = stack.length - 1; i > 0; i--) {
                if (stack[i].tagName === closeTag) { stack.length = i; break; }
            }
            continue;
        }
        var inner = tok.slice(1, -1);
        var selfClose = /\/$/.test(inner);
        if (selfClose) inner = inner.slice(0, -1);
        var sp = inner.search(/\s/);
        var tag = (sp === -1 ? inner : inner.slice(0, sp)).toLowerCase();
        var el = new El(tag);
        if (sp !== -1) {
            var attrRe = /([\w-]+)(?:="([^"]*)")?/g, am;
            var attrText = inner.slice(sp);
            while ((am = attrRe.exec(attrText)) !== null) {
                el.attributes[am[1]] = am[2] !== undefined ? decodeEntities(am[2]) : '';
                if (am[1] === 'class') el.className = el.attributes[am[1]];
                if (am[1] === 'id') el.id = el.attributes[am[1]];
                if (am[1] === 'hidden') el.hidden = true;
            }
        }
        var parent = stack[stack.length - 1];
        el.parentNode = parent; parent.childNodes.push(el);
        if (!selfClose && !VOID_TAGS[tag]) stack.push(el);
    }
    return root;
}

function makeDocument(html) {
    var root = parseHtml(html);
    var doc = {
        readyState: 'complete',
        documentElement: null,
        body: null,
        _root: root,
        createElement: function (tag) { return new El(tag); },
        createTextNode: function (t) { return new TextNode(t); },
        getElementById: function (id) {
            var found = null;
            (function walk(n) {
                for (var i = 0; i < n.childNodes.length && !found; i++) {
                    var c = n.childNodes[i];
                    if (c.nodeType !== 1) continue;
                    if (c.id === id) { found = c; return; }
                    walk(c);
                }
            })(root);
            return found;
        },
        querySelector: function (sel) { return root.querySelector(sel); },
        addEventListener: function () {},
        execCommand: function () { return false; }
    };
    (function find(n) {
        for (var i = 0; i < n.childNodes.length; i++) {
            var c = n.childNodes[i];
            if (c.nodeType !== 1) continue;
            if (c.tagName === 'HTML') doc.documentElement = c;
            if (c.tagName === 'BODY') doc.body = c;
            find(c);
        }
    })(root);
    return doc;
}

/* ================= helpers ================= */
function httpGet(port, p) {
    return new Promise(function (resolve, reject) {
        http.get({ host: '127.0.0.1', port: port, path: p }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
            });
        }).on('error', reject);
    });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// Same formatting rule as ui/app.js formatHashrate, applied to the live
// /api/stats payload the test reads itself — the DOM must match THIS.
function formatHashrate(value) {
    var units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    var n = Number(value) || 0, idx = 0;
    while (n >= 1000 && idx < units.length - 1) { n = n / 1000; idx += 1; }
    var text = idx === 0 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, '');
    return text + ' ' + units[idx];
}

/* ================= main ================= */
async function main() {
    var BLOCK_HASH = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itc-dash-'));
    var payoutsFile = path.join(dir, 'payouts.json');
    fs.writeFileSync(payoutsFile, JSON.stringify({
        version: 1,
        shares: [],
        blocks: [{ algo: 'ethash', height: 913982, hash: BLOCK_HASH, reward: 500000000,
                   finder: 'addrDashWorker1', time: Math.floor(Date.now() / 1000),
                   scheme: 'solo', status: 'confirmed', confirmations: 10, payoutId: null }],
        balances: {},
        payouts: [{ id: 'dashbatch1', algo: 'sha256', time: Math.floor(Date.now() / 1000),
                    dryRun: true, txid: null, amounts: { addrDashWorker1: 100000000 },
                    blocks: [913982], fee: 2000000, psbt: 'cHNidA==', stage: 'created' }]
    }, null, 2));

    var collector = new StatsCollector({ dataFile: null });
    collector.recordShare('sha256', 'addrDashWorker1', { valid: true, difficulty: 100 });
    collector.recordShare('sha256', 'addrDashWorker1', { valid: true, difficulty: 100 });
    collector.recordShare('sha256', 'addrDashWorker1', { valid: true, difficulty: 100 });
    collector.recordShare('sha256', 'addrDashWorker1', { valid: false, difficulty: 100 });
    collector.recordShare('yespower', 'addrDashCpu', { valid: true, difficulty: 5 });
    collector.recordBlock('ethash', { height: 913982, hash: BLOCK_HASH, time: Date.now() });

    var poolConfig = {
        address: 'addrPool',
        algos: {
            sha256: { stratumPort: 3333, scheme: 'prop' },
            yespower: { stratumPort: 3334, scheme: 'pplns', pplnsWindow: 3 },
            ethash: { stratumPort: 3335, scheme: 'solo' }
        },
        payments: { feePercent: 2, minPayout: 0.5, dryRun: true, confirmations: 5 }
    };

    var server = createServer({ collector: collector, payoutsFile: payoutsFile, poolConfig: poolConfig });
    await new Promise(function (res) { server.listen(0, '127.0.0.1', res); });
    var port = server.address().port;
    console.log('dashboard test server on 127.0.0.1:' + port);

    /* 1. page served as-is */
    var page = await httpGet(port, '/');
    check('server serves the real dashboard page (200, algo cards present)',
        page.status === 200 && page.body.indexOf('data-algo-card="ethash"') !== -1 &&
        page.body.indexOf('id="workers-body"') !== -1);
    var appJs = await httpGet(port, '/app.js');
    check('server serves ui/app.js', appJs.status === 200 && appJs.body.indexOf('renderStats') !== -1);

    /* live API payloads, read independently for expected values */
    var stats = JSON.parse((await httpGet(port, '/api/stats')).body);

    /* 2. execute app.js against the served page with live fetch */
    var document = makeDocument(page.body);
    var fetchShim = function (p) {
        return httpGet(port, p).then(function (r) {
            return {
                ok: r.status >= 200 && r.status < 300, status: r.status,
                json: function () { return Promise.resolve(JSON.parse(r.body)); }
            };
        });
    };
    var sandbox = {
        document: document,
        window: { location: { hostname: '127.0.0.1' } },
        navigator: {},
        fetch: fetchShim,
        setInterval: function () { return 0; },
        clearInterval: function () {},
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        console: console, Promise: Promise
    };
    sandbox.window.document = document;
    vm.createContext(sandbox);
    vm.runInContext(appJs.body, sandbox, { filename: 'ui/app.js' });

    /* wait for the async refresh() cycle to populate the DOM */
    var shaCard = null, populated = false;
    for (var attempt = 0; attempt < 100 && !populated; attempt++) {
        shaCard = document.querySelector('[data-algo-card="sha256"]');
        var wb = document.getElementById('workers-body');
        populated = !!shaCard &&
            shaCard.querySelector('[data-field="shares-accepted"]').textContent === '3' &&
            !!wb && wb.textContent.indexOf('addrDashWorker1') !== -1;
        if (!populated) await sleep(50);
    }
    check('app.js refresh cycle populated the DOM from the live API', populated);

    function fieldText(card, name) {
        var f = card && card.querySelector('[data-field="' + name + '"]');
        return f ? f.textContent : null;
    }

    /* algo cards */
    check('sha256 card: hashrate shows seeded value, not the 0 H/s placeholder',
        fieldText(shaCard, 'hashrate') === formatHashrate(stats.algos.sha256.hashrate) &&
        fieldText(shaCard, 'hashrate') !== '0 H/s', fieldText(shaCard, 'hashrate'));
    check('sha256 card: workers = 1, accepted = 3, rejected = 1',
        fieldText(shaCard, 'workers') === '1' && fieldText(shaCard, 'shares-accepted') === '3' &&
        fieldText(shaCard, 'shares-rejected') === '1');
    check('sha256 card: scheme badge shows PROP from /api/config',
        fieldText(shaCard, 'scheme') === 'PROP', fieldText(shaCard, 'scheme'));
    var yesCard = document.querySelector('[data-algo-card="yespower"]');
    check('yespower card: workers = 1, accepted = 1, scheme PPLNS',
        fieldText(yesCard, 'workers') === '1' && fieldText(yesCard, 'shares-accepted') === '1' &&
        fieldText(yesCard, 'scheme') === 'PPLNS');
    var ethCard = document.querySelector('[data-algo-card="ethash"]');
    check('ethash card: last block shows the seeded block #913,982',
        (fieldText(ethCard, 'last-block') || '').indexOf('#913,982') === 0, fieldText(ethCard, 'last-block'));

    /* workers table */
    var workersBody = document.getElementById('workers-body');
    check('workers table: seeded workers listed with share counts',
        workersBody.textContent.indexOf('addrDashWorker1') !== -1 &&
        workersBody.textContent.indexOf('addrDashCpu') !== -1 &&
        workersBody.textContent.indexOf('3 / 1') !== -1);
    check('workers table: empty placeholder hidden once workers exist',
        document.getElementById('workers-empty').hidden === true);

    /* blocks table */
    var blocksBody = document.getElementById('blocks-body');
    check('blocks table: seeded block height + truncated hash shown',
        blocksBody.textContent.indexOf('#913,982') !== -1 &&
        blocksBody.textContent.indexOf('abcdef0123…23456789') !== -1, blocksBody.textContent.slice(0, 120));
    check('blocks table: distribution status from payouts store shown (confirmed)',
        blocksBody.textContent.indexOf('confirmed') !== -1);
    check('blocks table: empty placeholder hidden once a block exists',
        document.getElementById('blocks-empty').hidden === true);

    /* payouts panel */
    check('payouts summary: fee 2%, min 0.5 ITC, 5 confirmations, DRY-RUN mode',
        document.getElementById('payouts-fee').textContent === '2%' &&
        document.getElementById('payouts-min').textContent.indexOf('0.5 ITC') === 0 &&
        document.getElementById('payouts-confirmations').textContent === '5' &&
        document.getElementById('payouts-mode').textContent.indexOf('DRY-RUN') === 0,
        document.getElementById('payouts-min').textContent);
    var payoutsBody = document.getElementById('payouts-body');
    check('payouts table: seeded batch shown (1 ITC total, dry-run psbt stage)',
        payoutsBody.textContent.indexOf('1 ITC') !== -1 &&
        payoutsBody.textContent.indexOf('dry-run · psbt created') !== -1,
        payoutsBody.textContent.slice(0, 120));
    check('payouts table: empty placeholder hidden once a batch exists',
        document.getElementById('payouts-empty').hidden === true);

    /* status + connection panel */
    check('API status: shows API online, banner hidden',
        document.getElementById('api-status-text').textContent === 'API online' &&
        document.getElementById('api-banner').hidden === true);
    check('uptime: rendered from stats (not the placeholder dash)',
        document.getElementById('uptime').textContent !== '—' &&
        document.getElementById('uptime').textContent.indexOf('0h 0m') !== -1,
        document.getElementById('uptime').textContent);
    var conn = document.getElementById('connection-list');
    check('connection panel: stratum URLs built from config ports',
        conn.textContent.indexOf('stratum+tcp://127.0.0.1:3333') !== -1 &&
        conn.textContent.indexOf('stratum+tcp://127.0.0.1:3335') !== -1);

    await new Promise(function (res) { server.close(res); });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? 'ALL DASHBOARD CHECKS PASSED' : failures + ' CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.log('FAIL  dashboard run aborted: ' + (e && e.stack || e));
    process.exit(1);
});
