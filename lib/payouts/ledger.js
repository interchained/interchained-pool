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
    this.data = emptyData();
    if (this.dataFile) this.load();
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
    return this.data;
};

/* Atomic-ish save: write a temp file in the same directory, then rename
 * over the target (rename is atomic on the same filesystem). */
Ledger.prototype.save = function () {
    if (!this.dataFile) return; // in-memory only ledger (tests)
    var dir = path.dirname(this.dataFile);
    fs.mkdirSync(dir, { recursive: true });
    var tmp = this.dataFile + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dataFile);
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
    this.save();
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
