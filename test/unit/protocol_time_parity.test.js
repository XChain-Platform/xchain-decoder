// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const path = require('path')
const local = require('../../src/protocol/protocol_time.js')
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js')

const CANONICAL_PATH = path.join(
    __dirname,
    '../../../xchain-indexer/src/consensus/protocol_time.js'
)
const PREVIOUS_BLOCK_TIMES = Array.from({ length: 12 }, (_, index) => 1700000000 + index)

function stripComments(src){
    return src.split('\n').map(line => {
        let quote = null
        for (let index = 0; index < line.length; index++){
            const character = line[index]
            if (quote){
                if (character === quote && line[index - 1] !== '\\') quote = null
                continue
            }
            if (character === "'" || character === '"' || character === '`'){
                quote = character
                continue
            }
            if (character === '/' && line[index + 1] === '/') return line.slice(0, index)
        }
        return line
    }).join('\n')
}

function codeOnly(src){
    return stripComments(src.replace(/\/\*[\s\S]*?\*\//g, ''))
        .split('\n').map(line => line.trim()).filter(Boolean).join('\n')
}

function functionBody(fn){
    const source = fn.toString()
    return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'))
}

describe('protocol time parity with indexer @regression', function () {
    let canonical

    before(function () {
        const sibling = siblingCheckout(__dirname, CANONICAL_PATH)
        if (!sibling.usable){
            skipOrFail(this, sibling, 'the protocol-time parity guard')
            return
        }
        canonical = require(CANONICAL_PATH)
    })

    it('keeps the consensus constants identical', function () {
        assert.deepStrictEqual(local.MEDIAN_TIME_SPAN, canonical.MEDIAN_TIME_SPAN)
        assert.deepStrictEqual(
            local.PROTOCOL_TIME_MTP_NETWORKS,
            canonical.PROTOCOL_TIME_MTP_NETWORKS
        )
    })

    for (const name of ['medianTimePast', 'protocolTime']){
        it('keeps ' + name + ' code-identical after comment normalization', function () {
            assert.strictEqual(
                codeOnly(functionBody(local[name])),
                codeOnly(functionBody(canonical[name])),
                name + ' drifted from the xchain-indexer consensus-clock twin'
            )
        })
    }

    it('returns the same median for a twelve-block fixture', function () {
        assert.strictEqual(
            local.medianTimePast(PREVIOUS_BLOCK_TIMES),
            canonical.medianTimePast(PREVIOUS_BLOCK_TIMES)
        )
    })
})
