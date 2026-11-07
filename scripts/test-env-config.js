'use strict';
/*
 * test-env-config.js -- unit proof for lib/envConfig.js.
 *
 * Proves:
 *   1. Precedence: env > JSON config > (values the JSON omits stay
 *      omitted, so start.js built-in defaults apply downstream).
 *   2. Every documented variable actually moves its config field.
 *   3. The live-payments safety rule: only ITC_PAYMENTS_LIVE=1 (exact)
 *      turns dry-run off. "false", "true", "yes", "0" and
 *      ITC_PAYMENTS_DRY_RUN=false all leave dry-run ON.
 *   4. Invalid values fail loudly (bad port, bad scheme, bad bool).
 *   5. .env parsing, and that the real env outranks a .env file.
 *   6. start.js loadConfig honours an injected env object.
 *
 * Run:  node scripts/test-env-config.js     (exit 0 = PASS)
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var envConfig = require('../lib/envConfig.js');
var start = require('../start.js');

var checks = 0;
function check(name, fn) {
    fn();
    checks++;
    console.log('PASS: ' + name);
}

function baseConfig() {
    return {
        network: 'mainnet',
        address: 'JSON_ADDRESS',
        coinName: 'Interchained',
        coinSymbol: 'ITC',
        daemon: { host: '127.0.0.1', port: 8332, user: 'jsonuser', password: 'jsonpass' },
        algos: {
            sha256: { enabled: true, stratumPort: 3333, scheme: 'solo', diff: 2048 },
            yespower: { enabled: true, stratumPort: 3334, scheme: 'solo', diff: 8 },
            ethash: { enabled: true, stratumPort: 3335, scheme: 'solo', diff: 512 }
        },
        payments: {
            enabled: false, dryRun: true, feePercent: 1, minPayout: 0.5,
            confirmations: 100, intervalSeconds: 600, pplnsWindow: 10000
        },
        api: { port: 8080 }
    };
}

check('no env: JSON config is untouched', function () {
    var cfg = envConfig.applyEnvOverrides(baseConfig(), {});
    assert.deepStrictEqual(cfg, baseConfig());
});

check('precedence: env beats JSON for daemon, wallet, ports, schemes', function () {
    var cfg = envConfig.applyEnvOverrides(baseConfig(), {
        ITC_DAEMON_HOST: '10.0.0.9', ITC_DAEMON_PORT: '18332',
        ITC_DAEMON_USER: 'envuser', ITC_DAEMON_PASSWORD: 'envpass',
        ITC_POOL_ADDRESS: 'ENV_ADDRESS', ITC_POOL_NAME: 'Env Pool',
        ITC_SHA256_STRATUM_PORT: '13333', ITC_YESPOWER_SCHEME: 'pplns',
        ITC_YESPOWER_PPLNS_WINDOW: '777', ITC_ETHASH_ENABLED: 'false',
        ITC_ETHASH_DIFF: '64'
    });
    assert.strictEqual(cfg.daemon.host, '10.0.0.9');
    assert.strictEqual(cfg.daemon.port, 18332);
    assert.strictEqual(cfg.daemon.user, 'envuser');
    assert.strictEqual(cfg.daemon.password, 'envpass');
    assert.strictEqual(cfg.address, 'ENV_ADDRESS');
    assert.strictEqual(cfg.poolName, 'Env Pool');
    assert.strictEqual(cfg.algos.sha256.stratumPort, 13333);
    assert.strictEqual(cfg.algos.yespower.scheme, 'pplns');
    assert.strictEqual(cfg.algos.yespower.pplnsWindow, 777);
    assert.strictEqual(cfg.algos.ethash.enabled, false);
    assert.strictEqual(cfg.algos.ethash.diff, 64);
    // Untouched fields keep the JSON values.
    assert.strictEqual(cfg.algos.sha256.scheme, 'solo');
    assert.strictEqual(cfg.algos.ethash.stratumPort, 3335);
});

check('precedence: env beats JSON for payments, api, tuning', function () {
    var cfg = envConfig.applyEnvOverrides(baseConfig(), {
        ITC_PAYMENTS_ENABLED: 'true', ITC_PAYMENTS_FEE_PERCENT: '2.5',
        ITC_PAYMENTS_MIN_PAYOUT: '3', ITC_PAYMENTS_CONFIRMATIONS: '42',
        ITC_PAYMENTS_INTERVAL_SECONDS: '60', ITC_PAYMENTS_PPLNS_WINDOW: '1234',
        ITC_PAYMENTS_DATA_FILE: '/tmp/env-ledger.json',
        ITC_API_PORT: '18099', ITC_API_HOST: '127.0.0.1',
        ITC_BLOCK_REFRESH_INTERVAL: '250', ITC_JOB_REBROADCAST_TIMEOUT: '30',
        ITC_CONNECTION_TIMEOUT: '120', ITC_NETWORK: 'regtest',
        ITC_COIN_NAME: 'EnvCoin', ITC_COIN_SYMBOL: 'ENV'
    });
    assert.strictEqual(cfg.payments.enabled, true);
    assert.strictEqual(cfg.payments.feePercent, 2.5);
    assert.strictEqual(cfg.payments.minPayout, 3);
    assert.strictEqual(cfg.payments.confirmations, 42);
    assert.strictEqual(cfg.payments.intervalSeconds, 60);
    assert.strictEqual(cfg.payments.pplnsWindow, 1234);
    assert.strictEqual(cfg.payments.dataFile, '/tmp/env-ledger.json');
    assert.strictEqual(cfg.api.port, 18099);
    assert.strictEqual(cfg.api.host, '127.0.0.1');
    assert.strictEqual(cfg.blockRefreshInterval, 250);
    assert.strictEqual(cfg.jobRebroadcastTimeout, 30);
    assert.strictEqual(cfg.connectionTimeout, 120);
    assert.strictEqual(cfg.network, 'regtest');
    assert.strictEqual(cfg.coinName, 'EnvCoin');
    assert.strictEqual(cfg.coinSymbol, 'ENV');
});

check('array-form algos config is overridden in place', function () {
    var cfg = baseConfig();
    cfg.algos = [{ algorithm: 'yespower', stratumPort: 3334, scheme: 'solo' }];
    envConfig.applyEnvOverrides(cfg, { ITC_YESPOWER_SCHEME: 'prop', ITC_SHA256_STRATUM_PORT: '3333' });
    assert.strictEqual(cfg.algos[0].scheme, 'prop');
    assert.strictEqual(cfg.algos[1].algorithm, 'sha256');
    assert.strictEqual(cfg.algos[1].stratumPort, 3333);
});

check('missing sections are created only when env touches them', function () {
    var cfg = envConfig.applyEnvOverrides({}, { ITC_API_PORT: '18080' });
    assert.strictEqual(cfg.api.port, 18080);
    assert.strictEqual(cfg.payments, undefined);
    assert.strictEqual(cfg.algos, undefined);
});

// --- the live-payments safety rule -----------------------------------
['false', 'true', 'yes', '0', 'no', 'off', '2', 'enabled'].forEach(function (value) {
    check('ITC_PAYMENTS_LIVE=' + JSON.stringify(value) + ' does NOT enable live payments', function () {
        var cfg = envConfig.applyEnvOverrides(baseConfig(), { ITC_PAYMENTS_LIVE: value });
        assert.strictEqual(cfg.payments.dryRun, true);
        assert.strictEqual(envConfig.isLiveEnabled({ ITC_PAYMENTS_LIVE: value }), false);
    });
});

check('ITC_PAYMENTS_LIVE=1 is the one env value that enables live payments', function () {
    var cfg = envConfig.applyEnvOverrides(baseConfig(), { ITC_PAYMENTS_LIVE: '1' });
    assert.strictEqual(cfg.payments.dryRun, false);
    assert.strictEqual(envConfig.isLiveEnabled({ ITC_PAYMENTS_LIVE: ' 1 ' }), true);
});

check('ITC_PAYMENTS_DRY_RUN=false alone never enables live payments', function () {
    var cfg = envConfig.applyEnvOverrides(baseConfig(), { ITC_PAYMENTS_DRY_RUN: 'false' });
    assert.strictEqual(cfg.payments.dryRun, true);
});

check('ITC_PAYMENTS_DRY_RUN=1 forces dry-run back on over a live JSON config', function () {
    var cfg = baseConfig();
    cfg.payments.dryRun = false;
    envConfig.applyEnvOverrides(cfg, { ITC_PAYMENTS_DRY_RUN: '1' });
    assert.strictEqual(cfg.payments.dryRun, true);
});

// --- invalid values fail loudly ---------------------------------------
check('invalid values throw instead of falling back silently', function () {
    assert.throws(function () {
        envConfig.applyEnvOverrides(baseConfig(), { ITC_DAEMON_PORT: 'notaport' });
    }, /ITC_DAEMON_PORT/);
    assert.throws(function () {
        envConfig.applyEnvOverrides(baseConfig(), { ITC_SHA256_STRATUM_PORT: '99999' });
    }, /ITC_SHA256_STRATUM_PORT/);
    assert.throws(function () {
        envConfig.applyEnvOverrides(baseConfig(), { ITC_ETHASH_SCHEME: 'randomx' });
    }, /ITC_ETHASH_SCHEME/);
    assert.throws(function () {
        envConfig.applyEnvOverrides(baseConfig(), { ITC_PAYMENTS_ENABLED: 'maybe' });
    }, /ITC_PAYMENTS_ENABLED/);
});

// --- .env parsing ------------------------------------------------------
check('.env parser: comments, quotes, export prefix, hashes in values', function () {
    var parsed = envConfig.parseDotEnv([
        '# a comment',
        '',
        'ITC_DAEMON_HOST=127.0.0.1',
        'export ITC_DAEMON_PORT=8332',
        'ITC_DAEMON_PASSWORD="pa#ss word"',
        "ITC_POOL_NAME='My Pool'",
        'NOT_A_PAIR'
    ].join('\n'));
    assert.strictEqual(parsed.ITC_DAEMON_HOST, '127.0.0.1');
    assert.strictEqual(parsed.ITC_DAEMON_PORT, '8332');
    assert.strictEqual(parsed.ITC_DAEMON_PASSWORD, 'pa#ss word');
    assert.strictEqual(parsed.ITC_POOL_NAME, 'My Pool');
    assert.strictEqual(parsed.NOT_A_PAIR, undefined);
});

check('.env file loads but never overrides the real environment', function () {
    var file = path.join(os.tmpdir(), 'itc-env-test-' + process.pid + '.env');
    fs.writeFileSync(file, 'ITC_API_PORT=11111\nITC_POOL_NAME=FromFile\n');
    try {
        var target = { ITC_API_PORT: '22222' };
        envConfig.loadDotEnvFile(file, target);
        assert.strictEqual(target.ITC_API_PORT, '22222');
        assert.strictEqual(target.ITC_POOL_NAME, 'FromFile');
    } finally {
        fs.unlinkSync(file);
    }
});

// --- start.js wiring ---------------------------------------------------
check('start.js loadConfig layers the injected env over the JSON file', function () {
    var cfg = start.loadConfig(
        path.join(__dirname, 'harness-config.json'),
        { ITC_API_PORT: '18099', ITC_YESPOWER_SCHEME: 'pplns', ITC_POOL_NAME: 'EnvProof' }
    );
    assert.strictEqual(cfg.api.port, 18099);
    assert.strictEqual(cfg.algos.yespower.scheme, 'pplns');
    assert.strictEqual(cfg.poolName, 'EnvProof');
    // JSON base is still the harness file underneath.
    assert.strictEqual(cfg.daemon.port, 18332);
});

check('every variable in .env.example is honoured by the loader', function () {
    var example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
    var documented = {};
    example.split(/\r?\n/).forEach(function (line) {
        var m = line.match(/^(ITC_[A-Z0-9_]+)=/);
        if (m) documented[m[1]] = true;
    });
    var missing = Object.keys(documented).filter(function (name) {
        return envConfig.ENV_VARS.indexOf(name) === -1 && name !== 'ITC_ENV_FILE';
    });
    assert.deepStrictEqual(missing, []);
    var undocumented = envConfig.ENV_VARS.filter(function (name) {
        return !documented[name];
    });
    assert.deepStrictEqual(undocumented, []);
    console.log('      (' + Object.keys(documented).length + ' variables documented and honoured)');
});

console.log('test-env-config: PASS (' + checks + ' checks)');
