'use strict';
/*
 * storePath.js — the ONE resolver for the payouts store path.
 *
 * The payouts store is a single JSON file written by the pool
 * process (start.js -> Ledger) and read by every API server of the
 * dashboard: the in-process API and the standalone api/server.js
 * alike (phase-2/3 routes re-read it on every request).
 *
 * Before this module, each side resolved the path on its own and
 * the knobs diverged:
 *   writer (start.js):  config.payments.dataFile, with env
 *                       ITC_PAYMENTS_DATA_FILE layered over the
 *                       JSON config by lib/envConfig.js;
 *                       default api/data/payouts.json.
 *   reader (server.js): options.payoutsFile, env ITC_PAYOUTS_FILE
 *                       (a name nothing else in the repo knows),
 *                       default api/data/payouts.json.
 * The defaults agreed, but setting the documented writer knob
 * (ITC_PAYMENTS_DATA_FILE, or payments.dataFile in the JSON config)
 * moved the ledger while every standalone reader stayed on the
 * default file — the pool settled blocks and the public dashboard
 * reconciled an empty store (all zeros, no breakdowns).
 *
 * Precedence (env over config over default, the envConfig
 * doctrine), identical on both sides:
 *   1. explicit path (createServer's payoutsFile option)
 *   2. env ITC_PAYMENTS_DATA_FILE   (the writer's documented knob)
 *   3. config.payments.dataFile     (parsed pool config, when the
 *                                    caller has one)
 *   4. env ITC_PAYOUTS_FILE         (legacy reader knob, kept so
 *                                    existing deployments/tests
 *                                    keep working)
 *   5. <repo>/api/data/payouts.json
 */

var path = require('path');

var DEFAULT_PAYOUTS_FILE = path.join(__dirname, '..', '..', 'api', 'data', 'payouts.json');

/**
 * @param {object} [options]
 * @param {string} [options.explicit] caller-supplied path (wins)
 * @param {object} [options.config]   parsed pool config (payments.dataFile)
 * @param {object} [options.env]      environment map (defaults to {})
 * @returns {string} absolute payouts store path
 */
function resolvePayoutsStorePath(options) {
    var opts = options || {};
    var env = opts.env || {};
    if (opts.explicit) return path.resolve(String(opts.explicit));
    if (env.ITC_PAYMENTS_DATA_FILE) return path.resolve(String(env.ITC_PAYMENTS_DATA_FILE));
    var config = opts.config;
    var payments = config && typeof config === 'object' ? config.payments : null;
    if (payments && typeof payments === 'object' && payments.dataFile) {
        return path.resolve(String(payments.dataFile));
    }
    if (env.ITC_PAYOUTS_FILE) return path.resolve(String(env.ITC_PAYOUTS_FILE));
    return DEFAULT_PAYOUTS_FILE;
}

module.exports = {
    resolvePayoutsStorePath: resolvePayoutsStorePath,
    DEFAULT_PAYOUTS_FILE: DEFAULT_PAYOUTS_FILE
};
