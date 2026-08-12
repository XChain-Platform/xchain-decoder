/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Block-0 chain-identity pin.
 *
 * The chain-tier gate (chainIdentityGate.test.js) can prove an endpoint is on the
 * wrong TIER and nothing more: BTC-mainnet and DOGE-mainnet both report
 * chain="main", and Bitcoin testnet3 and testnet4 both report a testnet string. A
 * same-tier foreign node therefore passes it, and its blocks are still decoded
 * under our address rules while its tip drives deleteBlockByIndex() over valid
 * local history. The block-0 hash is the only constant that separates them.
 *
 * These pin the mechanism: the registry field, the accessor, the boot assertion,
 * the throttled re-check, and (just as load-bearing) the three fail-OPEN cases
 * of unpinned, unreadable and agreeing, because a mechanism that halts a healthy
 * decoder is worse than the hole it closes.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { chainGenesisMismatch, chainGenesisUnpinned } = require('../../src/chainIdentity.js');
const CryptoNetworks = require('../../src/CryptoNetworks.js');
const coins          = require('../../src/coins');
const XChainDecoder  = require('../../src/XChainDecoder.js');

// A real Bitcoin mainnet block-0 hash, used only as a well-formed sample value.
const HASH_A = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
// Dogecoin mainnet's, i.e. the same-tier foreign chain the tier gate cannot refuse.
const HASH_B = '1a91e3dace36e2be3bf030a65679fe821aa1d6ef92e7c9902eb318182c355691';

function makeDecoder(networkKey){
    return new XChainDecoder(
        networkKey,
        'dburl', 3306, 'dbname', 'dbuser', 'dbpass',
        'nodeurl', 1234, 'nodeuser', 'nodepass',
        false, null
    );
}

describe('block-0 chain-identity pin @regression', function () {

    describe('the pure decision', function () {
        it('refuses a node whose block 0 differs from the pin', function () {
            const reason = chainGenesisMismatch(HASH_A, HASH_B);
            assert.ok(reason, 'a differing block-0 hash must be refused');
            assert.ok(reason.includes(HASH_A), 'the reason names the pinned hash');
            assert.ok(reason.includes(HASH_B), 'the reason names the hash the node reported');
        });

        it('accepts an agreeing node regardless of hex case (the pin is operator-typed)', function () {
            assert.strictEqual(chainGenesisMismatch(HASH_A, HASH_A), null);
            assert.strictEqual(chainGenesisMismatch(HASH_A.toUpperCase(), HASH_A), null);
            assert.strictEqual(chainGenesisMismatch(HASH_A, HASH_A.toUpperCase()), null);
        });

        it('fails OPEN when nothing is pinned (an unpinned coin must run as it did before)', function () {
            assert.strictEqual(chainGenesisMismatch(null, HASH_B), null);
            assert.strictEqual(chainGenesisMismatch(undefined, HASH_B), null);
            assert.strictEqual(chainGenesisMismatch('', HASH_B), null);
        });

        it('fails OPEN when the node returns nothing usable (an RPC blip is not a foreign chain)', function () {
            assert.strictEqual(chainGenesisMismatch(HASH_A, null), null);
            assert.strictEqual(chainGenesisMismatch(HASH_A, undefined), null);
            assert.strictEqual(chainGenesisMismatch(HASH_A, ''), null);
            assert.strictEqual(chainGenesisMismatch(HASH_A, 42), null);
        });

        it('chainGenesisUnpinned reports the unchecked state so a skip is never read as a pass', function () {
            assert.strictEqual(chainGenesisUnpinned(null), true);
            assert.strictEqual(chainGenesisUnpinned(undefined), true);
            assert.strictEqual(chainGenesisUnpinned(''), true);
            assert.strictEqual(chainGenesisUnpinned(HASH_A), false);
        });
    });

    describe('the registry carries the pin, and carries it OUTSIDE the consensus hash', function () {
        it('every coin/network declares chainGenesisHash (null = unpinned)', function () {
            for(const tick of coins.ALLOWED_COINS)
                for(const net of coins.NETWORKS)
                    assert.ok('chainGenesisHash' in coins.getCoinConfig(tick, net),
                        tick + '/' + net + ' must expose chainGenesisHash through getCoinConfig');
        });

        it('is absent from consensusSubset, so arming a pin needs no flag-day', function () {
            for(const tick of coins.ALLOWED_COINS)
                for(const net of coins.NETWORKS)
                    assert.ok(!('chainGenesisHash' in coins.consensusSubset(tick, net)),
                        tick + '/' + net + ' consensus subset must not carry the endpoint-identity pin');
        });

        // The operational property: the operator can pin the real hashes without moving
        // CONSENSUS_CONFIG_PIN, so no coordinated re-pin of the nine bundles is needed.
        it('pinning a hash leaves the vendored consensus hash and the pin check untouched', function () {
            const BTC = require('../../src/coins/BTC.js');
            const before = coins.consensusHash('BTC', 'regtest');
            BTC.networks.regtest.chainGenesisHash = HASH_A;
            try {
                assert.strictEqual(coins.getCoinConfig('BTC', 'regtest').chainGenesisHash, HASH_A);
                assert.strictEqual(coins.consensusHash('BTC', 'regtest'), before);
                coins.verifyConsensusPin('regtest'); // still passes against the bundled pin
            } finally {
                BTC.networks.regtest.chainGenesisHash = null;
            }
        });

        it('regtest is deliberately unpinnable: every stack mines its own chain', function () {
            for(const tick of coins.ALLOWED_COINS){
                const coinFile = require('../../src/coins/' + tick + '.js');
                assert.strictEqual(coinFile.networks.regtest.chainGenesisHash, null,
                    tick + ' regtest must stay unpinned; a pinned value fail-closes every fresh stack');
            }
        });
    });

    describe('CryptoNetworks.getChainGenesisHash', function () {
        it('resolves the registry value for a network key', function () {
            const BTC = require('../../src/coins/BTC.js');
            BTC.networks.regtest.chainGenesisHash = HASH_A;
            try {
                assert.strictEqual(CryptoNetworks.getChainGenesisHash('bitcoin-regtest'), HASH_A);
            } finally {
                BTC.networks.regtest.chainGenesisHash = null;
            }
        });

        it('returns null (never undefined) while a coin/network is unpinned', function () {
            for(const key of ['bitcoin-mainnet', 'litecoin-testnet', 'dogecoin-regtest'])
                assert.strictEqual(CryptoNetworks.getChainGenesisHash(key), null);
        });

        it('throws on an unknown network key, like the sibling accessors', function () {
            assert.throws(() => CryptoNetworks.getChainGenesisHash('monero-mainnet'), TypeError);
        });
    });

    describe('the decoder asserts it against the node', function () {
        it('the constructor reads the pin off the registry', function () {
            const BTC = require('../../src/coins/BTC.js');
            BTC.networks.regtest.chainGenesisHash = HASH_A;
            try {
                assert.strictEqual(makeDecoder('bitcoin-regtest').chainGenesisHash, HASH_A);
            } finally {
                BTC.networks.regtest.chainGenesisHash = null;
            }
            assert.strictEqual(makeDecoder('bitcoin-regtest').chainGenesisHash, null);
        });

        it('never calls the node while the pin is unset (an unpinned decoder costs no RPC)', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            let calls = 0;
            decoder.connector = { getBlockHash: async () => { calls++; return HASH_B; } };
            assert.strictEqual(await decoder.verifyChainGenesis(), null);
            assert.strictEqual(calls, 0);
        });

        it('returns the mismatch for a same-tier foreign node', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => HASH_B };
            const reason = await decoder.verifyChainGenesis();
            assert.ok(reason && reason.includes(HASH_B));
            assert.strictEqual(decoder.chainGenesisCheckedAt, 0,
                'a refused endpoint must not count as a check, so every retry re-proves it');
        });

        it('records the check only when the node actually agreed', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => HASH_A };
            assert.strictEqual(await decoder.verifyChainGenesis(), null);
            assert.ok(decoder.chainGenesisCheckedAt > 0);
        });

        it('an RPC failure leaves the check pending rather than halting the decoder', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => { throw new Error('ECONNREFUSED'); } };
            assert.strictEqual(await decoder.verifyChainGenesis(), null);
            assert.strictEqual(decoder.chainGenesisCheckedAt, 0,
                'an unreadable hash must not be recorded as verified, so the next refresh retries at once');
        });

        it('an empty/garbage block-0 response is unreadable, not a mismatch', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => '' };
            assert.strictEqual(await decoder.verifyChainGenesis(), null);
            assert.strictEqual(decoder.chainGenesisCheckedAt, 0);
        });

        it('start() halts fail-closed on a mismatch, before any DB handle is built', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => HASH_B };
            await assert.rejects(() => decoder.start(), /Refusing to start/);
            assert.strictEqual(decoder.db, null);
            assert.strictEqual(decoder.mempoolDb, null);
        });

        it('start() does NOT halt when the node is merely unreachable (no boot crash loop)', async function () {
            const decoder = makeDecoder('bitcoin-regtest');
            decoder.chainGenesisHash = HASH_A;
            decoder.connector = { getBlockHash: async () => { throw new Error('ECONNREFUSED'); } };
            // Pre-seeded handles so boot walks PAST the identity assertion into the DB
            // stage; reaching the stub is the proof that an unreadable hash did not halt.
            decoder.db = { createDatabase: async () => { throw new Error('DB-STAGE-REACHED'); } };
            decoder.mempoolDb = {};
            await assert.rejects(() => decoder.start(), /DB-STAGE-REACHED/);
        });
    });

    describe('the assertion is wired where it has to be, not merely exported', function () {
        const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'XChainDecoder.js'), 'utf8');

        it('start() asserts the pin immediately after verifyConsensusPin', function () {
            const pinIdx     = SRC.indexOf("require('./coins').verifyConsensusPin(this.consensusNetwork)");
            const genesisIdx = SRC.indexOf('await this.verifyChainGenesis()', pinIdx);
            const dbIdx      = SRC.indexOf('this.db = new Database(', pinIdx);
            assert.ok(pinIdx > 0 && genesisIdx > pinIdx, 'the genesis assertion must follow verifyConsensusPin');
            assert.ok(genesisIdx < dbIdx, 'it must run before any DB handle is constructed');
            assert.ok(/throw new Error\('Refusing to start: '/.test(SRC),
                'a proven mismatch must halt startup, not warn');
        });

        // A boot-only check is not enough: NODE_URL_FALLBACK can move a running decoder
        // onto another endpoint, which is exactly where a wrong-coin URL hides.
        it('the block loop re-checks it on the throttled refresh', function () {
            assert.ok(SRC.includes('!chainGenesisUnpinned(this.chainGenesisHash)'),
                'the loop must skip the re-check while the coin/network is unpinned');
            assert.ok(SRC.includes('this.chainGenesisCheckedAt >= BLOCKCHAIN_INFO_REFRESH_MS'),
                'the re-check must be throttled on its own clock, not run every loop iteration');
            const latchIdx = SRC.indexOf('wrongGenesisProblem = true');
            assert.ok(latchIdx > 0, 'a refusal in the loop must latch so it logs once per transition');
            const after = SRC.slice(latchIdx, latchIdx + 300);
            assert.ok(/lastBlockchainInfo = null/.test(after), 'the foreign tip is discarded');
            assert.ok(/continue/.test(after), 'the loop re-polls instead of decoding the foreign chain');
        });

        it('an unpinned mainnet/testnet decoder says so at boot instead of implying it verified', function () {
            assert.ok(/No chainGenesisHash is pinned for/.test(SRC),
                'the unchecked state must be logged, so a silent skip is never read as proof');
            assert.ok(/chainGenesisUnpinned\(this\.chainGenesisHash\) && this\.consensusNetwork !== 'regtest'/.test(SRC),
                'regtest is unpinnable by design and must not emit the warning');
        });
    });
});
