'use strict';
/*
 * Interchained tri-PoW solo pool - stats/API + dashboard static server.
 *
 * Zero dependencies: Node.js builtins only (http, fs, path, url).
 * Standalone:  node api/server.js        (PORT env override, default 8080)
 * In-process:  const { createServer, StatsCollector } = require('./server');
 *              const collector = new StatsCollector();
 *              collector.attach(poolInstance, 'sha256'); // per algo
 *              createServer({ collector }).listen(8080);
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const StatsCollector = require('./collector');

const ALGOS = ['sha256', 'yespower', 'ethash'];
const STRATUM_PORTS = { sha256: 3333, yespower: 3334, ethash: 3335 };
const DEFAULT_PORT = 8080;
const DEFAULT_UI_DIR = path.join(__dirname, '..', 'ui');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PLACEHOLDER_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Interchained Pool</title></head><body>',
  '<h1>Interchained tri-PoW Pool</h1>',
  '<p>The dashboard is not built yet. The stats API is live at ' +
    '<a href="/api/stats">/api/stats</a>.</p>',
  '</body></html>',
  '',
].join('\n');

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function configPayload() {
  const algos = {};
  const algoList = [];
  for (const algo of ALGOS) {
    algos[algo] = { algo, stratumPort: STRATUM_PORTS[algo] };
    algoList.push({ algo, stratumPort: STRATUM_PORTS[algo] });
  }
  return {
    solo: true,
    coin: 'Interchained (ITC)',
    algos,
    algoList,
    stratumPorts: Object.assign({}, STRATUM_PORTS),
  };
}

/**
 * createServer([options | collector])
 * @param {object} [options]
 * @param {StatsCollector} [options.collector] shared collector (a fresh one
 *        is created when omitted)
 * @param {string} [options.uiDir] static root (default: ../ui)
 * @param {string|null} [options.dataFile] forwarded to a fresh collector
 * Returns an http.Server that is NOT yet listening.
 * Passing a StatsCollector directly as the argument also works.
 */
function createServer(options) {
  let opts = options || {};
  if (opts && typeof opts.recordShare === 'function' && typeof opts.getStats === 'function') {
    opts = { collector: opts };
  }
  const collector =
    opts.collector || new StatsCollector({ dataFile: opts.dataFile });
  const uiDir = opts.uiDir || DEFAULT_UI_DIR;

  const server = http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch (_) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    const pathname = parsed.pathname;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // ------------------------------------------------------------ JSON API
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/stats') {
      sendJson(res, 200, collector.getStats());
      return;
    }
    if (pathname === '/api/blocks') {
      const limit = parsed.searchParams.get('limit');
      sendJson(res, 200, collector.getBlocks(limit ? Number(limit) : undefined));
      return;
    }
    if (pathname === '/api/workers') {
      sendJson(res, 200, collector.getWorkers());
      return;
    }
    if (pathname === '/api/config') {
      sendJson(res, 200, configPayload());
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // -------------------------------------------------------------- static
    serveStatic(req, res, uiDir, pathname);
  });

  // Exposed for integration/tests: the collector this server reports on.
  server.collector = collector;
  return server;
}

function serveStatic(req, res, uiDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const uiRoot = path.resolve(uiDir);
  const filePath = path.resolve(uiRoot, rel);

  // Path traversal guard: the resolved path must stay inside ui/.
  if (filePath !== uiRoot && !filePath.startsWith(uiRoot + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (rel === 'index.html') {
        // No built dashboard (yet): built-in placeholder, still a 200 so
        // a browser landing on / sees a page, not an error.
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end();
        } else {
          sendHtml(res, 200, PLACEHOLDER_HTML);
        }
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const type =
      CONTENT_TYPES[path.extname(filePath).toLowerCase()] ||
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) sendJson(res, 500, { error: 'read error' });
      else res.destroy();
    });
    stream.pipe(res);
  });
}

module.exports = { createServer, StatsCollector };

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const collector = new StatsCollector();
  const server = createServer({ collector });
  server.listen(port, () => {
    console.log(
      'ITC pool stats/API listening on port ' + port +
        ' (standalone collector, no pools attached - zeros are correct)'
    );
  });
  const shutdown = () => {
    try { collector.flush(); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
