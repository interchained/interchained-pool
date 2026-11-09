/* ============================================================
   POOL COMMS — the Start hub. The bots are REAL: each one is a
   live function of the pool's own API, not canned copy.
     POOL-SYSTEM — pool config, mode and state changes
     BLOCK-BOT   — every block in the ledger, explorer-linked,
                   plus new blocks the moment polling sees them
     CREW-BOT    — miner joins, leaves and share milestones,
                   diffed from /api/workers between polls
     LEDGER-BOT  — the reconciliation verdict, from the books
     PAYDAY-BOT  — payout batches as they are published
   The event engine polls on its own cycle and diffs snapshots,
   so messages appear when things actually happen; channels
   carry unread badges until you open them.
   ============================================================ */
(function () {
  'use strict';

  var hub = document.getElementById('start-hub');
  if (!hub) return;
  var msgBox = document.getElementById('hub-messages');
  var memBox = document.getElementById('hub-members');
  var nameEl = document.getElementById('hub-channel-name');
  var topicEl = document.getElementById('hub-topic');
  var modeLine = document.getElementById('hub-mode-line');
  var input = document.getElementById('hub-input');
  var sendBtn = document.getElementById('hub-send');
  var startDot = document.getElementById('start-dot');
  var EXPLORER = 'https://vision.interchained.org/block/';

  var ALGO_COLORS = { sha256: '#ff5252', yespower: '#46e046', ethash: '#38b6ff' };
  var BOTS = {
    system: { name: 'POOL-SYSTEM', color: '#ffd83d', tag: 'SYSTEM' },
    blocks: { name: 'BLOCK-BOT', color: '#ff5252', tag: 'BOT' },
    miners: { name: 'CREW-BOT', color: '#46e046', tag: 'BOT' },
    ledger: { name: 'LEDGER-BOT', color: '#38b6ff', tag: 'BOT' },
    payday: { name: 'PAYDAY-BOT', color: '#c586ff', tag: 'BOT' },
    you: { name: 'OPERATOR', color: '#ffffff', tag: 'YOU' }
  };
  var TOPICS = {
    announcements: 'computed live from the pool config — never canned',
    'block-feed': 'every block in the ledger, explorer-linked',
    'miner-chat': 'joins, leaves and share milestones, as they happen',
    'pool-chat': 'real chat — stored in NEDB on the pool, hash-chained',
    fairness: 'the books, balancing in public',
    payouts: 'batches the moment they are published'
  };
  var CHANNELS = ['announcements', 'block-feed', 'miner-chat', 'pool-chat', 'fairness', 'payouts'];

  var state = {
    ch: 'announcements',
    data: null,
    prev: null,               /* previous snapshot, for diffs */
    feeds: { announcements: [], 'block-feed': [], 'miner-chat': [], 'pool-chat': [], fairness: [], payouts: [] },
    read: { announcements: 0, 'block-feed': 0, 'miner-chat': 0, 'pool-chat': 0, fairness: 0, payouts: 0 },
    booted: false,
    ephemeral: [] /* pool-chat locals (command replies, unsent echoes) */
  };

  /* ---------------- helpers ---------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function fetchJson(url) {
    return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fmtHashrate(h) {
    h = Number(h) || 0;
    var units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    var i = 0;
    while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
    return (i === 0 ? Math.round(h) : h.toFixed(2)) + ' ' + units[i];
  }
  function fmtItc(sat) {
    if (sat == null) return '—';
    var v = Number(sat) / 1e8;
    return v.toFixed(4) + ' ITC';
  }
  function shortAddr(a) {
    a = String(a || '');
    return a.length > 22 ? a.slice(0, 12) + '…' + a.slice(-6) : a;
  }
  function mode() { return document.body.classList.contains('mode-group') ? 'group' : 'solo'; }

  /* ---------------- feed primitives ---------------- */
  /* A feed item: { bot, time, lines } — a line is a string or { t, href }. */
  function push(ch, bot, lines, time) {
    var feed = state.feeds[ch];
    feed.push({ bot: bot, time: time || Date.now(), lines: lines });
    if (feed.length > 60) feed.splice(0, feed.length - 60);
    updateBadges();
  }
  function msgNode(item) {
    var bot = item.who || BOTS[item.bot] || BOTS.system;
    var row = el('div', 'hmsg');
    var av = el('div', 'havatar', bot.name.charAt(0));
    av.style.background = bot.color;
    row.appendChild(av);
    var main = el('div', 'hmain');
    var head = el('div', 'hhead');
    var nm = el('span', 'hname', bot.name);
    nm.style.color = bot.color;
    head.appendChild(nm);
    head.appendChild(el('span', 'htag', bot.tag));
    if (item.time) head.appendChild(el('span', 'htime', fmtTime(item.time)));
    main.appendChild(head);
    item.lines.forEach(function (ln) {
      var d = el('div', 'hline');
      if (typeof ln === 'string') d.textContent = ln;
      else {
        d.appendChild(document.createTextNode(ln.t + ' '));
        var a = el('a', 'hline-link', 'view on explorer ↗');
        a.href = ln.href;
        a.target = '_blank';
        a.rel = 'noopener';
        d.appendChild(a);
      }
      main.appendChild(d);
    });
    row.appendChild(main);
    return row;
  }
  function renderMessages() {
    var feed = state.feeds[state.ch] || [];
    msgBox.textContent = '';
    if (!feed.length) {
      msgBox.appendChild(el('div', 'hempty', 'Watching the pool… the first real event posts here.'));
    } else {
      feed.forEach(function (item) { msgBox.appendChild(msgNode(item)); });
    }
    msgBox.scrollTop = msgBox.scrollHeight;
    state.read[state.ch] = feed.length;
    updateBadges();
  }
  function updateBadges() {
    var total = 0;
    CHANNELS.forEach(function (ch) {
      var unread = Math.max(0, state.feeds[ch].length - state.read[ch]);
      total += unread;
      var btn = hub.querySelector('.hub-ch[data-ch="' + ch + '"]');
      if (!btn) return;
      var badge = btn.querySelector('.hub-badge');
      if (unread > 0) {
        if (!badge) { badge = el('span', 'hub-badge'); btn.appendChild(badge); }
        badge.textContent = unread > 9 ? '9+' : String(unread);
      } else if (badge) badge.remove();
    });
    if (startDot) startDot.classList.toggle('hidden', total === 0 || !hub.classList.contains('hidden'));
  }

  /* ---------------- baselines: computed from real config ---------------- */
  function baselineAnnouncements(d) {
    var cfg = d.config || {};
    var ports = cfg.stratumPorts || { sha256: 3333, yespower: 3334, ethash: 3335 };
    var pay = cfg.payments || {};
    var lines = [];
    lines.push('Interchained tri-PoW pool is live. Stratum — SHA256 :' + ports.sha256 + ' · Yespower :' + ports.yespower + ' · Ethash :' + ports.ethash + '. Username = your ITC address.');
    if (mode() === 'solo') {
      lines.push('Mode: SOLO on every lane (operator env ITC_<ALGO>_SCHEME). Blocks pay the finder\'s address directly from the coinbase — no splits, no pool fee.');
    } else {
      var lanes = Object.keys(cfg.algos || {}).map(function (a) {
        return a.toUpperCase() + '=' + String((cfg.algos[a] || {}).scheme || 'solo').toUpperCase();
      }).join(' · ');
      lines.push('Mode: GROUP — ' + lanes + '. Fee ' + (pay.feePercent != null ? pay.feePercent : 0) + '% · min payout ' + (pay.minPayoutItc != null ? pay.minPayoutItc : '—') + ' ITC · ' + (pay.confirmations != null ? pay.confirmations : '—') + ' confirmations to settle.');
      if (pay.dryRun) lines.push('Payments are in DRY-RUN: batches publish, no coins move.');
    }
    if (cfg.poolAddress) lines.push('Pool address: ' + cfg.poolAddress);
    push('announcements', 'system', lines, d.now);
  }
  function baselineBlocks(d) {
    (d.storeBlocks || []).slice().reverse().forEach(function (b) {
      push('block-feed', 'blocks', blockLines(b), b.time);
    });
    if (!d.storeBlocks || !d.storeBlocks.length) {
      push('block-feed', 'blocks', ['Ledger is empty — no pool blocks yet. The first find posts here the moment the chain accepts it.'], d.now);
    }
  }
  function blockLines(b) {
    var reward = b.rewardItc != null ? Number(b.rewardItc).toFixed(4) + ' ITC' : fmtItc(b.rewardSat);
    var lines = ['⛏ Block #' + Number(b.height).toLocaleString('en-US') + ' · ' + String(b.algo || '').toUpperCase() + ' · ' + reward + ' · ' + (b.status || 'seen') + (b.finder ? ' · finder ' + shortAddr(b.finder) : '')];
    if (b.hash) lines.push({ t: String(b.hash).slice(0, 24) + '…', href: EXPLORER + b.hash });
    return lines;
  }
  function baselineFairness(d) {
    var r = d.reconcile || {};
    var agg = r.aggregate || {};
    push('fairness', 'ledger', [
      r.balanced ? '✅ Books BALANCED to the satoshi.' : '⚠ Books do NOT balance — open FAIRNESS.EXE.',
      'Settled blocks ' + (r.settledBlocks || 0) + ' · rewards in ' + fmtItc(agg.rewardInSat) + ' · paid ' + fmtItc(agg.payoutsSat) + ' · fees ' + fmtItc(agg.feeSat)
    ], d.now);
    (d.breakdowns || []).forEach(function (b) {
      push('fairness', 'ledger', ['Split published for block #' + Number(b.height).toLocaleString('en-US') + ' (' + (b.scheme || 'group') + ') — recomputable from the raw ledger.'], d.now);
    });
  }
  function baselinePayouts(d) {
    var list = (d.payouts && d.payouts.payouts) || [];
    list.slice().reverse().forEach(function (p) { push('payouts', 'payday', payoutLines(p), d.now); });
    if (!list.length) push('payouts', 'payday', ['No batches published yet — settled group blocks roll into the first one.'], d.now);
  }
  function payoutLines(p) {
    return ['Batch ' + (p.totalItc != null ? Number(p.totalItc).toFixed(4) + ' ITC' : '') + ' → ' + (p.minersPaid || 0) + ' miners' + (p.feeItc ? ' · fee ' + p.feeItc + ' ITC' : '') + (p.dryRun ? ' · DRY-RUN' : ' · SENT') + (p.txid ? ' · tx ' + String(p.txid).slice(0, 18) + '…' : '')];
  }

  /* ---------------- the event engine: snapshot diffs ---------------- */
  function snapshot(d) {
    var workers = {};
    (d.workers || []).forEach(function (w) { workers[w.worker] = { connected: !!w.connected, shares: Number(w.shares) || 0, algo: w.algo }; });
    var blocks = {};
    (d.storeBlocks || []).forEach(function (b) { blocks[b.height] = b; });
    var pays = ((d.payouts && d.payouts.payouts) || []).map(function (p) { return p.txid || (p.totalItc + ':' + p.minersPaid); });
    return {
      workers: workers, blocks: blocks, pays: pays,
      balanced: d.reconcile ? !!d.reconcile.balanced : null
    };
  }
  function diffEvents(d) {
    var prev = state.prev;
    var next = snapshot(d);
    if (prev) {
      /* new blocks: bot post + a page-wide event so every single
         one gets its own toast (retro.js listens), even when
         several land inside one poll */
      Object.keys(next.blocks).forEach(function (h) {
        if (!prev.blocks[h]) {
          var nb = next.blocks[h];
          push('block-feed', 'blocks', ['🚨 NEW BLOCK'].concat(blockLines(nb)), nb.time);
          document.dispatchEvent(new CustomEvent('poolblock', {
            detail: { height: Number(h), algo: nb.algo || '', rewardItc: nb.rewardItc != null ? Number(nb.rewardItc) : null, rewardSat: nb.rewardSat }
          }));
        }
      });
      /* worker joins / leaves / milestones */
      Object.keys(next.workers).forEach(function (name) {
        var n = next.workers[name], o = prev.workers[name];
        if (!o && n.connected) push('miner-chat', 'miners', ['🟢 ' + name + ' connected on ' + String(n.algo || '').toUpperCase() + ' and is hashing.'], d.now);
        else if (o && !o.connected && n.connected) push('miner-chat', 'miners', ['🟢 ' + name + ' reconnected.'], d.now);
        else if (o && o.connected && !n.connected) push('miner-chat', 'miners', ['🔴 ' + name + ' disconnected.'], d.now);
        else if (o && n.connected && Math.floor(n.shares / 500) > Math.floor(o.shares / 500)) {
          push('miner-chat', 'miners', ['⛏ ' + name + ' crossed ' + (Math.floor(n.shares / 500) * 500).toLocaleString('en-US') + ' shares on ' + String(n.algo || '').toUpperCase() + '.'], d.now);
        }
      });
      Object.keys(prev.workers).forEach(function (name) {
        if (!next.workers[name]) push('miner-chat', 'miners', ['🔴 ' + name + ' left the pool.'], d.now);
      });
      /* reconcile flip */
      if (prev.balanced !== null && next.balanced !== null && prev.balanced !== next.balanced) {
        push('fairness', 'ledger', [next.balanced ? '✅ Books are BALANCED again.' : '⚠ ALERT: the books no longer balance. Open FAIRNESS.EXE.'], d.now);
      }
      /* new payout batches */
      next.pays.forEach(function (id, i) {
        if (prev.pays.indexOf(id) === -1) {
          var p = (d.payouts.payouts || [])[i];
          if (p) push('payouts', 'payday', ['💸 NEW BATCH PUBLISHED'].concat(payoutLines(p)), d.now);
        }
      });
    }
    state.prev = next;
  }

  /* ---------------- members rail ---------------- */
  function renderMembers(d) {
    memBox.textContent = '';
    var online = (d.workers || []).filter(function (w) { return w.connected; });
    memBox.appendChild(el('div', 'hmem-group', 'MINERS — ' + online.length));
    online.forEach(function (w) {
      var row = el('div', 'hmem');
      var av = el('span', 'hmem-av', String(w.worker || '?').charAt(0).toUpperCase());
      av.style.background = ALGO_COLORS[w.algo] || '#888';
      row.appendChild(av);
      row.appendChild(el('span', 'hmem-name', String(w.worker)));
      row.appendChild(el('span', 'hmem-hr', fmtHashrate(w.hashrate)));
      memBox.appendChild(row);
    });
    memBox.appendChild(el('div', 'hmem-group', 'LIVE BOTS'));
    Object.keys(BOTS).forEach(function (k) {
      if (k === 'you') return;
      var b = BOTS[k];
      var row = el('div', 'hmem');
      var av = el('span', 'hmem-av', b.name.charAt(0));
      av.style.background = b.color;
      row.appendChild(av);
      row.appendChild(el('span', 'hmem-name', b.name));
      row.appendChild(el('span', 'hmem-hr', '● live'));
      memBox.appendChild(row);
    });
  }

  /* ---------------- pool chat: NEDB-backed, wasm-replicated ----------------
     The server stores chat in NEDB embedded (api/chatStore.js).
     This tab keeps its own NEDB (nedb-wasm, in-memory): it replays
     the server's exact puts and lands on the same Merkle head —
     the channel header shows the local verify() result. If the
     wasm cannot load, chat still works straight off the API and
     the header says so. */
  var AUTHOR_COLORS = ['#ff5252', '#46e046', '#38b6ff', '#ffd83d', '#c586ff', '#ff9d2e', '#4be0c3', '#e05a9b'];
  function authorColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
  }
  function whoOf(m) {
    return { name: m.author, color: authorColor(m.author), tag: 'CHAT' };
  }
  var chatStatus = null; // server NEDB status {engine, head, seq, verify, count}
  function syncChat(payload) {
    var messages = (payload && payload.messages) || [];
    chatStatus = (payload && payload.status) || null;
    state.feeds['pool-chat'] = messages.map(function (m) {
      return { who: whoOf(m), time: m.ts, lines: [m.text] };
    }).concat(state.ephemeral);
    updateBadges();
    replicaSync(messages);
  }

  var replica = { state: 'off', db: null, applied: {}, head: null, verified: false };
  function replicaInit() {
    if (replica.state !== 'off') return;
    replica.state = 'loading';
    var glueUrl = window.__ITC_NEDB_GLUE_URL || 'vendor/nedb/nedb_wasm.js';
    import(glueUrl).then(function (mod) {
      var bytes = null;
      if (window.__ITC_NEDB_WASM_B64) {
        var bin = atob(window.__ITC_NEDB_WASM_B64);
        bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      }
      var initArg = bytes ? { module_or_path: bytes } : 'vendor/nedb/nedb_wasm_bg.wasm';
      return mod.default(initArg).then(function () {
        replica.db = new mod.NedbWasm();
        replica.state = 'ready';
        if (state.data) load();
      });
    }).catch(function () {
      replica.state = 'failed';
      if (state.ch === 'pool-chat') render();
    });
  }
  function replicaSync(messages) {
    if (!replica.db) { replicaInit(); return; }
    try {
      messages.forEach(function (m) {
        if (!replica.applied[m.id]) {
          /* the canonical doc bytes — identical to the server's put */
          replica.db.put('chat', m.id, JSON.stringify({ author: m.author, text: m.text, ts: m.ts }));
          replica.applied[m.id] = true;
        }
      });
      replica.head = replica.db.head();
      replica.verified = replica.db.verify();
    } catch (e) {
      replica.state = 'failed';
    }
    if (state.ch === 'pool-chat') render();
  }
  function replicaLine() {
    if (replica.state === 'ready' && replica.db) {
      var mine = replica.head ? replica.head.slice(0, 10) + '…' : '—';
      if (chatStatus && chatStatus.head) {
        return replica.verified && replica.head === chatStatus.head
          ? ' · NEDB replica ✓ verified in this tab · head ' + mine + ' = server'
          : ' · NEDB replica ' + (replica.verified ? '✓ chain valid' : '✗ VERIFY FAILED') + ' · head ' + mine;
      }
      return ' · NEDB replica ✓ verified in this tab · head ' + mine;
    }
    if (replica.state === 'loading') return ' · NEDB replica loading…';
    if (replica.state === 'failed') return ' · live API mode (wasm replica unavailable)';
    return '';
  }

  function myName() {
    try {
      var n = localStorage.getItem('itc-chat-name');
      if (n) return n;
      n = 'guest-' + Math.floor(1000 + Math.random() * 9000);
      localStorage.setItem('itc-chat-name', n);
      return n;
    } catch (e) { return 'guest'; }
  }
  function postChat(text) {
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ author: myName(), text: text })
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function () { load(); }).catch(function () {
      state.ephemeral.push({ who: whoOf({ author: myName() }), time: Date.now(), lines: [text] });
      state.ephemeral.push({ bot: 'system', time: Date.now(), lines: ['⚠ Chat backend unreachable — that message was NOT stored. It is local-only.'] });
      if (state.ephemeral.length > 20) state.ephemeral.splice(0, state.ephemeral.length - 20);
      render();
    });
  }

  /* ---------------- load + render ---------------- */
  function load() {
    return Promise.all([
      fetchJson('/api/config').catch(function () { return null; }),
      fetchJson('/api/workers').catch(function () { return []; }),
      fetchJson('/api/blocks?limit=30&source=store').catch(function () { return []; }),
      fetchJson('/api/payouts').catch(function () { return null; }),
      fetchJson('/api/reconcile').catch(function () { return null; }),
      fetchJson('/api/breakdowns').catch(function () { return []; }),
      fetchJson('/api/stats').catch(function () { return null; }),
      fetchJson('/api/chat?limit=120').catch(function () { return null; })
    ]).then(function (r) {
      var d = { config: r[0], workers: r[1], storeBlocks: r[2], payouts: r[3], reconcile: r[4], breakdowns: r[5], stats: r[6], now: Date.now() };
      state.data = d;
      if (r[7]) syncChat(r[7]);
      if (!state.booted) {
        state.booted = true;
        baselineAnnouncements(d);
        baselineBlocks(d);
        baselineFairness(d);
        baselinePayouts(d);
        state.prev = snapshot(d);
        /* mark baselines read except block-feed, so history doesn't spam badges */
        CHANNELS.forEach(function (ch) { state.read[ch] = state.feeds[ch].length; });
      } else {
        diffEvents(d);
        streamStats(d);
      }
      render();
    });
  }

  /* ---------------- stat streaming ----------------
     Every ~60s the bots post a live stat line to their channels —
     but only when the numbers actually moved, so the feed reads
     like a stream, not a metronome. Books stream every ~5 min. */
  var cycle = 0;
  var lastStreamKey = '';
  function streamStats(d) {
    cycle++;
    var s = d.stats;
    if (!s || !s.algos) return;
    var tot = 0, wk = 0, acc = 0, rej = 0, sess = { sha256: 0, yespower: 0, ethash: 0 };
    Object.keys(s.algos).forEach(function (a) {
      var x = s.algos[a] || {};
      tot += Number(x.hashrate) || 0;
      wk += Number(x.workers) || 0;
      acc += Number(x.sharesAccepted) || 0;
      rej += Number(x.sharesRejected) || 0;
      if (sess[a] != null) sess[a] = Number(x.blocksFound) || 0;
    });
    var ledgerCount = (d.storeBlocks || []).length;
    var latest = (d.storeBlocks || [])[0];
    if (cycle % 5 === 0) {
      var key = [ledgerCount, Math.round(tot), wk, acc].join('|');
      if (key !== lastStreamKey) {
        lastStreamKey = key;
        push('block-feed', 'blocks', [
          '📊 BLOCK STATS — ledger: ' + ledgerCount + ' blocks · this session: SHA ' + sess.sha256 + ' · YES ' + sess.yespower + ' · ETH ' + sess.ethash +
          (latest ? ' · latest #' + Number(latest.height).toLocaleString('en-US') + ' (' + String(latest.algo || '').toUpperCase() + ')' : '')
        ], d.now);
        var rr = (acc + rej) > 0 ? (100 * rej / (acc + rej)).toFixed(2) : '0.00';
        push('miner-chat', 'miners', [
          '📡 HASHRATE STREAM — combined ' + fmtHashrate(tot) + ' · ' + wk + ' miners online · shares ' + acc.toLocaleString('en-US') + ' accepted · reject rate ' + rr + '%'
        ], d.now);
      }
    }
    if (cycle % 25 === 0 && mode() === 'group') {
      var r = d.reconcile || {};
      var agg = r.aggregate || {};
      push('fairness', 'ledger', [
        '🧾 BOOKS STREAM — settled ' + (r.settledBlocks || 0) + ' · in ' + fmtItc(agg.rewardInSat) + ' · paid ' + fmtItc(agg.payoutsSat) + ' · fees ' + fmtItc(agg.feeSat) + ' · ' + (r.balanced ? 'BALANCED ✅' : 'NOT BALANCED ⚠')
      ], d.now);
    }
  }
  function render() {
    var d = state.data;
    if (!d) return;
    nameEl.textContent = state.ch;
    topicEl.textContent = (TOPICS[state.ch] || '') + (state.ch === 'pool-chat' ? replicaLine() : '');
    if (modeLine) modeLine.textContent = 'MODE: ' + mode().toUpperCase();
    renderMessages();
    renderMembers(d);
  }
  Array.prototype.forEach.call(hub.querySelectorAll('.hub-ch'), function (b) {
    b.addEventListener('click', function () {
      hub.querySelectorAll('.hub-ch').forEach(function (x) { x.classList.toggle('active', x === b); });
      state.ch = b.getAttribute('data-ch');
      render();
    });
  });
  new MutationObserver(function () { updateBadges(); }).observe(hub, { attributes: true, attributeFilter: ['class'] });

  /* ---------------- command input ---------------- */
  function postAs(botKey, text) {
    var ch = 'miner-chat';
    state.feeds[ch].push({ bot: botKey, time: Date.now(), lines: [text] });
    if (state.ch !== ch) {
      state.ch = ch;
      hub.querySelectorAll('.hub-ch').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-ch') === ch); });
    }
    render();
    var d = state.data;
    if (d) renderMembers(d);
  }
  /* Command replies land in the channel you typed in: ephemeral
     locals in #pool-chat (server feed owns that channel), feed
     posts in #miner-chat otherwise. */
  function reply(botKey, text) {
    if (state.ch === 'pool-chat') {
      state.ephemeral.push({ bot: botKey, time: Date.now(), lines: [text] });
      if (state.ephemeral.length > 20) state.ephemeral.splice(0, state.ephemeral.length - 20);
      render();
    } else {
      postAs(botKey, text);
    }
  }
  function echoMine(text) {
    if (state.ch === 'pool-chat') {
      state.ephemeral.push({ bot: 'you', time: Date.now(), lines: [text] });
      render();
    } else {
      postAs('you', text);
    }
  }
  function submit() {
    var v = (input.value || '').trim();
    if (!v) return;
    input.value = '';
    if (v === '/help') {
      echoMine(v);
      reply('system', 'Commands: /stats — live pool totals · /blocks — latest block · /nick <name> — set your chat name (now: ' + myName() + ') · paste an itc1… address — miner lookup. In #pool-chat your messages are stored in NEDB on the pool and visible to every miner.');
      return;
    }
    if (v.indexOf('/nick ') === 0) {
      var name = v.slice(6).trim().slice(0, 42);
      if (name) {
        try { localStorage.setItem('itc-chat-name', name); } catch (e) {}
        echoMine(v);
        reply('system', 'Chat name set to ' + name + '.');
      }
      return;
    }
    if (v === '/stats') {
      echoMine(v);
      var s = state.data && state.data.stats;
      if (s && s.algos) {
        var tot = 0, wk = 0, bl = 0;
        Object.keys(s.algos).forEach(function (a) { tot += Number(s.algos[a].hashrate) || 0; wk += Number(s.algos[a].workers) || 0; bl += Number(s.algos[a].blocksFound) || 0; });
        reply('system', 'Live: ' + fmtHashrate(tot) + ' combined · ' + wk + ' miners online · ' + bl + ' blocks this session · uptime ' + Math.round((s.uptimeSeconds || 0) / 60) + ' min.');
      } else reply('system', 'Stats unavailable right now.');
      return;
    }
    if (v === '/blocks') {
      echoMine(v);
      var list = (state.data && state.data.storeBlocks) || [];
      if (list.length) {
        var b = list[0];
        reply('blocks', 'Latest: #' + Number(b.height).toLocaleString('en-US') + ' · ' + String(b.algo || '').toUpperCase() + ' · ' + (b.rewardItc != null ? Number(b.rewardItc).toFixed(4) + ' ITC' : '') + ' · ' + (b.status || ''));
      } else reply('blocks', 'No pool blocks in the ledger yet.');
      return;
    }
    if (/^itc1[0-9a-z]+$/i.test(v)) {
      echoMine('Lookup: ' + v);
      var inp = document.getElementById('lookup-input');
      var opener = document.querySelector('[data-open="win-lookup"]');
      if (inp) inp.value = v;
      if (opener) opener.click();
      if (typeof window.lookupMiner === 'function') { try { window.lookupMiner(v); } catch (e) {} }
      reply('system', 'Opened FIND_MINER.EXE for ' + shortAddr(v) + '.');
      return;
    }
    if (state.ch === 'pool-chat') { postChat(v); return; }
    postAs('you', v);
  }
  if (sendBtn) sendBtn.addEventListener('click', submit);
  if (input) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submit(); });

  document.addEventListener('poolmode', function () { if (state.data) render(); });
  load();
  setInterval(load, 12000);
})();
