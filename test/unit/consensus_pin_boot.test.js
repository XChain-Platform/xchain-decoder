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
 * Boot-time consensus-pin verification, mirroring the indexer's own boot check.
 * start() must call coins.verifyConsensusPin(<net>) fail-closed BEFORE any
 * DB work, so a partial/stale deploy with drifted coin files halts instead of
 * parsing on-chain bytes with divergent network params once a pin is armed.
 * The mainnet pin is null today, so the live check is a no-op.
 */

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const XChainDecoder = require('../../src/XChainDecoder.js');
const coins = require('../../src/coins');

function makeDecoder (networkKey) {
    return new XChainDecoder(
        networkKey,
        'dburl', 3306, 'dbname', 'dbuser', 'dbpass',
        'nodeurl', 1234, 'nodeuser', 'nodepass',
        false, null
    );
}

describe('decoder boot consensus-pin verification', function () {
    afterEach(() => sinon.restore());

    it('derives the consensus network from the "<fullname>-<network>" key', function () {
        assert.strictEqual(makeDecoder('dogecoin-mainnet').consensusNetwork, 'mainnet');
        assert.strictEqual(makeDecoder('bitcoin-regtest').consensusNetwork, 'regtest');
        assert.strictEqual(makeDecoder('litecoin-testnet').consensusNetwork, 'testnet');
    });

    it('verifyConsensusPin skips on the (currently null) mainnet pin', function () {
        assert.deepStrictEqual(coins.verifyConsensusPin('mainnet'), { ok: true, skipped: true });
    });

    it('start() halts fail-closed on a pin mismatch, before any DB work', async function () {
        const stub = sinon.stub(coins, 'verifyConsensusPin')
            .throws(new Error('CONSENSUS CONFIG PIN MISMATCH (test)'));
        const decoder = makeDecoder('dogecoin-mainnet');
        await assert.rejects(() => decoder.start(), /CONSENSUS CONFIG PIN MISMATCH/);
        assert.ok(stub.calledOnceWithExactly('mainnet'));
        // Halted before the boot path constructed any Database handle.
        assert.strictEqual(decoder.db, null);
        assert.strictEqual(decoder.mempoolDb, null);
    });
});
