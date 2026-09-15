// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
    DELEGATE_A,
    DELEGATE_B,
    addressesOf,
    assert,
    create,
    runOne,
} = require('./support.js')

const renamed = (name, command) => name + command.slice(command.indexOf('|'))

describe('BATCH dispenser registration', function () {
    this.timeout(0)

    describe('the DISPENSER prefix carries its delimiter above the gate', function () {

        // The invariant the whole below-gate byte-identity argument rests on. The gate is
        // still applied to the predicate because THIS set can change: the day someone adds a
        // DISPENSER-prefixed name to it, pre-flag-day history must still re-decode to the
        // over-captured rows the fleet wrote, and only the gate promises that. This test is
        // what turns that from a comment into a tripwire.
        it('VALID_ACTION_NAMES holds no other name beginning DISPENSER', function () {
            const { VALID_ACTION_NAMES } = require('../../../src/XChainDecoder')
            const shareTheHead = [...VALID_ACTION_NAMES].filter(n => n.startsWith('DISPENSER'))
            assert.deepStrictEqual(shareTheHead, ['DISPENSER'],
                'a second DISPENSER-prefixed action name makes the loose top-level prefix ' +
                'reachable again; the flag-day gate on the predicate is what covers that')
        })

        // ONE constant, not two. Driven against the real gate by arming mainnet in place, so
        // this fails the moment someone gives the tightening its own activation.
        it('arms at the same instant as the sub-command walk', async () => {
            const ARMED = 1789430400
            const saved = BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet
            const probe = async (blockTime) => {
                const decoder = await runOne('BATCH|0|' + [
                    renamed('DISPENSERX', create({ getAddress: DELEGATE_B })),
                    create({ getAddress: DELEGATE_A }),
                ].join(';'), { network: 'bitcoin-mainnet', blockTime })
                return addressesOf(decoder.model.rows)
            }
            BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = ARMED
            try {
                assert.deepStrictEqual(await probe(ARMED - 1), [],
                    'one second below the instant the walk is off entirely')
                assert.deepStrictEqual(await probe(ARMED), [DELEGATE_A],
                    'at the instant the walk is on AND the prefix is tight')
            } finally {
                BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet = saved
            }
            // Give the map back exactly what was borrowed; the value itself is pinned in
            // test/unit/batchSubCommandOutputCaptureActivation.test.js, not re-litigated here.
            assert.strictEqual(BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION.mainnet, saved,
                'the map must be back to its pre-probe value')
            const belowRestored = typeof saved === 'number' ? saved - 1 : ARMED
            assert.deepStrictEqual(await probe(belowRestored), [],
                'below the restored mainnet instant both halves are off there')
        })
    })
})
