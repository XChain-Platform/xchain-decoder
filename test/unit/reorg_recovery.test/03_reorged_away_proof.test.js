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
 **********************************************************************
 * test/unit/reorg_recovery.test/03_reorged_away_proof.test.js
 *
 * A verbose stored-block header with confirmations -1 proves the node reorged that
 * block out. A not-found answer proves only that this node does not know the block,
 * so the decoder waits without deleting and retries later.
 */

'use strict'

const assert = require('assert')
const XChainDecoder = require('../../../src/XChainDecoder')
const { proveReorgedAway } = require('../../../src/XChainDecoder/reorg_verification/reorged_away_proof.js')

const RESET = /xchain-node reset xchain-decoder <chain> <network> --with-indexer --yes/
const TOP = 199

function makeDecoder(){
    const decoder = new XChainDecoder(
        'bitcoin-regtest', 'h', '0', 'db', 'u', 'p', 'h', '0', 'u', 'p', false, null
    )
    decoder.startBlockIndex = 0
    decoder.sleep = async () => {}
    decoder.verifyChainGenesis = async () => null
    return decoder
}

// The stored chain is 'hash0'..'hash<TOP>'. A chain the node may be on: the stored
// blocks up to forkAt, then its own `tag<h>` blocks up to tipAt.
const mainChain = (tipAt) => Array.from({ length: tipAt + 1 }, (_, h) => 'hash' + h)
const branch = (forkAt, tipAt, tag) => mainChain(forkAt).concat(Array.from({ length: tipAt - forkAt }, (_, i) => tag + (forkAt + 1 + i)))

// A decoder over the stored chain and a scripted node: `active` is its chain,
// `knows` every block hash it has held, and `lie(h)` can replace getblockhash.
function chainDecoder(topAt = TOP){
    const decoder = makeDecoder()
    const node = { active: [], knows: new Set(), lie: null, headerCalls: 0 }
    const deleted = []
    let top = topAt
    let halted = false
    decoder.connector = {
        rpcErrors: 0,
        getBlockHash: async (h) => {
            if (h >= node.active.length) throw new Error('Block height out of range')
            // The answer is fixed before `lie` runs, so a hook that moves the node
            // takes effect from the next call on.
            const answer = node.active[h]
            return (node.lie && node.lie(h)) || answer
        },
        getBlockHeader: async (hash) => {
            node.headerCalls++
            if (!node.knows.has(hash)){ const e = new Error('Block not found'); e.rpcCode = -5; throw e }
            const h = node.active.indexOf(hash)
            return { confirmations: h >= 0 ? node.active.length - h : -1 }
        },
        getBlockchainInfo: async () => ({ chain: 'regtest', blocks: node.active.length - 1,
            headers: node.active.length - 1,
            verificationprogress: 1, initialblockdownload: false })
    }
    decoder.db = {
        getLastBlockIndex:         async () => top,
        getBlockByIndex:           async (h) => (h < 0 || h > top ? null : { block_index: h, block_hash: 'hash' + h }),
        deleteBlockByIndex:        async (h) => { deleted.push(h); top = h - 1; return true },
        isReorgHalted:             async () => halted,
        countReorgDeletesAboveTip: async () => 0,
        markReorgHalted:           async () => { halted = true; return true }
    }
    const setNode = (active, extra = []) => { node.active = active; for (const x of active.concat(extra)) node.knows.add(x) }
    // Deleted heights whose stored block is on the node's chain as it stands now.
    const validDeleted = () => deleted.filter((h) => node.active[h] === 'hash' + h)
    return { decoder, node, setNode, deleted, validDeleted, tip: () => top, halted: () => halted }
}

const waitsWith = (refusalClass, pattern) => (err) => {
    assert.strictEqual(err.tipBelowStoredTip, true, 'a wait, never a halt')
    assert.strictEqual(err.refusalClass, refusalClass)
    if (pattern) assert.match(err.message, pattern)
    return true
}

describe('an endpoint that does not know the stored chain waits', function () {
    it('a fallback that never saw the stored chain waits, then the decoder converges on failback', async function () {
        const { decoder, node, setNode, deleted, halted } = chainDecoder()
        setNode(branch(30, 45, 'alt'))
        for (let poll = 0; poll < 3; poll++){
            await assert.rejects(() => decoder.verifyReorg(45), waitsWith('unproven-fork', /does not know stored block 45/))
        }
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
        node.active = []
        setNode(mainChain(TOP + 3))
        assert.strictEqual(await decoder.verifyReorg(TOP + 3), true)
        assert.deepStrictEqual(deleted, [], 'not one valid block lost to the failover')
    })

    it('a lagging node that knows higher stored headers waits without deleting them', async function () {
        const { decoder, setNode, deleted, halted } = chainDecoder()
        setNode(mainChain(45), mainChain(TOP))
        await assert.rejects(() => decoder.verifyReorg(45), waitsWith('node_behind', /behind the decoder/))
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
    })

    it('a node that lost the stored blocks waits as well, and the wait names the reset', async function () {
        const { decoder, setNode, deleted, halted } = chainDecoder()
        setNode(branch(55, 56, 'new'))
        await assert.rejects(() => decoder.verifyReorg(56), (err) => {
            waitsWith('unproven-fork', RESET)(err)
            assert.match(err.message, /NODE_URL_FALLBACK/)
            assert.match(err.message, /lost those blocks/)
            return true
        })
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
    })
})

describe('the node-tip boundary must prove a real fork', function () {
    it('a persistent wrong hash cannot override a stored block still on the active chain', async function () {
        const { decoder, node, setNode, deleted, halted } = chainDecoder()
        setNode(mainChain(TOP - 127), mainChain(TOP))
        node.lie = (h) => (h === TOP - 127 ? 'fake' + h : null)
        await assert.rejects(() => decoder.verifyReorg(TOP - 127), waitsWith('same-chain', /node holds stored block/))
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
    })

    it('a node two blocks behind deletes nothing even though it knows both high headers', async function () {
        const { decoder, setNode, deleted, halted } = chainDecoder(100)
        setNode(mainChain(98), mainChain(100))
        await assert.rejects(() => decoder.verifyReorg(98), (err) => {
            waitsWith('node_behind', /behind the decoder/)(err)
            assert.deepStrictEqual(err.reorgWaitState,
                { stored_height: 100, stored_hash: 'hash100', class: 'node_behind' })
            return true
        })
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
    })

    it('a node behind past the safe window writes no halt and deletes nothing', async function () {
        const top = 400
        const nodeTip = top - XChainDecoder.DISPENSER_EXPIRE_SAFE_DEPTH - 10
        const { decoder, setNode, deleted, halted } = chainDecoder(top)
        setNode(mainChain(nodeTip), mainChain(top))
        await assert.rejects(() => decoder.verifyReorg(nodeTip), waitsWith('node_behind', /behind the decoder/))
        assert.deepStrictEqual(deleted, [])
        assert.strictEqual(halted(), false)
    })
})

describe('the hash-compare rollback also requires header proof', function () {
    it('waits when the node hash differs but the stored hash is unknown', async function () {
        const { decoder, setNode, deleted } = chainDecoder()
        setNode(branch(TOP - 1, TOP, 'new'))
        await assert.rejects(() => decoder.verifyReorg(TOP), waitsWith('unproven-fork', /does not know stored block 199/))
        assert.deepStrictEqual(deleted, [])
    })

    it('waits when the node hash differs but the stored block is still active', async function () {
        const { decoder, node, setNode, deleted } = chainDecoder()
        setNode(mainChain(TOP + 2))
        node.lie = (h) => (h === TOP ? 'different' : null)
        await assert.rejects(() => decoder.verifyReorg(TOP + 2), waitsWith('same-chain', /3 confirmations/))
        assert.deepStrictEqual(deleted, [])
    })
})

describe('a node that proves it reorged away still halts and rolls back to the fork point', function () {
    it('a fork under a gap past the window halts and the halted walk ends at the fork point', async function () {
        const { decoder, node, setNode, deleted, validDeleted, tip, halted } = chainDecoder()
        setNode(branch(40, 60, 'new'), mainChain(TOP))
        await assert.rejects(() => decoder.verifyReorg(60), (err) => err.reorgHalt === true)
        assert.strictEqual(halted(), true)
        assert.strictEqual(tip(), 40)
        assert.strictEqual(deleted.length, TOP - 40)
        assert.deepStrictEqual(validDeleted(), [])
    })

    it('a node back on the stored chain after the fork point is read stops the deletes', async function () {
        const { decoder, node, setNode, deleted, tip } = chainDecoder()
        setNode(branch(TOP - 127, TOP + 1, 'new'), mainChain(TOP))
        let reads = 0
        node.lie = (h) => {
            if (h === TOP - 126 && decoder.reorgHalted && ++reads === 2) setNode(mainChain(TOP + 5))
            return null
        }
        await assert.rejects(() => decoder.verifyReorg(TOP + 1), /dispenser safe-depth window/)
        assert.strictEqual(deleted.length, 126, 'the window only: the halted walk deleted nothing')
        assert.strictEqual(tip(), TOP - 126)
    })
})

// One proveReorgedAway call against a connector built from a header value or error.
async function prove(header){
    const raise = (x) => async () => { if (x instanceof Error) throw x; return x }
    const decoder = { connector: { getBlockHeader: raise(header) } }
    return proveReorgedAway.call(decoder, { block_index: 40, block_hash: 'hash40' })
}
const rpcError = (code) => Object.assign(new Error('RPC error ' + code), { rpcCode: code })

describe('the reorged-away proof follows the verbose header confirmation count', function () {
    it('proves on confirmations -1 without reading chain state or chain work', async function () {
        assert.deepStrictEqual(await prove({ confirmations: -1 }), { proven: true, unknown: false, why: null })
    })

    const unproven = [
        ['a block the node does not know (-5)', rpcError(-5), true],
        ['a block on the active chain', { confirmations: 3 }, false],
        ['a transport fault on the header', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), false],
        ['an empty header answer', null, false],
        ['a header with no confirmation count', {}, false]
    ]
    for (const [name, header, unknown] of unproven){
        it('proves nothing on ' + name, async function () {
            const result = await prove(header)
            assert.strictEqual(result.proven, false)
            assert.strictEqual(result.unknown, unknown)
            assert.ok(typeof result.why === 'string' && result.why.length > 0)
        })
    }

    it('the fork halt asks again only once its unproven answer is a minute old', async function () {
        const { decoder, node, setNode } = chainDecoder()
        setNode(branch(30, 45, 'alt'))
        await assert.rejects(() => decoder.verifyReorg(45), waitsWith('unproven-fork'))
        await assert.rejects(() => decoder.verifyReorg(45), waitsWith('unproven-fork'))
        assert.strictEqual(node.headerCalls, 1)
        decoder.forkProofCache.at -= 61000
        await assert.rejects(() => decoder.verifyReorg(45), waitsWith('unproven-fork'))
        assert.strictEqual(node.headerCalls, 2)
    })
})
