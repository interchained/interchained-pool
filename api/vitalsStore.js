'use strict';
/*
 * Pool vitals cache — NEDB embedded (nedb-engine, Mark's engine).
 *
 * The pool's live vitals used to exist only inside the pool process:
 * the network snapshot (chain height, peers, per-lane difficulty and
 * network hashrate) was served solely by start.js's in-process API,
 * and the dashboard's hashrate charts accumulated in the browser from
 * page-open. Any other server of the same dashboard (the standalone
 * API) showed NETWORK: UNAVAILABLE forever, and every reboot or page
 * load wiped the charts — the chain's health record evaporated.
 *
 * This store is the shared, durable copy, written by the pool process
 * and read by whichever API serves the page:
 *
 *   vitals_network  — one doc (id "current"): the latest network
 *                     snapshot, overwritten on every daemon poll.
 *   vitals_samples  — appended hashrate samples {t, height, sha256,
 *                     yespower, ethash}: the chart history, sampled
 *                     by start.js every 30 s, kept indefinitely.
 *
 * Same contract as the chat store: the engine is required lazily and
 * a missing nedb-engine throws a coded VITALS_UNAVAILABLE error —
 * callers degrade to "no cache" and nothing else depends on it.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'data', 'vitals-nedb');
const NETWORK_COLLECTION = 'vitals_network';
const SAMPLES_COLLECTION = 'vitals_samples';
const NETWORK_ID = 'current';

/* NEDB is single-opener: the engine refuses a second process on the
   same directory (split-brain protection). The pool process is the
   store's only writer; OTHER servers of the dashboard read this
   mirror file instead — a small JSON snapshot of the latest network
   state plus the recent sample window, rewritten atomically by the
   pool on every sample (30 s) and on every height change. */
const DEFAULT_MIRROR_FILE = path.join(__dirname, 'data', 'vitals-cache.json');

function writeMirrorFile(file, payload) {
  const target = file || DEFAULT_MIRROR_FILE;
  try {
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = target + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({
      network: payload && payload.network ? payload.network : null,
      samples: payload && Array.isArray(payload.samples) ? payload.samples : [],
      mirroredAt: Date.now()
    }));
    fs.renameSync(tmp, target); // atomic on the same filesystem
    return true;
  } catch (_) {
    return false;
  }
}

function readMirrorFile(file) {
  const target = file || DEFAULT_MIRROR_FILE;
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!data || typeof data !== 'object') return null;
    return {
      network: data.network && typeof data.network === 'object' ? data.network : null,
      samples: Array.isArray(data.samples) ? data.samples : [],
      mirroredAt: numOrNull(data.mirroredAt)
    };
  } catch (_) {
    return null;
  }
}

function numOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function createVitalsStore(options) {
  const opts = options || {};
  const dir = opts.dir || process.env.ITC_VITALS_DIR || DEFAULT_DIR;

  let NedbCore;
  try {
    NedbCore = require('nedb-engine').NedbCore;
  } catch (e) {
    const err = new Error('nedb-engine is not installed (run npm install): ' + e.message);
    err.code = 'VITALS_UNAVAILABLE';
    throw err;
  }

  fs.mkdirSync(dir, { recursive: true });
  const db = NedbCore.open(dir);

  function readCollection(collection) {
    let rows;
    try {
      rows = db.nesql('SELECT * FROM ' + collection + ' ORDER BY _seq ASC');
    } catch (e) {
      return [];
    }
    const out = [];
    for (const raw of rows || []) {
      let doc;
      try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { continue; }
      if (!doc || doc._coll !== collection) continue;
      out.push(doc);
    }
    return out;
  }

  /* Sample ids are dense (s000001, s000002, …) — samples are never
     deleted, so the counter seeded from the highest existing id can
     never collide (same scheme as the chat store). */
  let counter = 0;
  for (const doc of readCollection(SAMPLES_COLLECTION)) {
    const n = /^s(\d+)$/.exec(doc._id || '');
    if (n) counter = Math.max(counter, parseInt(n[1], 10));
  }

  return {
    dir,

    /* Overwrite the cached network snapshot (start.js's poller calls
       this on every publish). The doc carries the snapshot's own
       updatedAt, so readers can show honestly how fresh it is. */
    writeNetwork(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      const doc = {
        available: snapshot.available === true,
        height: numOrNull(snapshot.height),
        peers: numOrNull(snapshot.peers),
        difficulty: snapshot.difficulty && typeof snapshot.difficulty === 'object' ? snapshot.difficulty : null,
        networkHashrate: snapshot.networkHashrate && typeof snapshot.networkHashrate === 'object' ? snapshot.networkHashrate : null,
        updatedAt: numOrNull(snapshot.updatedAt) || Date.now()
      };
      db.put(NETWORK_COLLECTION, NETWORK_ID, JSON.stringify(doc));
      return true;
    },

    readNetwork() {
      const docs = readCollection(NETWORK_COLLECTION);
      for (const doc of docs) {
        if (doc._id !== NETWORK_ID) continue;
        return {
          available: doc.available === true,
          height: numOrNull(doc.height),
          peers: numOrNull(doc.peers),
          difficulty: doc.difficulty && typeof doc.difficulty === 'object' ? doc.difficulty : null,
          networkHashrate: doc.networkHashrate && typeof doc.networkHashrate === 'object' ? doc.networkHashrate : null,
          updatedAt: numOrNull(doc.updatedAt)
        };
      }
      return null;
    },

    /* One hashrate sample: the pool's per-lane hashrates (from the
       stats collector) plus the chain height at sample time. */
    appendSample(sample) {
      if (!sample || typeof sample !== 'object') return false;
      counter += 1;
      const id = 's' + String(counter).padStart(6, '0');
      const doc = {
        t: numOrNull(sample.t) || Date.now(),
        height: numOrNull(sample.height),
        sha256: numOrNull(sample.sha256),
        yespower: numOrNull(sample.yespower),
        ethash: numOrNull(sample.ethash)
      };
      db.put(SAMPLES_COLLECTION, id, JSON.stringify(doc));
      return true;
    },

    /* Samples ascending by time. `since` (ms epoch) filters out
       older samples; `limit` keeps the most recent N (default and
       cap sized for chart seeding, not bulk export). */
    listSamples(options) {
      const o = options || {};
      const since = numOrNull(o.since);
      let limit = Number.isFinite(Number(o.limit)) && Number(o.limit) > 0 ? Number(o.limit) : 10000;
      limit = Math.min(limit, 50000);
      let out = readCollection(SAMPLES_COLLECTION).map((doc) => ({
        t: numOrNull(doc.t),
        height: numOrNull(doc.height),
        sha256: numOrNull(doc.sha256),
        yespower: numOrNull(doc.yespower),
        ethash: numOrNull(doc.ethash)
      })).filter((s) => s.t != null);
      if (since != null) out = out.filter((s) => s.t >= since);
      if (out.length > limit) out = out.slice(out.length - limit);
      return out;
    },

    status() {
      let verify = false;
      try { verify = db.verify(); } catch (_) { verify = false; }
      return {
        engine: 'nedb',
        head: db.head(),
        seq: Number(db.seq()),
        verify,
        samples: counter
      };
    }
  };
}

module.exports = { createVitalsStore, writeMirrorFile, readMirrorFile, DEFAULT_MIRROR_FILE };
