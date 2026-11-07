'use strict';
/*
 * Interchained (ITC) tri-PoW solo mining pool - entry point.
 *
 * Boots THREE stratum pool instances from one config file, one per PoW
 * algorithm, all talking to the same Interchained daemon:
 *
 *     sha256    stratum port 3333
 *     yespower  stratum port 3334
 *     ethash    stratum port 3335
 *
 * Solo mining only: there are no accounts, no shares ledger and no pool
 * fee. A block's coinbase pays the payout address directly - the miner
 * connects with that address as its stratum username, and the same address
 * is configured as the pool's `address` (see config/README.md).
 *
 * Usage:
 *     node start.js [path/to/config.json]
 *     ITC_POOL_CONFIG=path/to/config.json node start.js
 *
 * Default config: config/interchained-mainnet.json
 */

var fs = require('fs');
var path = require('path');

var stratumPool = require('./lib/index.js');

/* Stratum ports from the shared tri-PoW contract. A config file may
   override them, but these are the defaults when it does not. */
var DEFAULT_STRATUM_PORTS = {
    sha256: 3333,
    yespower: 3334,
    ethash: 3335
};

var SUPPORTED_ALGOS = Object.keys(DEFAULT_STRATUM_PORTS);

function loadConfig(configPath) {
    var resolved = configPath
        ? path.resolve(configPath)
        : path.join(__dirname, 'config', 'interchained-mainnet.json');
    var raw = fs.readFileSync(resolved, 'utf8');
    var config = JSON.parse(raw);
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

    var ports = {};
    var portConfig = { diff: entry.diff };
    if (entry.varDiff) portConfig.varDiff = entry.varDiff;
    ports[String(stratumPort)] = portConfig;

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

        /* Solo payout address. Set this (in the config) to the same ITC
           address miners connect with as their username. */
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

function main() {
    var configPath = process.argv[2] || process.env.ITC_POOL_CONFIG;
    var config = loadConfig(configPath);

    console.log('Interchained tri-PoW solo pool');
    console.log('config: ' + config.__path);

    if (!config.address && !config.poolAddress) {
        console.error('ERROR: no payout address in config - set "address" to your ITC address ' +
            '(the same address miners use as their stratum username).');
        process.exit(1);
    }

    var pools = createPools(config);
    if (pools.length === 0) {
        console.error('ERROR: no pools could be created - nothing to run.');
        process.exit(1);
    }

    pools.forEach(function (pool) { pool.start(); });
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
    DEFAULT_STRATUM_PORTS: DEFAULT_STRATUM_PORTS
};
