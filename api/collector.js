'use strict';
/*
 * StatsCollector - in-memory + persisted mining-pool statistics.
 *
 * Zero dependencies: Node.js builtins only (fs, path).
 *
 * Hashrate convention (read this before trusting the number):
 *   hashrate = sum(accepted share difficulties in window) * 2^32 / windowSeconds
 * This is the classic diff-1 based estimate: a difficulty-1 share represents
 * ~2^32 hashes on average. It is used here as an ESTIMATE for all three
 * algos (sha256, yespower, ethash) even though their native difficulty
 * semantics differ - it gives one comparable, monotonic number per algo /
 * per worker, not a metrologically exact device hashrate.
 * The divisor is always the full window (default 600s), per the spec
 * formula, so the estimate ramps up during the first window after start.
 */

const fs = require('fs');
const path = require('path');

const ALGOS = ['sha256', 'yespower', 'ethash'];
const DEFAULT_WINDOW_SECONDS = 600;
const MAX_BLOCKS_PER_ALGO = 100;
const MAX_WINDOW_ENTRIES = 10000;
const SAVE_INTERVAL_MS = 10000;

function normalizeAlgo(algo) {
  return String(algo || 'unknown').toLowerCase();
}

function normalizeTime(time) {
  if (time == null) return Date.now();
  if (typeof time === 'string') {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  const n = Number(time);
  if (!Number.isFinite(n)) return Date.now();
  // Seconds-since-epoch -> milliseconds.
  if (n > 0 && n < 1e11) return Math.round(n * 1000);
  return n;
}

function toPositiveDiff(value, fallback) {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

/* Restore a persisted rolling window: keep only well-formed
   {t, diff} entries, newest last, capped like the snapshot writer.
   Staleness is not handled here — _windowHashrate prunes entries
   older than the window horizon on every read. */
function sanitizeWindow(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const t = Number(e.t);
    const diff = Number(e.diff);
    if (!Number.isFinite(t) || !Number.isFinite(diff) || diff <= 0) continue;
    out.push({ t, diff });
  }
  return out.slice(-MAX_WINDOW_ENTRIES);
}

class StatsCollector {
  /**
   * @param {object} [options]
   * @param {string|null} [options.dataFile] persistence path
   *        (default: <this dir>/data/stats.json; null disables persistence)
   * @param {number} [options.windowSeconds] rolling hashrate window (default 600)
   */
  constructor(options) {
    const opts = options || {};
    this.windowSeconds =
      Number.isFinite(Number(opts.windowSeconds)) && Number(opts.windowSeconds) > 0
        ? Number(opts.windowSeconds)
        : DEFAULT_WINDOW_SECONDS;
    this.dataFile =
      opts.dataFile === null
        ? null
        : opts.dataFile || path.join(__dirname, 'data', 'stats.json');

    this.startTime = Date.now();
    // Per-algo state:
    // { sharesAccepted, sharesRejected,
    //   workers: { name: {shares, invalidShares, lastShareAt, connected, window:[{t,diff}] } },
    //   blocksFound: [{height, algo, hash, time}],
    //   window: [{t, diff}] }   // rolling window, persisted in the snapshot
    this.algos = {};
    for (const algo of ALGOS) this.algos[algo] = this._emptyAlgoState();

    this._lastSaveAt = 0;
    this._saveTimer = null;
    this._savePending = false;

    if (this.dataFile) this._load();
  }

  _emptyAlgoState() {
    return {
      sharesAccepted: 0,
      sharesRejected: 0,
      workers: {},
      blocksFound: [],
      window: [],
    };
  }

  _ensureAlgo(algo) {
    const key = normalizeAlgo(algo);
    if (!this.algos[key]) this.algos[key] = this._emptyAlgoState();
    return { key, state: this.algos[key] };
  }

  _ensureWorker(state, workerName) {
    const name = workerName ? String(workerName) : 'unknown';
    if (!state.workers[name]) {
      state.workers[name] = {
        shares: 0,
        invalidShares: 0,
        lastShareAt: null,
        connected: false,
        window: [],
      };
    }
    return state.workers[name];
  }

  // ---------------------------------------------------------------- attach
  /**
   * Subscribe to a node-stratum-pool pool instance for `algo`.
   * Pool contract (lib/pool.js): the pool is an EventEmitter emitting
   *   'share' (isValidShare, isValidBlock, shareData)
   *   'log'   (severity, message)          -> ignored here
   * shareData typically has {job, ip, port, worker, height, blockReward,
   * difficulty, shareDiff, blockDiff, blockHash, error}; every field is
   * treated as optional. Returns `this` for chaining.
   */
  attach(poolInstance, algo) {
    if (!poolInstance || typeof poolInstance.on !== 'function') return this;
    const algoKey = normalizeAlgo(algo);

    poolInstance.on('share', (isValidShare, isValidBlock, shareData) => {
      try {
        const data = shareData && typeof shareData === 'object' ? shareData : {};
        // Pool derives isValidShare from !shareData.error; trust the
        // boolean when present, fall back to the error field.
        const valid =
          typeof isValidShare === 'boolean' ? isValidShare : !data.error;
        const workerName = data.worker || data.workerName || 'unknown';
        // Prefer the target difficulty the miner was working at; shareDiff
        // (actual achieved difficulty, a string from jobManager) is the
        // fallback. Both feed the same diff-1 window convention.
        const difficulty = toPositiveDiff(
          data.difficulty != null ? data.difficulty : data.shareDiff,
          1
        );

        this.recordShare(algoKey, workerName, {
          valid,
          difficulty,
          isBlock: !!isValidBlock,
        });

        if (valid && isValidBlock) {
          this.recordBlock(algoKey, {
            height: data.height != null ? data.height : null,
            hash: data.blockHash || data.hash || null,
            time: Date.now(),
          });
        }
      } catch (_) {
        // A malformed share event must never crash the pool.
      }
    });

    // 'log' is handled minimally: subscribed so an unhandled-event style
    // pool never surprises us, and deliberately ignored.
    if (typeof poolInstance.on === 'function') {
      poolInstance.on('log', () => {});
    }
    return this;
  }

  // ------------------------------------------------------------- producers
  /**
   * recordShare(algo, workerName, {valid, difficulty, isBlock})
   * `valid` defaults to true when omitted. `difficulty` defaults to 1.
   * If isBlock is true AND height/hash are also supplied, a block entry is
   * recorded too; normally blocks arrive via recordBlock() (attach() does
   * that itself), so plain {valid, difficulty, isBlock} calls never create
   * duplicate block entries.
   */
  recordShare(algo, workerName, share) {
    const opts = share || {};
    const { key, state } = this._ensureAlgo(algo);
    const worker = this._ensureWorker(state, workerName);
    const valid = opts.valid === undefined ? true : !!opts.valid;
    const difficulty = toPositiveDiff(opts.difficulty, 1);
    const now = Date.now();

    worker.lastShareAt = now;
    if (valid) {
      state.sharesAccepted += 1;
      worker.shares += 1;
      state.window.push({ t: now, diff: difficulty });
      worker.window.push({ t: now, diff: difficulty });
      this._pruneWindow(state.window, now);
      this._pruneWindow(worker.window, now);
    } else {
      state.sharesRejected += 1;
      worker.invalidShares += 1;
    }

    if (valid && opts.isBlock && (opts.height != null || opts.hash)) {
      this.recordBlock(key, {
        height: opts.height != null ? opts.height : null,
        hash: opts.hash || null,
        time: opts.time,
      });
      return; // recordBlock already forced a save
    }
    this._scheduleSave();
  }

  /** recordBlock(algo, {height, hash, time}) - time is epoch ms, epoch s, or a date string. */
  recordBlock(algo, block) {
    const opts = block || {};
    const { key, state } = this._ensureAlgo(algo);
    const entry = {
      height: opts.height != null ? opts.height : null,
      algo: key,
      hash: opts.hash || opts.blockHash || null,
      time: normalizeTime(opts.time),
    };
    state.blocksFound.push(entry);
    if (state.blocksFound.length > MAX_BLOCKS_PER_ALGO) {
      state.blocksFound = state.blocksFound.slice(-MAX_BLOCKS_PER_ALGO);
    }
    this._saveNow(); // blocks are rare and important: persist immediately
    return entry;
  }

  noteWorkerConnect(algo, workerName) {
    const { state } = this._ensureAlgo(algo);
    this._ensureWorker(state, workerName).connected = true;
    this._scheduleSave();
  }

  noteWorkerDisconnect(algo, workerName) {
    const { state } = this._ensureAlgo(algo);
    this._ensureWorker(state, workerName).connected = false;
    this._scheduleSave();
  }

  // -------------------------------------------------------------- hashrate
  _pruneWindow(window, now) {
    const cutoff = now - this.windowSeconds * 1000;
    let i = 0;
    while (i < window.length && window[i].t < cutoff) i += 1;
    if (i > 0) window.splice(0, i);
  }

  _windowHashrate(window) {
    const now = Date.now();
    this._pruneWindow(window, now);
    let sum = 0;
    for (const entry of window) sum += entry.diff;
    // diff1-based convention, see header comment.
    return (sum * Math.pow(2, 32)) / this.windowSeconds;
  }

  getHashrate(algo) {
    const { state } = this._ensureAlgo(algo);
    return this._windowHashrate(state.window);
  }

  // -------------------------------------------------------------- snapshots
  getAlgoStats(algo) {
    const { key, state } = this._ensureAlgo(algo);
    const workers = Object.keys(state.workers).map((name) => {
      const w = state.workers[name];
      return {
        worker: name,
        algo: key,
        hashrate: this._windowHashrate(w.window),
        shares: w.shares,
        invalidShares: w.invalidShares,
        connected: !!w.connected,
        lastShareAt: w.lastShareAt != null ? w.lastShareAt : null,
      };
    });
    return {
      hashrate: this._windowHashrate(state.window),
      // `workers` is the worker count; names/detail ride along as extras.
      workers: workers.length,
      workerNames: workers.map((w) => w.worker),
      workersDetail: workers,
      sharesAccepted: state.sharesAccepted,
      sharesRejected: state.sharesRejected,
      blocksFound: state.blocksFound.length,
      lastBlock:
        state.blocksFound.length > 0
          ? state.blocksFound[state.blocksFound.length - 1]
          : null,
    };
  }

  getStats() {
    const algos = {};
    for (const algo of Object.keys(this.algos)) {
      algos[algo] = this.getAlgoStats(algo);
    }
    // The three contract algos are always present, even with zero data.
    for (const algo of ALGOS) {
      if (!algos[algo]) algos[algo] = this.getAlgoStats(algo);
    }
    return {
      startedAt: this.startTime,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.startTime) / 1000)),
      algos,
    };
  }

  /** Recent blocks across all algos, newest first. */
  getBlocks(limit) {
    const all = [];
    for (const algo of Object.keys(this.algos)) {
      for (const b of this.algos[algo].blocksFound) all.push(b);
    }
    all.sort((a, b) => b.time - a.time || Number(b.height || 0) - Number(a.height || 0));
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
    return all.slice(0, n);
  }

  /** Flat worker list across all algos. */
  getWorkers() {
    const out = [];
    for (const algo of Object.keys(this.algos)) {
      const state = this.algos[algo];
      for (const name of Object.keys(state.workers)) {
        const w = state.workers[name];
        out.push({
          worker: name,
          algo,
          // Per-worker estimate from that worker's own rolling window;
          // 0 when it has no accepted shares left in the window.
          hashrate: this._windowHashrate(w.window),
          shares: w.shares,
          invalidShares: w.invalidShares,
          connected: !!w.connected,
          lastShareAt: w.lastShareAt != null ? w.lastShareAt : null,
        });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ persistence
  _snapshot() {
    const algos = {};
    for (const algo of Object.keys(this.algos)) {
      const s = this.algos[algo];
      const workers = {};
      for (const name of Object.keys(s.workers)) {
        const w = s.workers[name];
        workers[name] = {
          shares: w.shares,
          invalidShares: w.invalidShares,
          lastShareAt: w.lastShareAt != null ? w.lastShareAt : null,
          connected: !!w.connected,
          // Rolling window included so a restart does not zero the
          // worker's hashrate estimate (see _snapshot note below).
          window: Array.isArray(w.window) ? w.window.slice(-MAX_WINDOW_ENTRIES) : [],
        };
      }
      algos[algo] = {
        sharesAccepted: s.sharesAccepted,
        sharesRejected: s.sharesRejected,
        workers,
        blocksFound: s.blocksFound.slice(-MAX_BLOCKS_PER_ALGO),
        window: Array.isArray(s.window) ? s.window.slice(-MAX_WINDOW_ENTRIES) : [],
      };
    }
    // Counters + blocks + the rolling windows. The windows ride along
    // so the hashrate readouts survive a pool restart instead of
    // rebuilding from an empty window (the "hashrate is different
    // after reboot" bug); entries older than the window horizon are
    // pruned on read by _windowHashrate as usual.
    return { version: 1, startTime: this.startTime, savedAt: Date.now(), algos };
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.dataFile, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      if (Number.isFinite(Number(data.startTime))) this.startTime = Number(data.startTime);
      const savedAlgos = data.algos && typeof data.algos === 'object' ? data.algos : {};
      for (const algo of Object.keys(savedAlgos)) {
        const { state } = this._ensureAlgo(algo);
        const s = savedAlgos[algo] || {};
        state.sharesAccepted = Number(s.sharesAccepted) || 0;
        state.sharesRejected = Number(s.sharesRejected) || 0;
        if (Array.isArray(s.blocksFound)) {
          state.blocksFound = s.blocksFound
            .filter((b) => b && typeof b === 'object')
            .map((b) => ({
              height: b.height != null ? b.height : null,
              algo: normalizeAlgo(b.algo || algo),
              hash: b.hash || null,
              time: normalizeTime(b.time),
            }))
            .slice(-MAX_BLOCKS_PER_ALGO);
        }
        state.window = sanitizeWindow(s.window);
        const savedWorkers = s.workers && typeof s.workers === 'object' ? s.workers : {};
        for (const name of Object.keys(savedWorkers)) {
          const w = this._ensureWorker(state, name);
          const sw = savedWorkers[name] || {};
          w.shares = Number(sw.shares) || 0;
          w.invalidShares = Number(sw.invalidShares) || 0;
          w.lastShareAt = sw.lastShareAt != null ? Number(sw.lastShareAt) || null : null;
          w.window = sanitizeWindow(sw.window);
          // A worker persisted as connected is stale after a restart.
          w.connected = false;
        }
      }
    } catch (_) {
      // Missing or corrupt file: start from zeros, never crash.
    }
  }

  _saveNow() {
    if (!this.dataFile) return;
    this._lastSaveAt = Date.now();
    this._savePending = false;
    try {
      const dir = path.dirname(this.dataFile);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.dataFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this._snapshot(), null, 2));
      fs.renameSync(tmp, this.dataFile); // atomic on the same filesystem
    } catch (_) {
      // Persistence failure must never crash the pool/API.
    }
  }

  /** Save at most once every 10s; coalesces bursts into one trailing save. */
  _scheduleSave() {
    if (!this.dataFile) return;
    const elapsed = Date.now() - this._lastSaveAt;
    if (elapsed >= SAVE_INTERVAL_MS && !this._saveTimer) {
      this._saveNow();
      return;
    }
    this._savePending = true;
    if (!this._saveTimer) {
      const wait = Math.max(0, SAVE_INTERVAL_MS - elapsed);
      this._saveTimer = setTimeout(() => {
        this._saveTimer = null;
        if (this._savePending) this._saveNow();
      }, wait);
      if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref();
    }
  }

  /** Force any pending save out now (shutdown / tests). */
  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveNow();
  }
}

StatsCollector.ALGOS = ALGOS;
StatsCollector.DEFAULT_WINDOW_SECONDS = DEFAULT_WINDOW_SECONDS;

module.exports = StatsCollector;
module.exports.StatsCollector = StatsCollector;
module.exports.ALGOS = ALGOS;
