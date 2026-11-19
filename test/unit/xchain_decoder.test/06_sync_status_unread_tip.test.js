/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { registerDecoderMetrics } = require('../../../src/metrics/decoder_metrics')
const { Registry } = require('../../../src/observability/metrics')

function decoderWithUnreadTip(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.lastProcessedBlockIndex = 100
    decoder.blockchainInfoLastBlock = -1
    return decoder
}

describe('XChainDecoder status with a stored cursor and an unread node tip', function () {
    it('keeps the stored cursor while exposing node height and lag as unknown', function () {
        const status = decoderWithUnreadTip().getSyncStatus()
        assert.strictEqual(status.last_processed_block, 100)
        assert.strictEqual(status.node_height, null)
        assert.strictEqual(status.lag, null)
    })

    it('does not publish an unread tip or negative lag as gauge samples', function () {
        const registry = new Registry()
        registerDecoderMetrics(registry, decoderWithUnreadTip())
        const body = registry.render()
        assert.match(body, /^xchain_decoder_last_processed_block 100$/m)
        assert.ok(!/^xchain_decoder_node_height /m.test(body))
        assert.ok(!/^xchain_decoder_block_lag /m.test(body))
    })
})
