/* ============================================================
   INTERCHAINED OS '98 — window manager & desktop behaviour.
   Pure behaviour layer: boot sequence, draggable windows,
   minimize / maximize / close, start menu, taskbar buttons,
   block-found toasts, optional 8-bit sounds, screensaver.
   The data layer stays in app.js; this file never fetches.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- sounds (off until the tray says so) ---------------- */
  var soundOn = false;
  var AC = null;
  function beep(freq, dur, delay, type) {
    if (!soundOn) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      var t = AC.currentTime + (delay || 0);
      var o = AC.createOscillator();
      var g = AC.createGain();
      o.type = type || 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.045, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(AC.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* audio is a garnish, never an error */ }
  }
  function blip() { beep(660, 0.06, 0); }
  function arpeggio() { beep(523, .09, 0); beep(659, .09, .09); beep(784, .09, .18); beep(1047, .16, .27); }
  var sndBtn = document.getElementById('snd-btn');
  if (sndBtn) sndBtn.addEventListener('click', function () {
    soundOn = !soundOn;
    sndBtn.textContent = soundOn ? '🔊' : '🔇';
    if (soundOn) blip();
  });

  /* ---------------- boot sequence ---------------- */
  var bios = document.getElementById('bios');
  var biosText = document.getElementById('bios-text');
  var biosFill = document.getElementById('bios-fill');
  var bootDone = false;
  var BOOT_LINES = [
    '╔══════════════════════════════════════╗',
    '║   ⛓  I N T E R C H A I N E D  ⛓    ║',
    '║     ONE CHAIN · THREE PROOFS        ║',
    '╚══════════════════════════════════════╝',
    'ITC SYSTEMS INC. — INTERCHAINED BIOS v9.14',
    '',
    'CPU ......... 64 CORES DETECTED .......... OK',
    'MEMORY ...... {MEM}K SYSTEM RAM ......... OK',
    'GPU ......... ETHASH LANE · 32GB VRAM .... OK',
    'ASIC ........ SHA256 LANE ................ OK',
    'CPU MINER ... YESPOWER LANE .............. OK',
    'STORAGE ..... NEDB JOURNAL ............... OK',
    'LEDGER ...... SHARE LEDGER MOUNTED ....... OK',
    'FAIRNESS .... RECONCILIATION ENGINE ...... OK',
    '',
    'LOADING POOL.EXE ...'
  ];
  function endBoot() {
    if (bootDone) return;
    bootDone = true;
    try { sessionStorage.setItem('itc-os-booted', '1'); } catch (e) {}
    if (bios) { bios.classList.add('bios-out'); setTimeout(function () { bios.remove(); }, 420); }
  }
  var bootedBefore = false;
  try { bootedBefore = !!sessionStorage.getItem('itc-os-booted'); } catch (e) {}
  if (bios && !bootedBefore) {
    var li = 0;
    var lineTimer = setInterval(function () {
      if (li < BOOT_LINES.length) {
        var line = BOOT_LINES[li];
        li++;
        if (line.indexOf('{MEM}') > -1) {
          /* memory test: count up like a real POST, fast */
          biosText.textContent += line.replace('{MEM}', '0') + '\n';
          var mem = 0;
          var memTimer = setInterval(function () {
            mem += 8192 + Math.floor(Math.random() * 8192);
            if (mem >= 262144) { mem = 262144; clearInterval(memTimer); }
            biosText.textContent = biosText.textContent.replace(/MEMORY \.+ \d+K/, 'MEMORY ...... ' + mem + 'K');
          }, 34);
          return;
        }
        biosText.textContent += line + '\n';
      } else {
        clearInterval(lineTimer);
        var pct = 0;
        var barTimer = setInterval(function () {
          pct += 8 + Math.random() * 10;
          if (pct >= 100) { pct = 100; clearInterval(barTimer); setTimeout(endBoot, 260); }
          biosFill.style.width = pct + '%';
        }, 70);
      }
    }, 110);
    bios.addEventListener('click', endBoot);
    document.addEventListener('keydown', function skip() {
      if (!bootDone) { endBoot(); document.removeEventListener('keydown', skip); }
    });
  } else if (bios) {
    bios.remove();
    bootDone = true;
  }

  /* ---------------- shutdown / reboot ---------------- */
  var shutdown = document.getElementById('shutdown');
  function doShutdown() {
    hideStartMenu();
    shutdown.classList.remove('hidden');
  }
  if (shutdown) shutdown.addEventListener('click', function () {
    shutdown.classList.add('hidden');
    try { sessionStorage.removeItem('itc-os-booted'); } catch (e) {}
    window.location.reload();
  });

  /* ---------------- window manager ---------------- */
  var zTop = 10;
  var windows = Array.prototype.slice.call(document.querySelectorAll('.window'));
  var taskBtns = document.getElementById('task-btns');

  function titleOf(win) {
    var t = win.querySelector('.window-title');
    return t ? t.textContent.trim() : win.id;
  }
  function focus(win) {
    windows.forEach(function (w) { w.classList.toggle('focused', w === win); });
    zTop += 1;
    win.style.zIndex = zTop;
    if (taskBtns) {
      Array.prototype.forEach.call(taskBtns.children, function (b) {
        b.classList.toggle('active', b.getAttribute('data-win') === win.id);
      });
    }
  }
  function openWin(id) {
    var win = document.getElementById(id);
    if (!win) return;
    win.classList.remove('hidden', 'minned');
    ensureTaskBtn(win);
    focus(win);
    blip();
    if (!win.classList.contains('maxed')) {
      var y = win.getBoundingClientRect().top + window.scrollY - 86;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }
  function ensureTaskBtn(win) {
    if (!taskBtns || taskBtns.querySelector('[data-win="' + win.id + '"]')) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'task-btn';
    b.setAttribute('data-win', win.id);
    b.textContent = titleOf(win);
    b.addEventListener('click', function () {
      if (win.classList.contains('minned') || win.classList.contains('hidden')) openWin(win.id);
      else if (win.classList.contains('focused')) minWin(win);
      else focus(win);
    });
    taskBtns.appendChild(b);
  }
  function minWin(win) {
    win.classList.add('minned');
    win.classList.remove('focused');
  }
  function closeWin(win) {
    win.classList.add('hidden');
    win.classList.remove('minned', 'maxed', 'focused');
    var b = taskBtns && taskBtns.querySelector('[data-win="' + win.id + '"]');
    if (b) b.remove();
  }
  function toggleMax(win) {
    win.classList.toggle('maxed');
    focus(win);
  }

  function modeHidden(win) {
    var m = win.getAttribute('data-mode');
    if (!m) return false;
    return (m === 'group' && !document.body.classList.contains('mode-group')) ||
           (m === 'solo' && !document.body.classList.contains('mode-solo'));
  }
  document.addEventListener('poolmode', function () {
    windows.forEach(function (win) {
      var b = taskBtns && taskBtns.querySelector('[data-win="' + win.id + '"]');
      if (modeHidden(win)) { if (b) b.remove(); }
      else if (!win.classList.contains('hidden')) ensureTaskBtn(win);
    });
  });

  windows.forEach(function (win) {
    if (!win.classList.contains('hidden') && !modeHidden(win)) ensureTaskBtn(win);
    var bar = win.querySelector('.window-bar');
    if (!bar) return;

    /* brand every window: the coin rides in each title bar */
    if (!bar.querySelector('.win-coin')) {
      var brandImg = document.querySelector('.brand-logo');
      var coin = document.createElement('img');
      coin.className = 'win-coin';
      coin.src = brandImg ? brandImg.src : 'logo.png';
      coin.alt = '';
      coin.setAttribute('aria-hidden', 'true');
      bar.insertBefore(coin, bar.firstChild);
    }

    win.addEventListener('pointerdown', function () { focus(win); });

    /* drag by the title bar (fine pointers, wide screens) */
    bar.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest('.win-btns')) return;
      if (window.innerWidth < 900 || win.classList.contains('maxed')) return;
      var startX = ev.clientX, startY = ev.clientY;
      var m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(win.style.transform || '');
      var ox = m ? parseFloat(m[1]) : 0, oy = m ? parseFloat(m[2]) : 0;
      win.classList.add('dragging');
      function move(e2) {
        win.style.transform = 'translate(' + (ox + e2.clientX - startX) + 'px,' + (oy + e2.clientY - startY) + 'px)';
      }
      function up() {
        win.classList.remove('dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      }
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    bar.addEventListener('dblclick', function (ev) {
      if (ev.target.closest('.win-btns')) return;
      toggleMax(win);
    });

    Array.prototype.forEach.call(bar.querySelectorAll('.win-btns i'), function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var act = btn.getAttribute('data-act');
        if (act === 'min') minWin(win);
        else if (act === 'close') closeWin(win);
        else if (act === 'max') toggleMax(win);
      });
    });
  });
  var hero = document.getElementById('win-hero');
  if (hero) focus(hero);
  var aboutOk = document.getElementById('about-ok');
  if (aboutOk) aboutOk.addEventListener('click', function () { closeWin(document.getElementById('win-about')); });

  /* ---------------- start menu + desktop icons ---------------- */
  var startBtn = document.getElementById('start-btn');
  var startMenu = document.getElementById('start-hub');
  var hubClose = document.getElementById('hub-close');
  if (hubClose) hubClose.addEventListener('click', function () { hideStartMenu(); });
  function hideStartMenu() { if (startMenu) startMenu.classList.add('hidden'); }
  if (startBtn && startMenu) {
    startBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      startMenu.classList.toggle('hidden');
      if (!startMenu.classList.contains('hidden')) blip();
    });
    document.addEventListener('click', function (ev) {
      if (!startMenu.contains(ev.target)) hideStartMenu();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hideStartMenu(); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (elm) {
    elm.addEventListener('click', function () { openWin(elm.getAttribute('data-open')); hideStartMenu(); });
    if (elm.classList.contains('dicon')) {
      elm.addEventListener('dblclick', function () { openWin(elm.getAttribute('data-open')); });
    }
  });
  var smShutdown = document.getElementById('sm-shutdown');
  if (smShutdown) smShutdown.addEventListener('click', doShutdown);
  var smSaver = document.getElementById('sm-saver');
  if (smSaver) smSaver.addEventListener('click', function () { hideStartMenu(); startSaver(); });
  var iconSaver = document.getElementById('icon-saver');
  if (iconSaver) iconSaver.addEventListener('click', function () { startSaver(); });

  /* ---------------- block-found toasts ---------------- */
  var toasts = document.getElementById('toasts');
  var lastHeight = null;
  function heightNow() {
    var row = document.querySelector('#blocks-list .block-row .block-height');
    if (row) {
      var n = parseInt(String(row.textContent).replace(/[^\d]/g, ''), 10);
      if (!isNaN(n)) return n;
    }
    var chip = document.getElementById('height-chip');
    if (chip) {
      var m = /(\d[\d,]*)/.exec(chip.textContent || '');
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    }
    return null;
  }
  function toast(html) {
    if (!toasts) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = html;
    toasts.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 30);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 450); }, 6400);
  }
  /* One toast per block, ever: comms.js fires a 'poolblock' event
     for EACH new ledger block (even several in one poll); the DOM
     poller below is a fallback for the latest height. The seen-set
     keeps them from ever doubling up. */
  var toastedHeights = {};
  function blockToast(height, rewardText, algo) {
    if (height == null || toastedHeights[height]) return;
    toastedHeights[height] = true;
    var delay = Object.keys(toastedHeights).length % 3;
    setTimeout(function () {
      toast('<b>🏆 NEW BLOCK #' + Number(height).toLocaleString('en-US') + (algo ? ' · ' + String(algo).toUpperCase() : '') + '</b><span>LEVEL CLEAR!' + (rewardText ? ' · ' + rewardText : '') + '</span>');
      arpeggio();
      coinBurst();
      var hs = document.getElementById('hero-status');
      if (hs) hs.textContent = '⛏ BLOCK #' + Number(height).toLocaleString('en-US') + ' ACCEPTED · CHAIN ADVANCING';
    }, delay * 350);
  }
  document.addEventListener('poolblock', function (ev) {
    var d = (ev && ev.detail) || {};
    var reward = d.rewardItc != null ? '+' + d.rewardItc.toFixed(4) + ' ITC'
      : (d.rewardSat != null ? '+' + (Number(d.rewardSat) / 1e8).toFixed(4) + ' ITC' : '');
    blockToast(d.height, reward, d.algo);
  });

  function coinBurst() {
    var layer = document.createElement('div');
    layer.className = 'coin-layer';
    for (var i = 0; i < 18; i++) {
      var img = document.createElement('img');
      img.src = 'logo.png';
      img.className = 'coin-bit';
      img.alt = '';
      img.style.left = (4 + Math.random() * 92) + 'vw';
      img.style.width = (22 + Math.random() * 30) + 'px';
      img.style.animationDelay = (Math.random() * 0.45) + 's';
      img.style.animationDuration = (1.5 + Math.random() * 1.3) + 's';
      layer.appendChild(img);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 3400);
    var ef = document.getElementById('edgeflash');
    if (ef) { ef.classList.remove('flash'); void ef.offsetWidth; ef.classList.add('flash'); }
  }
  setInterval(function () {
    var h = heightNow();
    if (h == null) return;
    if (lastHeight != null && h > lastHeight) {
      /* fallback path: heights strictly between lastHeight and h were
         already toasted by comms events; toast the newest one here
         only if comms somehow missed it (dedupe inside blockToast) */
      var r = document.querySelector('#blocks-list .block-row .block-reward');
      blockToast(h, r ? r.textContent.trim() : '', '');
    }
    lastHeight = h;
  }, 3000);

  /* ---------------- screensaver: coin warp ---------------- */
  var saver = document.getElementById('saver');
  var saverOn = false, saverRaf = null, idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startSaver, 120000);
  }
  var logoImg = new Image();
  var logoReady = false;
  logoImg.onload = function () { logoReady = true; };
  logoImg.src = 'logo.png';
  function startSaver() {
    if (!saver || saverOn) return;
    saverOn = true;
    hideStartMenu();
    saver.classList.remove('hidden');
    var ctx = saver.getContext('2d');
    var W, H, coins = [], stars = [], t0 = Date.now();
    function size() {
      W = saver.width = window.innerWidth;
      H = saver.height = window.innerHeight;
    }
    size();
    for (var i = 0; i < 90; i++) stars.push({ x: Math.random(), y: Math.random(), z: Math.random() * 0.9 + 0.1 });
    for (var j = 0; j < 14; j++) coins.push({ x: Math.random(), y: Math.random(), s: 14 + Math.random() * 26, v: 0.0006 + Math.random() * 0.0016, ph: Math.random() * 6.28 });
    var lx = 0.3, ly = 0.3, vx = 0.0011, vy = 0.0008;
    function frame() {
      if (!saverOn) return;
      var t = (Date.now() - t0) / 1000;
      ctx.fillStyle = '#020208';
      ctx.fillRect(0, 0, W, H);
      stars.forEach(function (s) {
        s.x -= s.z * 0.00035; if (s.x < 0) s.x = 1;
        ctx.fillStyle = 'rgba(255,255,255,' + (0.35 + s.z * 0.6) + ')';
        ctx.fillRect(s.x * W, s.y * H, s.z * 2.4, s.z * 2.4);
      });
      coins.forEach(function (c) {
        c.y += c.v; if (c.y > 1.05) { c.y = -0.05; c.x = Math.random(); }
        var x = c.x * W, y = c.y * H, s = c.s * (0.75 + 0.25 * Math.sin(t * 2 + c.ph));
        if (logoReady) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.sin(t * 1.4 + c.ph) * 0.6);
          ctx.drawImage(logoImg, -s / 2, -s / 2, s, s);
          ctx.restore();
        } else {
          ctx.fillStyle = '#c9a227'; ctx.fillRect(x - s / 2, y - s / 2, s, s);
          ctx.fillStyle = '#ffd83d'; ctx.fillRect(x - s / 2 + 2, y - s / 2 + 2, s - 4, s - 4);
          ctx.fillStyle = '#a87f14';
          ctx.font = 'bold ' + Math.round(s * 0.55) + 'px monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('I', x, y + 1);
        }
      });
      lx += vx; ly += vy;
      if (lx < 0.12 || lx > 0.62) vx = -vx;
      if (ly < 0.1 || ly > 0.8) vy = -vy;
      ctx.font = '28px "Press Start 2P", monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillText('INTERCHAINED', lx * W + 3, ly * H + 3);
      var grad = ctx.createLinearGradient(lx * W, ly * H - 26, (lx + 0.3) * W, ly * H);
      grad.addColorStop(0, '#ff5252'); grad.addColorStop(0.5, '#ffd83d'); grad.addColorStop(1, '#38b6ff');
      ctx.fillStyle = grad;
      ctx.fillText('INTERCHAINED', lx * W, ly * H);
      saverRaf = requestAnimationFrame(frame);
    }
    frame();
    saver._onResize = size;
    window.addEventListener('resize', size);
  }
  function stopSaver() {
    if (!saverOn) return;
    saverOn = false;
    if (saverRaf) cancelAnimationFrame(saverRaf);
    if (saver) { saver.classList.add('hidden'); window.removeEventListener('resize', saver._onResize); }
    resetIdle();
  }
  ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) {
    document.addEventListener(ev, function () { if (saverOn) stopSaver(); else resetIdle(); }, { passive: true });
  });
  resetIdle();
})();
