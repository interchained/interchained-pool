'use strict';
/*
 * ledger.js -- JSON-backed accounting store for PROP / PPLNS payouts.
 *
 * Pure JS + Node builtins only. All amounts are INTEGER satoshis.
 *
 * Persisted shape (another lane's API reads this file -- do not deviate):
 *   {
 *     version: 1,
 *     shares:  [ { algo, worker, workerName, difficulty, time, height } ],
 *     blocks:  [ { algo, height, hash, reward, finder, time, scheme,
 *                  status, confirmations, payoutId, feeSat?, amounts? } ],
 *     balances: { algo: { address: { pending, paid } } },
 *     payouts: [ { id, algo, time, dryRun, txid,
 *                  amounts: { address: satoshis }, blocks: [heights],
 *                  fee (satoshis) } ]
 *   }
 *
 * `worker` on a share is the payout ADDRESS: any ".worker" suffix of the
 * stratum username is stripped. The suffix (or null) is kept as workerName,
 * and the original full username is kept as `workerFull` for debugging.
 *
 * Share persistence batching (phase 3): recordShare() used to rewrite the
 * whole JSON store on EVERY share. Shares now go through bounded
 * write-behind batching (see _recordShareSave):
 *   - leading edge: if the last save is at least batchFlushMs old, the
 *     share saves synchronously (so a lone share is durable immediately,
 *     exactly as before);
 *   - otherwise the share stays pending in memory and a trailing timer
 *     flushes at the end of the window, OR as soon as batchMaxShares
 *     shares are pending — whichever comes first;
 *   - money events are NEVER batched: blocks, block-status updates,
 *     balance moves and payout records/batches save synchronously (and
 *     flush any pending shares with them);
 *   - flush() forces a save; close() flushes and disarms the timer; a
 *     process 'exit' hook flushes pending shares on clean shutdown.
 * CRASH-SAFETY BOUND (honest): a hard kill between flushes can lose at
 * most the unflushed share tail — never more than batchMaxShares-1
 * shares, and only shares recorded within the last batchFlushMs window.
 * Recorded blocks and payout batches can never be lost this way: they
 * are written synchronously before recordBlock/recordPayout return.
 * In-memory readers (getShares/getBlocks/...) always see every share;
 * only readers of the FILE lag by at most that bound.
 * Options: batchMaxShares (default 100), batchFlushMs (default 5000).
 */

var fs = require('fs');
var path = require('path');

function emptyData() {
    return { version: 1, shares: [], blocks: [], balances: {}, payouts: [] };
}

function splitWorker(worker) {
    var full = worker == null ? '' : String(worker);
    var dot = full.indexOf('.');
    if (dot === -1) return { address: full, workerName: null };
    return { address: full.slice(0, dot), workerName: full.slice(dot + 1) || null };
}

function Ledger(options) {
    options = options || {};
    this.dataFile = options.dataFile || null;
    this.maxSharesPerAlgo = (typeof options.maxSharesPerAlgo === 'number' && options.maxSharesPerAlgo > 0)
        ? Math.floor(options.maxSharesPerAlgo) : 50000;
    this.batchMaxShares = (typeof options.batchMaxShares === 'number' && options.batchMaxShares > 0)
        ? Math.floor(options.batchMaxShares) : 100;
    this.batchFlushMs = (typeof options.batchFlushMs === 'number' && options.batchFlushMs >= 0)
        ? Math.floor(options.batchFlushMs) : 5000;
    this._pendingShares = 0;   // shares recorded since the last successful save
    this._lastSaveAt = 0;      // ms epoch of the last save (0 = never)
    this._flushTimer = null;
    this.data = emptyData();
    if (this.dataFile) this.load();
    if (this.dataFile) {
        // Clean-shutdown hook: 'exit' handlers must be synchronous —
        // save() is (writeFileSync + renameSync), so pending shares are
        // flushed on any orderly process exit. close() removes it.
        var self = this;
        this._exitHook = function () {
            try { if (self._pendingShares > 0) self.save(); } catch (e) { /* exiting anyway */ }
        };
        process.on('exit', this._exitHook);
    }
}

Ledger.splitWorker = splitWorker;

Ledger.prototype.load = function () {
    if (!this.dataFile || !fs.existsSync(this.dataFile)) {
        this.data = emptyData();
        return this.data;
    }
    var parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    var data = emptyData();
    if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.shares)) data.shares = parsed.shares;
        if (Array.isArray(parsed.blocks)) data.blocks = parsed.blocks;
        if (parsed.balances && typeof parsed.balances === 'object') data.balances = parsed.balances;
        if (Array.isArray(parsed.payouts)) data.payouts = parsed.payouts;
    }
    data.version = 1;
    this.data = data;
    this._pendingShares = 0;
    this._lastSaveAt = 0; // next share leading-edge flushes after a (re)load
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    return this.data;
};

/* Atomic-ish save: write a temp file in the same directory, then rename
 * over the target (rename is atomic on the same filesystem).
 * A successful save also settles the share batch: every pending share
 * is in the file now, so the pending counter resets and any trailing
 * flush timer is disarmed. Money-event methods call save() directly —
 * they are never batched. */
Ledger.prototype.save = function () {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this.dataFile) { this._pendingShares = 0; return; } // in-memory only ledger (tests)
    var dir = path.dirname(this.dataFile);
    fs.mkdirSync(dir, { recursive: true });
    var tmp = this.dataFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dataFile);
    this._pendingShares = 0;
    this._lastSaveAt = Date.now();
};

/* Share-path persistence: bounded write-behind batching (see header).
 * Flushes synchronously on the leading edge (window already elapsed)
 * or when the pending cap is reached; otherwise arms one trailing
 * timer for the remainder of the window. */
Ledger.prototype._recordShareSave = function () {
    if (!this.dataFile) return; // in-memory only: nothing to persist
    this._pendingShares++;
    var elapsed = Date.now() - this._lastSaveAt;
    if (this._pendingShares >= this.batchMaxShares || elapsed >= this.batchFlushMs) {
        this.save();
        return;
    }
    if (!this._flushTimer) {
        var self = this;
        var wait = Math.max(0, this.batchFlushMs - elapsed);
        this._flushTimer = setTimeout(function () {
            self._flushTimer = null;
            if (self._pendingShares > 0) self.save();
        }, wait);
        if (typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
    }
};

/* Force any pending batched shares to disk now (shutdown / tests). */
Ledger.prototype.flush = function () {
    if (this._pendingShares > 0 || this._flushTimer) this.save();
};

/* Flush pending shares, disarm the timer, and remove the exit hook. */
Ledger.prototype.close = function () {
    this.flush();
    if (this._exitHook) {
        process.removeListener('exit', this._exitHook);
        this._exitHook = null;
    }
};

Ledger.prototype.recordShare = function (share) {
    var parts = splitWorker(share.worker);
    var entry = {
        algo: share.algo,
        worker: parts.address,
        workerName: parts.workerName,
        workerFull: share.worker == null ? null : String(share.worker),
        difficulty: Number(share.difficulty) || 0,
        time: (typeof share.time === 'number') ? share.time : Math.floor(Date.now() / 1000),
        height: (typeof share.height === 'number') ? share.height : null
    };
    this.data.shares.push(entry);
    this._trimShares(entry.algo);
    this._recordShareSave(); // batched (bounded) — blocks/payouts below are NOT
    return entry;
};

/* Keep only the newest maxSharesPerAlgo shares per algo (PPLNS only ever
 * looks back windowN shares, PROP only back to the previous block). */
Ledger.prototype._trimShares = function (algo) {
    var mine = [], others = [];
    for (var i = 0; i < this.data.shares.length; i++) {
        (this.data.shares[i].algo === algo ? mine : others).push(this.data.shares[i]);
    }
    if (mine.length > this.maxSharesPerAlgo)
        mine = mine.slice(mine.length - this.maxSharesPerAlgo);
    // Preserve original relative order per partition; shares are appended
    // chronologically so reassembly by partition is acceptable for lookups,
    // which always filter by algo and sort/window by time themselves.
    this.data.shares = others.concat(mine);
};

Ledger.prototype.getShares = function (algo) {
    return this.data.shares.filter(function (s) { return s.algo === algo; });
};

Ledger.prototype.recordBlock = function (block) {
    var entry = {
        algo: block.algo,
        height: block.height,
        hash: block.hash,
        reward: Math.round(Number(block.reward) || 0), // satoshis, integer
        finder: block.finder ? splitWorker(block.finder).address : null,
        finderFull: block.finder || null,
        time: (typeof block.time === 'number') ? block.time : Math.floor(Date.now() / 1000),
        scheme: block.scheme || 'solo',
        status: 'pending',
        confirmations: 0,
        payoutId: null
    };
    this.data.blocks.push(entry);
    this.save();
    return entry;
};

Ledger.prototype.getBlocks = function (algo) {
    if (!algo) return this.data.blocks.slice();
    return this.data.blocks.filter(function (b) { return b.algo === algo; });
};

Ledger.prototype.getBlockByHash = function (hash) {
    for (var i = 0; i < this.data.blocks.length; i++)
        if (this.data.blocks[i].hash === hash) return this.data.blocks[i];
    return null;
};

Ledger.prototype.updateBlockStatus = function (hash, status, confirmations, payoutId) {
    var block = this.getBlockByHash(hash);
    if (!block) return null;
    if (typeof status === 'string') block.status = status;
    if (typeof confirmations === 'number') block.confirmations = confirmations;
    if (typeof payoutId !== 'undefined') block.payoutId = payoutId;
    this.save();
    return block;
};

/* Extra helper (beyond the required surface): attach audit fields such as
 * the computed split / fee to a stored block. */
Ledger.prototype.setBlockFields = function (hash, fields) {
    var block = this.getBlockByHash(hash);
    if (!block) return null;
    Object.keys(fields || {}).forEach(function (k) { block[k] = fields[k]; });
    this.save();
    return block;
};

Ledger.prototype._balanceEntry = function (algo, address) {
    if (!this.data.balances[algo]) this.data.balances[algo] = {};
    if (!this.data.balances[algo][address])
        this.data.balances[algo][address] = { pending: 0, paid: 0 };
    return this.data.balances[algo][address];
};

/* Credit integer-satoshi amounts into balances.pending. */
Ledger.prototype.addBalances = function (algo, amountsMapSat) {
    var self = this;
    Object.keys(amountsMapSat || {}).forEach(function (address) {
        var amt = Math.round(Number(amountsMapSat[address]) || 0);
        if (amt === 0) return;
        self._balanceEntry(algo, address).pending += amt;
    });
    this.save();
};

/* Deep copy, so API readers cannot mutate the store by accident. */
Ledger.prototype.getBalances = function () {
    return JSON.parse(JSON.stringify(this.data.balances));
};

/* Move integer-satoshi amounts from pending to paid (after a payout --
 * including a dry-run payout; see payments.js for that documented choice).
 * Clamps at the available pending balance so pending never goes negative. */
Ledger.prototype.movePendingToPaid = function (algo, amountsMapSat) {
    var self = this;
    Object.keys(amountsMapSat || {}).forEach(function (address) {
        var amt = Math.round(Number(amountsMapSat[address]) || 0);
        if (amt === 0) return;
        var entry = self._balanceEntry(algo, address);
        var moved = Math.min(amt, entry.pending);
        entry.pending -= moved;
        entry.paid += moved;
    });
    this.save();
};

Ledger.prototype.recordPayout = function (payoutObj) {
    var entry = {
        id: payoutObj.id,
        algo: payoutObj.algo,
        time: (typeof payoutObj.time === 'number') ? payoutObj.time : Math.floor(Date.now() / 1000),
        dryRun: !!payoutObj.dryRun,
        txid: payoutObj.txid || null,
        amounts: payoutObj.amounts || {},
        blocks: payoutObj.blocks || [],
        fee: Math.round(Number(payoutObj.fee) || 0)
    };
    /* PSBT flow fields (phase 2, Mark's requirement change): payouts are
     * built as PSBTs. `psbt` is the base64 PSBT for the batch (updated as
     * it moves through the stages), `stage` is one of
     * 'created' | 'processed' | 'finalized' | 'sent', `hex` the finalized
     * raw transaction once known, `error` the last stage failure. */
    if (typeof payoutObj.psbt === 'string') entry.psbt = payoutObj.psbt;
    if (typeof payoutObj.stage === 'string') entry.stage = payoutObj.stage;
    if (typeof payoutObj.hex === 'string') entry.hex = payoutObj.hex;
    if (typeof payoutObj.error === 'string') entry.error = payoutObj.error;
    this.data.payouts.push(entry);
    this.save();
    return entry;
};

/* Update fields of an existing payout (PSBT stage progression, txid,
 * error). Returns the updated entry or null. */
Ledger.prototype.updatePayout = function (id, fields) {
    var entry = null;
    for (var i = 0; i < this.data.payouts.length; i++) {
        if (this.data.payouts[i].id === id) { entry = this.data.payouts[i]; break; }
    }
    if (!entry) return null;
    Object.keys(fields || {}).forEach(function (k) { entry[k] = fields[k]; });
    this.save();
    return entry;
};

Ledger.prototype.getPayouts = function () {
    return this.data.payouts.slice();
};

module.exports = { Ledger: Ledger, splitWorker: splitWorker };
