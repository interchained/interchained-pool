'use strict';
/*
 * Interchained (ITC) tri-PoW mining pool - entry point.
 *
 * Boots THREE pool instances from one config file, one per PoW
 * algorithm, all talking to the same Interchained daemon:
 *
 *     sha256    stratum port 3333 (classic stratum)
 *     yespower  stratum port 3334 (classic stratum)
 *     ethash    stratum port 3335 (Ethash stratum dialect,
 *               lib/ethash/ethashPool.js -- the classic protocol cannot
 *               express Ethash shares, so the ethash instance runs with
 *               no classic ports and the adapter serves the port)
 *
 * Payout schemes are per-algo ("scheme" in each algo's config entry):
 *   solo  - no ledger, no fee: the block coinbase pays the configured
 *           `address` directly (phase-1 behaviour).
 *   prop  - group mode: rewards split over the shares of the current
 *           round (since the previous block of that algo).
 *   pplns - group mode: rewards split over the last N shares.
 * Group modes need the top-level "payments" config enabled: shares and
 * blocks are recorded to a JSON ledger (default api/data/payouts.json)
 * and a processor pays matured rewards out as PSBTs from the pool
 * wallet (dry-run by default -- see lib/payouts/payments.js and
 * docs/SETUP.md). In group modes the coinbase pays the configured
 * `address` (the pool wallet) and miners connect with THEIR OWN
 * address as stratum username -- that address is their payout address.
 *
 * Usage:
 *     node start.js [path/to/config.json]
 *     ITC_POOL_CONFIG=path/to/config.json node start.js
 *
 * Default config: config/interchained-mainnet.json
 *
 * Environment overrides: a repo-root .env file (copy .env.example) is
 * loaded when present, and ITC_* variables layer over the JSON config.
 * Precedence: environment > JSON config > built-in default. The full
 * variable list and rules live in lib/envConfig.js and .env.example.
 * Live payments require the explicit opt-in ITC_PAYMENTS_LIVE=1; no
 * other env value can turn dry-run off.
 */

var fs = require('fs');
var path = require('path');

var stratumPool = require('./lib/index.js');
var daemonModule = require('./lib/daemon.js');
var payoutsLedger = require('./lib/payouts/ledger.js');
var payoutsStorePath = require('./lib/payouts/storePath.js');
var payoutsAttach = require('./lib/payouts/attach.js');
var paymentsModule = require('./lib/payouts/payments.js');
var ethashPool = require('./lib/ethash/ethashPool.js');
var envConfig = require('./lib/envConfig.js');

/* Stratum ports from the shared tri-PoW contract. A config file may
   override them, but these are the defaults when it does not. */
var DEFAULT_STRATUM_PORTS = {
    sha256: 3333,
    yespower: 3334,
    ethash: 3335
};

var SUPPORTED_ALGOS = Object.keys(DEFAULT_STRATUM_PORTS);

function loadConfig(configPath, env) {
    /* .env first (real env outranks the file), so ITC_POOL_CONFIG may
       itself come from the .env file. Env overrides then layer over
       the JSON config: env > JSON > built-in default. */
    envConfig.loadDotEnvFile(path.join(__dirname, '.env'), process.env);
    var effectiveEnv = env || process.env;
    var resolved = configPath
        ? path.resolve(configPath)
        : (effectiveEnv.ITC_POOL_CONFIG
            ? path.resolve(effectiveEnv.ITC_POOL_CONFIG)
            : path.join(__dirname, 'config', 'interchained-mainnet.json'));
    var raw = fs.readFileSync(resolved, 'utf8');
    var config = JSON.parse(raw);
    envConfig.applyEnvOverrides(config, effectiveEnv);
    config.__path = resolved;
    return config;
}

/* Normalise the config's per-algo section into a list of
   { algorithm, stratumPort, diff, varDiff, enabled } entries.
   Accepts either a map:  "algos": { "sha256": { "stratumPort": 3333, ... } }
   or a list:             "algos": [ { "algorithm": "sha256", ... } ]      */
function algoEntries(config) {
    var entries = [];
    var algos = config.algos || config.algorithms || {};

    if (Array.isArray(algos)) {
        algos.forEach(function (entry) {
            if (entry && (entry.algorithm || entry.algo)) entries.push(entry);
        });
    } else {
        Object.keys(algos).forEach(function (name) {
            var entry = algos[name] || {};
            entry.algorithm = entry.algorithm || entry.algo || name;
            entries.push(entry);
        });
    }

    /* Anything not configured still gets its contract port, disabled only
       if the config explicitly says so. With no algos section at all, all
       three algorithms are enabled on their contract ports. */
    if (entries.length === 0) {
        return SUPPORTED_ALGOS.map(function (algorithm) {
            return { algorithm: algorithm };
        });
    }
    return entries;
}

function daemonList(config) {
    if (Array.isArray(config.daemons) && config.daemons.length > 0) {
        return config.daemons.map(function (d) {
            return {
                host: d.host || '127.0.0.1',
                port: d.port || 8332,
                user: d.user || '',
                password: d.password || ''
            };
        });
    }
    var d = config.daemon || {};
    return [{
        host: d.host || '127.0.0.1',
        port: d.port || 8332,
        user: d.user || '',
        password: d.password || ''
    }];
}

/*
 * Stratum authorization for solo mining.
 *
 * The worker username IS the payout address: a miner authorizes with its
 * own ITC address (an optional ".worker" suffix is stripped) and a found
 * block pays that address. Deliberately light validation - any non-empty
 * username is accepted, per the solo design; the daemon itself validates
 * the configured payout address at pool start-up (validateaddress).
 */
function authorizeFn(ip, port, workerName, password, callback) {
    var username = (typeof workerName === 'string') ? workerName.trim() : '';
    var payoutAddress = username.split('.')[0];

    if (!payoutAddress) {
        callback({
            error: [20, 'a payout address is required as the username', null],
            authorized: false,
            disconnect: false
        });
        return;
    }

    callback({
        error: null,
        authorized: true,
        disconnect: false
    });
}

function buildPoolOptions(config, entry) {
    var algorithm = entry.algorithm || entry.algo;
    var stratumPort = entry.stratumPort || entry.port || DEFAULT_STRATUM_PORTS[algorithm];

    /* The ethash instance configures NO classic stratum ports: its
       stratum is served by the Ethash adapter (attached in createPools
       once the pool has started and its JobManager exists), and lib/
       pool.js skips the classic server when ports is empty. */
    var ports = {};
    if (algorithm !== 'ethash') {
        var portConfig = { diff: entry.diff };
        if (entry.varDiff) portConfig.varDiff = entry.varDiff;
        ports[String(stratumPort)] = portConfig;
    }

    return {
        coin: {
            name: config.coinName || 'Interchained',
            symbol: config.coinSymbol || 'ITC',
            algorithm: algorithm,
            reward: 'POW',
            txMessages: false
            /* hasGetInfo intentionally unset: the Interchained daemon
               (Bitcoin 0.21-derived) serves getblockchaininfo /
               getnetworkinfo, which is the code path pool.js then uses. */
        },

        /* Payout scheme for this algo, read by lib/payouts/attach.js
           (resolveScheme) when the payments ledger is attached. In
           group modes (prop/pplns) this entry may also carry
           pplnsWindow. */
        payments: {
            scheme: entry.scheme || 'solo',
            pplnsWindow: entry.pplnsWindow
        },

        /* Port the Ethash stratum adapter binds for the ethash pool. */
        ethashStratumPort: (algorithm === 'ethash') ? stratumPort : undefined,

        /* Payout address. Solo: the ITC address miners connect with as
           their username. Group modes: the POOL wallet address (the
           coinbase pays the pool; the payments processor pays miners
           from this wallet as PSBTs). */
        address: config.address || config.poolAddress,

        /* Interchained submits blocks with `submitblock <hex>` - force it
           so the getblocktemplate-proposal submit fallback is never used. */
        hasSubmitMethod: true,

        /* Solo: no fee, the whole coinbase goes to the payout address. */
        rewardRecipients: {},

        blockRefreshInterval: (typeof config.blockRefreshInterval === 'number')
            ? config.blockRefreshInterval : 1000,
        jobRebroadcastTimeout: (typeof config.jobRebroadcastTimeout === 'number')
            ? config.jobRebroadcastTimeout : 55,
        connectionTimeout: (typeof config.connectionTimeout === 'number')
            ? config.connectionTimeout : 600,
        /* Ethash stratum keepalive heartbeat (ms): the adapter re-sends
           the current job to silent miners at this cadence so their
           connections never sit idle. Only the Ethash adapter reads
           this; the classic lanes have the 55s rebroadcast chain. */
        heartbeatIntervalMs: (typeof config.heartbeatIntervalMs === 'number')
            ? config.heartbeatIntervalMs : 30000,
        emitInvalidBlockHashes: false,
        tcpProxyProtocol: false,

        banning: config.banning || {
            enabled: true,
            time: 600,
            invalidPercent: 50,
            checkThreshold: 500,
            purgeInterval: 300
        },

        ports: ports,
        daemons: daemonList(config),

        /* Block notifications come from RPC polling (blockRefreshInterval);
           the p2p peer interface stays off. */
        p2p: { enabled: false }
    };
}

/* Optional stats collector (built by another lane as api/collector.js,
   stats API on port 8080). It is not present in every checkout, so the
   require is defensive: a missing or differently-shaped collector must
   never stop the pools from starting. */
var collectorInstance = null;
function loadCollector() {
    if (collectorInstance) return collectorInstance;
    try {
        var mod = require('./api/collector.js');
        /* api/collector.js exports the StatsCollector class (also as
           .StatsCollector); instantiate one shared collector so all
           three pools feed the same stats state. */
        var Ctor = (mod && mod.StatsCollector) || mod;
        if (typeof Ctor === 'function' && Ctor.prototype && typeof Ctor.prototype.attach === 'function') {
            collectorInstance = new Ctor();
        } else {
            collectorInstance = mod; // instance-shaped export
        }
        return collectorInstance;
    } catch (e) {
        if (e && e.code !== 'MODULE_NOT_FOUND') {
            console.error('[collector] api/collector.js failed to load: ' + e.message);
        }
        return null;
    }
}

function attachCollector(collector, pool, algorithm) {
    if (!collector) return;
    try {
        if (typeof collector.attach === 'function') {
            collector.attach(pool, algorithm);
        } else if (typeof collector === 'function') {
            collector(pool, algorithm);
        } else if (typeof collector.createCollector === 'function') {
            var instance = collector.createCollector(algorithm);
            if (instance && typeof instance.attach === 'function') instance.attach(pool);
        } else if (typeof collector.start === 'function') {
            collector.start(pool, algorithm);
        } else {
            console.error('[collector] api/collector.js has no attach/function/start export - skipping');
            return;
        }
        console.log('[collector] attached to ' + algorithm + ' pool');
    } catch (e) {
        console.error('[collector] failed to attach to ' + algorithm + ' pool: ' + e.message);
    }
}

function createPools(config) {
    var collector = loadCollector();
    var pools = [];

    algoEntries(config).forEach(function (entry) {
        var algorithm = entry.algorithm || entry.algo;

        if (SUPPORTED_ALGOS.indexOf(algorithm) === -1) {
            console.error('[pool] skipping unsupported algorithm in config: ' + algorithm);
            return;
        }
        if (entry.enabled === false) {
            console.log('[pool] ' + algorithm + ' disabled in config - skipping');
            return;
        }

        var pool;
        try {
            pool = stratumPool.createPool(buildPoolOptions(config, entry), authorizeFn);
        } catch (e) {
            /* e.g. the algorithm is not (yet) present in
               lib/algoProperties.js - keep the other pools running. */
            console.error('[pool] could not create ' + algorithm + ' pool: ' + e.message);
            return;
        }
        pool.poolAlgo = algorithm;

        if (algorithm === 'ethash') {
            /* The Ethash adapter needs pool.jobManager and pool.daemon,
               which only exist once the pool has started; attach on the
               pool's 'started' event (the adapter immediately feeds the
               then-current job, so no template is missed). */
            pool.on('started', function () {
                try {
                    pool.ethashAdapter = ethashPool.attachEthash(pool, {
                        port: pool.options.ethashStratumPort,
                        heartbeatIntervalMs: pool.options.heartbeatIntervalMs,
                        authorizeFn: authorizeFn,
                        logger: function (severity, text) {
                            console.log('[ethash] ' + severity + ': ' + text);
                        }
                    });
                    console.log('[ethash] Ethash stratum adapter listening on port ' +
                        pool.options.ethashStratumPort);
                } catch (e2) {
                    console.error('[ethash] could not attach Ethash stratum adapter: ' + e2.message);
                }
            });
        }

        pool.on('share', function (isValidShare, isValidBlock, data) {
            var kind = isValidBlock ? 'BLOCK FOUND' : (isValidShare ? 'valid share' : 'invalid share');
            console.log('[' + algorithm + '] share: ' + kind + ' ' + JSON.stringify(data));
        });

        pool.on('log', function (severity, logText, maybeText) {
            var text = (typeof maybeText !== 'undefined') ? maybeText : logText;
            console.log('[' + algorithm + '] ' + severity + ': ' + text);
        });

        attachCollector(collector, pool, algorithm);
        pools.push(pool);
    });

    return pools;
}

/* Phase 2: group payouts + the accounting ledger.
 *
 * RECORDING IS ALWAYS ON: every pool (solo included) is wired into
 * one shared JSON ledger, because the ledger is the pool's accounting
 * record -- attach.js documents shares/blocks being recorded "for
 * accounting/stats for every scheme, solo included", and the fairness
 * surface (/api/breakdowns, /api/reconcile) reads this store. The
 * PSBT payments processor (the part that moves money) stays opt-in
 * via payments.enabled.
 *
 * This split matters: recording used to be gated behind
 * payments.enabled together with the processor, so a solo pool with
 * payments disabled -- the shipped default in
 * config/interchained-mainnet.json -- recorded NOTHING at all. Found
 * blocks never reached the store and /api/breakdowns stayed []
 * forever; the gap first became visible live with the Ethash block
 * at height 914572 (2026-11-09), the pool's first found block, which
 * the daemon accepted but the store never saw. */
function setupPayments(config, pools) {
    var payCfg = config.payments || {};

    var schemesMap = {};
    algoEntries(config).forEach(function (entry) {
        var a = entry.algorithm || entry.algo;
        schemesMap[a] = {
            scheme: entry.scheme || 'solo',
            pplnsWindow: (typeof entry.pplnsWindow === 'number') ? entry.pplnsWindow
                : (typeof payCfg.pplnsWindow === 'number' ? payCfg.pplnsWindow : undefined)
        };
    });

    /* One resolver for writer and readers alike (lib/payouts/storePath.js):
       the ledger must land in the file every API server reads. */
    var dataFile = payoutsStorePath.resolvePayoutsStorePath({ config: config, env: process.env });
    var ledger = new payoutsLedger.Ledger({ dataFile: dataFile });

    pools.forEach(function (pool) {
        payoutsAttach.attachPayouts(pool, pool.poolAlgo, ledger, { schemes: schemesMap });
    });

    if (!payCfg.enabled) {
        console.log('[payments] ledger recording attached to ' + pools.length +
            ' pool(s) at ' + dataFile + ' (all schemes, solo included); ' +
            'PSBT processor disabled (payments.enabled is false)');
        return { ledger: ledger, processor: null, daemon: null };
    }

    var daemon = new daemonModule.interface(daemonList(config), function (severity, message) {
        console.log('[payments] ' + severity + ': ' + message);
    });
    daemon.init();

    var processor = paymentsModule.createPaymentsProcessor({
        daemon: daemon,
        ledger: ledger,
        config: {
            enabled: true,
            dryRun: payCfg.dryRun,
            feePercent: payCfg.feePercent,
            minPayout: payCfg.minPayout,
            confirmations: payCfg.confirmations,
            intervalSeconds: payCfg.intervalSeconds,
            schemes: schemesMap
        },
        logger: function (severity, message) { console.log(severity + ': ' + message); }
    });
    processor.start();
    console.log('[payments] ledger at ' + dataFile + '; PSBT processor started ' +
        '(dryRun=' + processor.config.dryRun + ', fee=' + processor.config.feePercent +
        '%, minPayout=' + payCfg.minPayout + ' ITC, confirmations=' + processor.config.confirmations +
        ', schemes=' + JSON.stringify(schemesMap) + ')');
    return { ledger: ledger, processor: processor, daemon: daemon };
}

/* Stats API + dashboard, served IN-PROCESS by the pool itself.
 * The collector is a singleton (loadCollector caches it), so the
 * API reads the exact live state the stratum pools are feeding:
 * hashrate, workers, shares and session blocks. Running
 * api/server.js standalone instead shows an empty collector —
 * that process has no pools attached. Port: config.api.port,
 * else ITC_API_PORT, else 8080. A busy port (e.g. the standalone
 * server still running) logs a warning and never stops the pools. */
/* Build the dashboard's network snapshot from a daemon getmininginfo
   response plus the peer count from getnetworkinfo. Pure and exported
   for tests: the field names are the daemon's own (src/rpc/mining.cpp)
   — difficulty_<algo> / networkhashps_<algo> exist ONLY on
   getmininginfo, never on getblockchaininfo. Returns null until the
   daemon has answered with a numeric block height. */
function buildNetworkSnapshot(info, peers) {
    if (!info || typeof info.blocks !== 'number') return null;
    var numOrNull = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : null; };
    return {
        available: true,
        height: info.blocks,
        peers: numOrNull(peers),
        difficulty: {
            sha256: numOrNull(info.difficulty_sha256),
            yespower: numOrNull(info.difficulty_yespower),
            ethash: numOrNull(info.difficulty_ethash)
        },
        networkHashrate: {
            total: numOrNull(info.networkhashps),
            sha256: numOrNull(info.networkhashps_sha256),
            yespower: numOrNull(info.networkhashps_yespower),
            ethash: numOrNull(info.networkhashps_ethash)
        },
        updatedAt: Date.now()
    };
}

function setupApiServer(config, collector) {
    if (!collector) return null;
    try {
        var api = require('./api/server.js');
        var port = (config.api && config.api.port) || Number(process.env.ITC_API_PORT) || 8080;
        var algosCfg = {};
        algoEntries(config).forEach(function (entry) {
            var a = entry.algorithm || entry.algo;
            algosCfg[a] = {
                stratumPort: entry.stratumPort || entry.port || DEFAULT_STRATUM_PORTS[a],
                scheme: entry.scheme || 'solo',
                pplnsWindow: entry.pplnsWindow
            };
        });
        var payCfg = config.payments || {};

        /* Vitals cache (NEDB): the pool process keeps the network
           snapshot and a 30 s hashrate sample series in the shared
           vitals store, so ANY server of the dashboard (this
           in-process API or the standalone one) can show the network
           panel and seed the charts with history — and both survive
           restarts. A missing engine degrades to no cache. */
        var vitalsModule = null;
        var vitalsStore = null;
        try {
            vitalsModule = require('./api/vitalsStore.js');
            vitalsStore = vitalsModule.createVitalsStore({});
        } catch (e) {
            console.error('[api] vitals cache unavailable: ' + e.message);
        }

        /* Mirror ring: the last 24 h of samples (30 s cadence) plus
           the latest network snapshot, mirrored to a JSON file that
           OTHER servers of the dashboard read — NEDB is
           single-opener, so they cannot open the store while this
           process holds it. Seeded from the store at boot. */
        var VITALS_RING_MAX = 2880;
        var vitalsRing = [];
        var lastMirroredHeight = null;
        if (vitalsStore) {
            try { vitalsRing = vitalsStore.listSamples({ limit: VITALS_RING_MAX }); }
            catch (e) { vitalsRing = []; }
        }
        var writeVitalsMirror = function () {
            if (!vitalsModule) return;
            try {
                vitalsModule.writeMirrorFile(null, {
                    network: networkSnapshot,
                    samples: vitalsRing
                });
                lastMirroredHeight = networkSnapshot ? networkSnapshot.height : null;
            } catch (e) { /* cache is best-effort */ }
        };

        /* Network vitals: poll the daemon and serve the TRI-POW
           fields (per-lane difficulty and hashrate). Those fields do
           NOT live on getblockchaininfo — the daemon serves them from
           getmininginfo (difficulty_<algo>, networkhashps_<algo>),
           and the peer count is getnetworkinfo's `connections`. The
           original wiring polled getblockchaininfo for all of them,
           so every lane rendered null forever while the height (the
           one field GBCI does carry) worked. */
        var networkSnapshot = null;
        try {
            var netDaemon = new daemonModule.interface(daemonList(config), function () {});
            netDaemon.init();
            var lastMiningInfo = null;
            var lastPeers = null;
            var publishNetwork = function () {
                var snap = buildNetworkSnapshot(lastMiningInfo, lastPeers);
                if (snap) {
                    networkSnapshot = snap;
                    if (vitalsStore) {
                        try { vitalsStore.writeNetwork(snap); } catch (e) { /* cache is best-effort */ }
                    }
                    if (snap.height !== lastMirroredHeight) writeVitalsMirror();
                }
            };
            var pollNetwork = function () {
                netDaemon.cmd('getmininginfo', [], function (results) {
                    var r = results && results[0];
                    if (r && r.response) { lastMiningInfo = r.response; publishNetwork(); }
                });
                netDaemon.cmd('getnetworkinfo', [], function (results) {
                    var r = results && results[0];
                    var info = r && r.response;
                    if (info && typeof info.connections === 'number') {
                        lastPeers = info.connections;
                        publishNetwork();
                    }
                });
            };
            pollNetwork();
            var netTimer = setInterval(pollNetwork, 15000);
            if (netTimer.unref) netTimer.unref();
        } catch (e) {
            console.error('[api] network stats poller failed: ' + e.message);
        }

        /* Hashrate sampler: one vitals sample every 30 s — the
           pool's per-lane hashrates plus the current chain height.
           This is the chain-health record the charts seed from. The
           sample lands in NEDB (when the store opened), in the
           mirror ring, and in the mirror file other servers read. */
        if (collector && typeof collector.getHashrate === 'function') {
            var takeSample = function () {
                var sample = {
                    t: Date.now(),
                    height: networkSnapshot ? networkSnapshot.height : null,
                    sha256: collector.getHashrate('sha256'),
                    yespower: collector.getHashrate('yespower'),
                    ethash: collector.getHashrate('ethash')
                };
                if (vitalsStore) {
                    try { vitalsStore.appendSample(sample); } catch (e) { /* best-effort */ }
                }
                vitalsRing.push(sample);
                while (vitalsRing.length > VITALS_RING_MAX) vitalsRing.shift();
                writeVitalsMirror();
            };
            takeSample();
            var sampleTimer = setInterval(takeSample, 30000);
            if (sampleTimer.unref) sampleTimer.unref();
        }

        var server = api.createServer({
            collector: collector,
            vitalsStore: vitalsStore,
            networkProvider: function () { return networkSnapshot; },
            poolConfig: {
                address: config.address || config.poolAddress,
                stratumHost: config.stratumHost || process.env.ITC_STRATUM_HOST || undefined,
                algos: algosCfg,
                payments: {
                    feePercent: payCfg.feePercent,
                    minPayout: payCfg.minPayout,
                    dryRun: payCfg.dryRun,
                    confirmations: payCfg.confirmations
                }
            },
            payoutsFile: payoutsStorePath.resolvePayoutsStorePath({ config: config, env: process.env })
        });
        server.on('error', function (e) {
            console.error('[api] could not listen on port ' + port + ': ' + e.message +
                ' — is the standalone api/server.js still running? Stop it; this process serves the dashboard now.');
        });
        server.listen(port, function () {
            console.log('[api] dashboard + live stats API on port ' + port + ' (in-process collector)');
        });
        return server;
    } catch (e) {
        console.error('[api] failed to start: ' + e.message);
        return null;
    }
}

function main() {
    var configPath = process.argv[2] || process.env.ITC_POOL_CONFIG;
    var config = loadConfig(configPath);

    console.log('Interchained tri-PoW pool (solo / PROP / PPLNS)');
    console.log('config: ' + config.__path);
    if (config.poolName) console.log('pool name: ' + config.poolName);

    if (!config.address && !config.poolAddress) {
        console.error('ERROR: no payout address in config - set "address" to your ITC address ' +
            '(solo: the address miners use as their stratum username; group modes: the pool wallet address).');
        process.exit(1);
    }

    var pools = createPools(config);
    if (pools.length === 0) {
        console.error('ERROR: no pools could be created - nothing to run.');
        process.exit(1);
    }

    pools.forEach(function (pool) { pool.start(); });
    setupPayments(config, pools);
    setupApiServer(config, loadCollector());
}

if (require.main === module) {
    main();
}

module.exports = {
    loadConfig: loadConfig,
    algoEntries: algoEntries,
    buildPoolOptions: buildPoolOptions,
    authorizeFn: authorizeFn,
    createPools: createPools,
    setupPayments: setupPayments,
    setupApiServer: setupApiServer,
    buildNetworkSnapshot: buildNetworkSnapshot,
    envConfig: envConfig,
    DEFAULT_STRATUM_PORTS: DEFAULT_STRATUM_PORTS
};
