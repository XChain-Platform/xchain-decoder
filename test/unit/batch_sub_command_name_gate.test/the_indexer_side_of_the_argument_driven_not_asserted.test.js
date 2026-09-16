'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const ACTION_ALIASES = require('../../../src/protocol/action_aliases.js')

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer')
const INDEXER_CHANGES = path.join(INDEXER_ROOT, 'src', 'protocol_changes.js')
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1'

const T0 = 1700000000

function siblingOrSkip(ctx, file){
    if (fs.existsSync(file)) return true
    if (REQUIRE_SIBLINGS)
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling not found: ' + file)
    ctx.skip()
    return false
}

function protocolChanges() {
    const ProtocolChanges = require(INDEXER_CHANGES)
    return new ProtocolChanges({
        config:    { NETWORK: 'regtest' },
        decoderDb: { getBlockTime: async () => T0 },
    })
}

describe('BATCH sub-command ACTION-name gate and alias expansion', function () {
    this.timeout(0)

    // The cross-repo evidence, DRIVEN against the sibling indexer rather than quoted.
    describe('the indexer side of the argument, driven not asserted', function () {

        it('really does reject the EMPTY ACTION name, which is what suppression rests on', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            assert.strictEqual(await changes.isEnabled('', 1), false,
                "isEnabled('') must be false: one such sub-command invalidates the whole batch")
            assert.strictEqual(Object.prototype.hasOwnProperty.call(changes.changes, ''), false,
                'nothing may register the empty name; that is what makes the verdict provable')
            // The other half of the same claim: a real ACTION is enabled, so this is not a
            // registry that says no to everything.
            assert.strictEqual(await changes.isEnabled('COINPAY', 1), true)
            assert.strictEqual(await changes.isEnabled('DISPENSER', 1), true)
        })

        it('enables names this decoder does not know, which is why the gate stops at the empty one', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            const known   = require('../../../src/XChainDecoder').VALID_ACTION_NAMES
            const unknownButEnabled = []
            for (const name of Object.keys(changes.changes)) {
                if (!known.has(name) && await changes.isEnabled(name, 1))
                    unknownButEnabled.push(name)
            }
            // A gate keyed on VALID_ACTION_NAMES would suppress capture for every batch
            // carrying one of these, and the indexer dispatches those batches normally:
            // under-capture, the money-bearing direction. The measurement is the reason
            // hasProvablyRejectedSubCommand fires on the empty name ALONE.
            assert.ok(unknownButEnabled.length > 0,
                'if this ever reaches zero, a decoder-side name gate becomes buildable and ' +
                'the rest of this defect class can be closed; re-derive rather than delete')
            for (const name of ['DISPENSE', 'XCALL', 'UNIFIED_FEES'])
                assert.ok(unknownButEnabled.includes(name),
                    name + ' is enabled in the indexer and unknown here')
        })

        it('rejects an ALIAS name, so expansion must never run below BATCH_SUBACTION_NORMALIZATION', async function () {
            if (!siblingOrSkip(this, INDEXER_CHANGES)) return
            const changes = protocolChanges()
            for (const alias of Object.keys(ACTION_ALIASES))
                assert.strictEqual(await changes.isEnabled(alias, 1), false,
                    alias + ' is not registered, so below the normalization flag-day a batched ' +
                    alias + ' whole-batch-rejects instead of dispatching')
        })
    })
})
