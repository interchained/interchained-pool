'use strict';
/**
 * Reference vectors generated from the chain's OWN vendored chfast/ethash
 * C library (~/workspace/interchained/src/crypto/ethash: lib/ethash/ethash.cpp,
 * lib/keccak/keccak.c, lib/ethash/primes.c, include/ethash/*.h).
 *
 * Method: a tiny C harness (kept OUT of this repo, in /tmp/ethash-harness/
 * during the build) linked ethash_create_epoch_context + ethash_hash and,
 * for each vector, read (headerHash display hex, nonce, height) and printed
 * seed / cache items / dataset items / mix / final. The values below are
 * that program's verbatim stdout. Reproduce with:
 *   gcc -O2 -I<ethash>/include -c <ethash>/lib/keccak/keccak.c
 *   gcc -O2 -I<ethash>/include -c <ethash>/lib/ethash/primes.c
 *   g++ -O2 -std=c++14 -I<ethash>/include -c <ethash>/lib/ethash/ethash.cpp
 *   (plus a main.c calling ethash_hash; see lane-2 evidence file)
 *
 * headerHash is DISPLAY (big-endian) order, matching CheckEthashHash's
 * ToEthashHash conversion. nonce is the uint64 value (decimal string so
 * 2^64-1 survives JS number precision).
 */
module.exports = {
    // Epoch metadata as printed by the C library.
    epochs: {
        0: {
            seedHash: '0000000000000000000000000000000000000000000000000000000000000000',
            lightCacheNumItems: 262139,
            fullDatasetNumItems: 8388593
        },
        30: {
            seedHash: '1842cb89c0dfad7efb5ce2bf93f418e369214e9e1773a1bfe7c9c72ceee682bb',
            lightCacheNumItems: 323581,
            fullDatasetNumItems: 10354667
        }
    },
    vectors: [
        {
            headerHash: '0000000000000000000000000000000000000000000000000000000000000000',
            nonce: '0',
            height: 0,
            mixHash: 'c763d8572dec8e75534d2007e265fa95f21be2912fa0625842683ef4329f9021',
            finalHash: '66168636ccf123558a858e585bf81400de28947be61d503c311dbb9d09703eed'
        },
        {
            headerHash: '0000000000000000000000000000000000000000000000000000000000000000',
            nonce: '1',
            height: 0,
            mixHash: 'fa321566c7a4a577cfb1da824bd0559fef18b9581be8541f438c27c0d95aee89',
            finalHash: 'cc1db6e8454bd7194c2cfb4695c21346ea355ef9134f954cd2232c5eb0cbd34c'
        },
        {
            headerHash: '1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f101112131415161718',
            nonce: '42',
            height: 913982,
            mixHash: '30187eab89ee5ba3ff037142c41c302798301a17e02445a88d4623fd8771551c',
            finalHash: '8af2ab083fb6f04700ee189d4fb4c7d07309d6b6eb15bfee267a0774237db1d8'
        },
        {
            headerHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            nonce: '18446744073709551615',
            height: 29999,
            mixHash: '8cc0b55f9445f9abb12d59a87dec3c8ab276502c466c7f0c320cf01e6a98f5fe',
            finalHash: 'bad6b348be77f2fb3863a238c9e9772c6dd0eaaf98fe76bee0ff7b7b97709465'
        },
        {
            headerHash: '290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563',
            nonce: '123456789',
            height: 15000,
            mixHash: '409712c5c3a37950562086b3044331de81a415a53ee2ac8809fe6e8c60ee8283',
            finalHash: 'd3579f116aaa5b3ff4317e1e65d017722cc0e7c9400001d4d75d5006125a44c1'
        }
    ]
};
