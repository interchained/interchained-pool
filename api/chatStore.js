'use strict';
/*
 * Pool chat store — NEDB embedded (nedb-engine, Mark's engine).
 *
 * Chat history lives in a dedicated NEDB v2 DAG at <dir>: every
 * message is a `put` into the `chat` collection, so the whole
 * conversation is a hash-chained, verify()-able journal with
 * provenance (_seq / _hash on every record) — the same write the
 * browser replica replays through nedb-wasm to land on the
 * identical Merkle head.
 *
 * Reads use neSQL (`SELECT * FROM chat ORDER BY _seq`), which is
 * the engine's front door and stays correct across restarts;
 * since() catch-up is only trusted inside the writing process.
 *
 * The engine is required lazily: if nedb-engine is not installed,
 * createChatStore throws a CHAT_UNAVAILABLE error and the API
 * server answers 503 for chat only — the pool never depends on it.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'data', 'chat-nedb');
const COLLECTION = 'chat';

function sanitizeText(value, max) {
  if (typeof value !== 'string') return '';
  // Strip control characters (keep it a chat line, not a payload).
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 9 || (c >= 32 && c !== 127)) out += value[i];
  }
  return out.trim().slice(0, max);
}

function createChatStore(options) {
  const opts = options || {};
  const dir = opts.dir || process.env.ITC_CHAT_DIR || DEFAULT_DIR;

  let NedbCore;
  try {
    NedbCore = require('nedb-engine').NedbCore;
  } catch (e) {
    const err = new Error('nedb-engine is not installed (run npm install): ' + e.message);
    err.code = 'CHAT_UNAVAILABLE';
    throw err;
  }

  fs.mkdirSync(dir, { recursive: true });
  const db = NedbCore.open(dir);

  function allMessages() {
    let rows;
    try {
      rows = db.nesql('SELECT * FROM ' + COLLECTION + ' ORDER BY _seq ASC');
    } catch (e) {
      return [];
    }
    const out = [];
    for (const raw of rows || []) {
      let doc;
      try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { continue; }
      if (!doc || doc._coll !== COLLECTION) continue;
      out.push({
        id: doc._id,
        author: doc.author,
        text: doc.text,
        ts: doc.ts,
        seq: doc._seq,
        hash: doc._hash
      });
    }
    return out;
  }

  /* Message ids are dense (m000001, m000002, …) — chat never
     deletes, so the counter seeded from the highest existing id
     can never collide. */
  let counter = 0;
  for (const m of allMessages()) {
    const n = /^m(\d+)$/.exec(m.id || '');
    if (n) counter = Math.max(counter, parseInt(n[1], 10));
  }

  return {
    dir,

    post(author, text) {
      const cleanAuthor = sanitizeText(author, 42) || 'guest';
      const cleanText = sanitizeText(text, 500);
      if (!cleanText) {
        const err = new Error('empty message');
        err.code = 'CHAT_BAD_MESSAGE';
        throw err;
      }
      counter += 1;
      const id = 'm' + String(counter).padStart(6, '0');
      const ts = Date.now();
      /* Canonical doc: this exact key order is what the browser
         replica replays, so both engines seal identical bytes. */
      const docJson = JSON.stringify({ author: cleanAuthor, text: cleanText, ts });
      const stored = JSON.parse(db.put(COLLECTION, id, docJson));
      return { id, author: cleanAuthor, text: cleanText, ts, seq: stored._seq, hash: stored._hash };
    },

    list(limit) {
      const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 120;
      const all = allMessages();
      return all.slice(Math.max(0, all.length - n));
    },

    status() {
      let verify = false;
      try { verify = db.verify(); } catch (_) { verify = false; }
      return {
        engine: 'nedb',
        head: db.head(),
        seq: Number(db.seq()),
        verify,
        count: counter
      };
    }
  };
}

module.exports = { createChatStore, DEFAULT_DIR };
