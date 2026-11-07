'use strict';
/*
 * envConfig.js -- environment-variable overrides for the pool config.
 *
 * Precedence (highest first):
 *   1. environment variables (real process env wins over the .env file)
 *   2. JSON config file (config/*.json, loaded by start.js)
 *   3. built-in defaults already encoded in start.js / the JSON examples
 *
 * start.js calls loadDotEnvFile() for a repo-root .env file (if one
 * exists) and then applyEnvOverrides(config, process.env). A variable
 * that is unset, or set to an empty / whitespace-only string, changes
 * nothing. A variable that is set to an invalid value (a non-numeric
 * port, an unknown scheme, ...) throws: a typo in an operator-facing
 * setting must fail loudly at boot, never fall back silently.
 *
 * LIVE-PAYMENTS SAFETY RULE: dry-run can only be turned OFF from the
 * environment by ITC_PAYMENTS_LIVE set to exactly "1". Every other
 * value ("true", "yes", "false", "0", anything) leaves dry-run as the
 * JSON config had it. In particular the string "false" is truthy in
 * JavaScript, so a naive Boolean(envValue) check would have enabled
 * live payments when an operator wrote the opposite; this module
 * never does that. ITC_PAYMENTS_DRY_RUN can only force dry-run ON
 * ("1" / "true" / "yes" / "on"); asking it for "false" is ignored,
 * by design: the only env path to live is ITC_PAYMENTS_LIVE=1.
 */

var fs = require('fs');

var ALGOS = ['sha256', 'yespower', 'ethash'];
var SCHEMES = ['solo', 'prop', 'pplns'];
var TRUTHY = ['1', 'true', 'yes', 'on'];
var FALSY = ['0', 'false', 'no', 'off'];

/* Every environment variable this module honours, grouped the same
   way as .env.example. Exported so tests and docs can count them. */
var ENV_VARS = [
    // Config file selection
    'ITC_POOL_CONFIG',
    // Daemon (single global daemon, the existing config shape)
    'ITC_DAEMON_HOST', 'ITC_DAEMON_PORT', 'ITC_DAEMON_USER', 'ITC_DAEMON_PASSWORD',
    // Wallets and branding
    'ITC_POOL_ADDRESS', 'ITC_POOL_NAME', 'ITC_COIN_NAME', 'ITC_COIN_SYMBOL', 'ITC_NETWORK',
    // Stratum and payout scheme, per algorithm
    'ITC_SHA256_ENABLED', 'ITC_SHA256_STRATUM_PORT', 'ITC_SHA256_SCHEME', 'ITC_SHA256_PPLNS_WINDOW', 'ITC_SHA256_DIFF',
    'ITC_YESPOWER_ENABLED', 'ITC_YESPOWER_STRATUM_PORT', 'ITC_YESPOWER_SCHEME', 'ITC_YESPOWER_PPLNS_WINDOW', 'ITC_YESPOWER_DIFF',
    'ITC_ETHASH_ENABLED', 'ITC_ETHASH_STRATUM_PORT', 'ITC_ETHASH_SCHEME', 'ITC_ETHASH_PPLNS_WINDOW', 'ITC_ETHASH_DIFF',
    // Payments processor
    'ITC_PAYMENTS_ENABLED', 'ITC_PAYMENTS_DRY_RUN', 'ITC_PAYMENTS_LIVE',
    'ITC_PAYMENTS_FEE_PERCENT', 'ITC_PAYMENTS_MIN_PAYOUT', 'ITC_PAYMENTS_CONFIRMATIONS',
    'ITC_PAYMENTS_INTERVAL_SECONDS', 'ITC_PAYMENTS_PPLNS_WINDOW', 'ITC_PAYMENTS_DATA_FILE',
    // Stats API
    'ITC_API_PORT', 'ITC_API_HOST',
    // Pool tuning
    'ITC_BLOCK_REFRESH_INTERVAL', 'ITC_JOB_REBROADCAST_TIMEOUT', 'ITC_CONNECTION_TIMEOUT'
];

function has(env, name) {
    return typeof env[name] === 'string' && env[name].trim() !== '';
}

function raw(env, name) { return env[name].trim(); }

function fail(name, value, why) {
    throw new Error('envConfig: ' + name + '=' + JSON.stringify(value) + ' is invalid: ' + why);
}

function parseBool(env, name) {
    var v = raw(env, name).toLowerCase();
    if (TRUTHY.indexOf(v) !== -1) return true;
    if (FALSY.indexOf(v) !== -1) return false;
    fail(name, env[name], 'expected one of 1/true/yes/on or 0/false/no/off');
}

function parseIntInRange(env, name, min, max) {
    var v = raw(env, name);
    if (!/^-?\d+$/.test(v)) fail(name, env[name], 'expected an integer');
    var n = parseInt(v, 10);
    if (n < min || n > max) fail(name, env[name], 'expected an integer between ' + min + ' and ' + max);
    return n;
}

function parsePort(env, name) { return parseIntInRange(env, name, 1, 65535); }

function parseNumber(env, name, min, exclusiveMin) {
    var n = Number(raw(env, name));
    if (!Number.isFinite(n)) fail(name, env[name], 'expected a number');
    if (exclusiveMin ? n <= min : n < min) {
        fail(name, env[name], 'expected a number ' + (exclusiveMin ? '> ' : '>= ') + min);
    }
    return n;
}

/* The live-payments gate. Only the exact string "1" (after trimming)
   counts as the explicit opt-in. Exported for the unit test. */
function isLiveEnabled(env) {
    return typeof env.ITC_PAYMENTS_LIVE === 'string' && env.ITC_PAYMENTS_LIVE.trim() === '1';
}

/* Minimal .env parser (no dependency): KEY=VALUE lines, blank lines,
   # comments, optional "export " prefix, optional single or double
   quotes around the value, inline comments after unquoted values are
   NOT stripped (a password may contain #). */
function parseDotEnv(content) {
    var out = {};
    String(content).split(/\r?\n/).forEach(function (line) {
        var s = line.trim();
        if (!s || s.charAt(0) === '#') return;
        if (s.indexOf('export ') === 0) s = s.slice('export '.length).trim();
        var eq = s.indexOf('=');
        if (eq === -1) return;
        var key = s.slice(0, eq).trim();
        var value = s.slice(eq + 1).trim();
        if (value.length >= 2) {
            var first = value.charAt(0), last = value.charAt(value.length - 1);
            if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                value = value.slice(1, -1);
            }
        }
        if (key) out[key] = value;
    });
    return out;
}

/* Load a .env file into a target env object (process.env by default)
   WITHOUT overriding variables already present: the real environment
   outranks the file. Returns the parsed object, or {} when no file. */
function loadDotEnvFile(filePath, target) {
    var parsed = {};
    try {
        parsed = parseDotEnv(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        if (e && e.code !== 'ENOENT') throw e;
        return {};
    }
    var env = target || process.env;
    Object.keys(parsed).forEach(function (key) {
        if (typeof env[key] === 'undefined') env[key] = parsed[key];
    });
    return parsed;
}

function algoEntry(config, algo) {
    if (!config.algos || typeof config.algos !== 'object') config.algos = {};
    if (Array.isArray(config.algos)) {
        for (var i = 0; i < config.algos.length; i++) {
            var e = config.algos[i];
            if (e && (e.algorithm === algo || e.algo === algo)) return e;
        }
        var created = { algorithm: algo };
        config.algos.push(created);
        return created;
    }
    if (!config.algos[algo] || typeof config.algos[algo] !== 'object') config.algos[algo] = {};
    return config.algos[algo];
}

function applyEnvOverrides(config, env) {
    env = env || process.env;
    config = config || {};

    // Daemon (global). Applied to the single "daemon" object and, when
    // a "daemons" array is used instead, to every entry in it.
    var daemonTargets = [];
    if (config.daemon && typeof config.daemon === 'object') daemonTargets.push(config.daemon);
    if (Array.isArray(config.daemons)) {
        config.daemons.forEach(function (d) { if (d && typeof d === 'object') daemonTargets.push(d); });
    }
    if (daemonTargets.length === 0 && (has(env, 'ITC_DAEMON_HOST') || has(env, 'ITC_DAEMON_PORT') ||
        has(env, 'ITC_DAEMON_USER') || has(env, 'ITC_DAEMON_PASSWORD'))) {
        config.daemon = {};
        daemonTargets.push(config.daemon);
    }
    daemonTargets.forEach(function (d) {
        if (has(env, 'ITC_DAEMON_HOST')) d.host = raw(env, 'ITC_DAEMON_HOST');
        if (has(env, 'ITC_DAEMON_PORT')) d.port = parsePort(env, 'ITC_DAEMON_PORT');
        if (has(env, 'ITC_DAEMON_USER')) d.user = raw(env, 'ITC_DAEMON_USER');
        if (has(env, 'ITC_DAEMON_PASSWORD')) d.password = raw(env, 'ITC_DAEMON_PASSWORD');
    });

    // Wallets and branding.
    if (has(env, 'ITC_POOL_ADDRESS')) config.address = raw(env, 'ITC_POOL_ADDRESS');
    if (has(env, 'ITC_POOL_NAME')) config.poolName = raw(env, 'ITC_POOL_NAME');
    if (has(env, 'ITC_COIN_NAME')) config.coinName = raw(env, 'ITC_COIN_NAME');
    if (has(env, 'ITC_COIN_SYMBOL')) config.coinSymbol = raw(env, 'ITC_COIN_SYMBOL');
    if (has(env, 'ITC_NETWORK')) config.network = raw(env, 'ITC_NETWORK');

    // Per-algorithm stratum, scheme, PPLNS window, starting diff.
    ALGOS.forEach(function (algo) {
        var prefix = 'ITC_' + algo.toUpperCase() + '_';
        var touched = ['ENABLED', 'STRATUM_PORT', 'SCHEME', 'PPLNS_WINDOW', 'DIFF']
            .some(function (suffix) { return has(env, prefix + suffix); });
        if (!touched) return;
        var entry = algoEntry(config, algo);
        if (has(env, prefix + 'ENABLED')) entry.enabled = parseBool(env, prefix + 'ENABLED');
        if (has(env, prefix + 'STRATUM_PORT')) entry.stratumPort = parsePort(env, prefix + 'STRATUM_PORT');
        if (has(env, prefix + 'SCHEME')) {
            var scheme = raw(env, prefix + 'SCHEME').toLowerCase();
            if (SCHEMES.indexOf(scheme) === -1) {
                fail(prefix + 'SCHEME', env[prefix + 'SCHEME'], 'expected one of ' + SCHEMES.join('/'));
            }
            entry.scheme = scheme;
        }
        if (has(env, prefix + 'PPLNS_WINDOW')) entry.pplnsWindow = parseIntInRange(env, prefix + 'PPLNS_WINDOW', 1, Number.MAX_SAFE_INTEGER);
        if (has(env, prefix + 'DIFF')) entry.diff = parseNumber(env, prefix + 'DIFF', 0, true);
    });

    // Payments processor.
    var payTouched = ENV_VARS.slice(ENV_VARS.indexOf('ITC_PAYMENTS_ENABLED'), ENV_VARS.indexOf('ITC_API_PORT'))
        .some(function (name) { return has(env, name); });
    if (payTouched) {
        if (!config.payments || typeof config.payments !== 'object') config.payments = {};
        var p = config.payments;
        if (has(env, 'ITC_PAYMENTS_ENABLED')) p.enabled = parseBool(env, 'ITC_PAYMENTS_ENABLED');
        if (has(env, 'ITC_PAYMENTS_FEE_PERCENT')) p.feePercent = parseNumber(env, 'ITC_PAYMENTS_FEE_PERCENT', 0, false);
        if (has(env, 'ITC_PAYMENTS_MIN_PAYOUT')) p.minPayout = parseNumber(env, 'ITC_PAYMENTS_MIN_PAYOUT', 0, false);
        if (has(env, 'ITC_PAYMENTS_CONFIRMATIONS')) p.confirmations = parseIntInRange(env, 'ITC_PAYMENTS_CONFIRMATIONS', 0, Number.MAX_SAFE_INTEGER);
        if (has(env, 'ITC_PAYMENTS_INTERVAL_SECONDS')) p.intervalSeconds = parseIntInRange(env, 'ITC_PAYMENTS_INTERVAL_SECONDS', 1, Number.MAX_SAFE_INTEGER);
        if (has(env, 'ITC_PAYMENTS_PPLNS_WINDOW')) p.pplnsWindow = parseIntInRange(env, 'ITC_PAYMENTS_PPLNS_WINDOW', 1, Number.MAX_SAFE_INTEGER);
        if (has(env, 'ITC_PAYMENTS_DATA_FILE')) p.dataFile = raw(env, 'ITC_PAYMENTS_DATA_FILE');
        // Dry-run / live, safety rule first (see header comment):
        if (isLiveEnabled(env)) {
            p.dryRun = false;
        } else if (has(env, 'ITC_PAYMENTS_DRY_RUN') && parseBool(env, 'ITC_PAYMENTS_DRY_RUN') === true) {
            p.dryRun = true;
        }
        // ITC_PAYMENTS_LIVE set to anything but "1", and
        // ITC_PAYMENTS_DRY_RUN=false, deliberately change nothing.
    }

    // Stats API.
    if (has(env, 'ITC_API_PORT') || has(env, 'ITC_API_HOST')) {
        if (!config.api || typeof config.api !== 'object') config.api = {};
        if (has(env, 'ITC_API_PORT')) config.api.port = parsePort(env, 'ITC_API_PORT');
        if (has(env, 'ITC_API_HOST')) config.api.host = raw(env, 'ITC_API_HOST');
    }

    // Pool tuning.
    if (has(env, 'ITC_BLOCK_REFRESH_INTERVAL')) config.blockRefreshInterval = parseIntInRange(env, 'ITC_BLOCK_REFRESH_INTERVAL', 1, Number.MAX_SAFE_INTEGER);
    if (has(env, 'ITC_JOB_REBROADCAST_TIMEOUT')) config.jobRebroadcastTimeout = parseIntInRange(env, 'ITC_JOB_REBROADCAST_TIMEOUT', 1, Number.MAX_SAFE_INTEGER);
    if (has(env, 'ITC_CONNECTION_TIMEOUT')) config.connectionTimeout = parseIntInRange(env, 'ITC_CONNECTION_TIMEOUT', 1, Number.MAX_SAFE_INTEGER);

    return config;
}

module.exports = {
    ENV_VARS: ENV_VARS,
    ALGOS: ALGOS,
    applyEnvOverrides: applyEnvOverrides,
    parseDotEnv: parseDotEnv,
    loadDotEnvFile: loadDotEnvFile,
    isLiveEnabled: isLiveEnabled,
    parseBool: parseBool
};
