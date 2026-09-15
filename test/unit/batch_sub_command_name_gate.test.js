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

const XChainDecoder = require('../../src/XChainDecoder')

const SELLER = 'bcrt1qselleraddress'

describe('BATCH sub-command ACTION-name gate and alias expansion', function () {
    this.timeout(0)

    // The premise, MEASURED. Every claim this file's fixes rest on is driven here rather
    // than argued, because three row premises on this spec turned out false when checked.
    describe('measured premise: sub-commands pass no name gate and no canonicalization', function () {

        // buildStoredActionRecord is the storage gate: alias expansion + the
        // VALID_ACTION_NAMES check, applied to the TOP-LEVEL token.
        function stored(actionString) {
            const decoder = new XChainDecoder(
                'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null)
            const buf = Buffer.from(actionString)
            return decoder.buildStoredActionRecord({
                data: buf, compiledDataLength: buf.length, rawData: null,
                dispenseOutputs: [], paymentOutputs: [] }, 'tx01', false)
        }

        it('canonicalizes an alias at the TOP LEVEL and not inside a BATCH', function () {
            assert.strictEqual(stored('TRANSFER|0|BTC|TICK|1|' + SELLER).data,
                'SEND|0|BTC|TICK|1|' + SELLER,
                'the top-level token is alias-expanded before storage')
            assert.strictEqual(stored('BATCH|0|TRANSFER|0|BTC|TICK|1|' + SELLER).data,
                'BATCH|0|TRANSFER|0|BTC|TICK|1|' + SELLER,
                'a batched alias is stored in its WIRE spelling: the gate saw only BATCH')
        })

        it('name-gates an unknown ACTION at the TOP LEVEL and not inside a BATCH', function () {
            assert.deepStrictEqual(stored('DISPENSERX|0|a'), { skip: true, data: '', rawData: null },
                'an unknown top-level name is blanked and the transaction skipped')
            assert.strictEqual(stored('BATCH|0|DISPENSERX|0|a').data, 'BATCH|0|DISPENSERX|0|a',
                'the same name inside a BATCH is stored verbatim: nothing re-checks the pieces')
        })
    })
})
