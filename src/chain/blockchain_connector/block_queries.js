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
 ********************************************************************/

const { encodeVarintHex, stripAuxPowFromBlockHex } = require('./auxpow_codec.js')

module.exports = {
    async getNetworkInfo(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        }, 'network info')
    },

    async getBlockchainInfo(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
            id: 1
        }, 'blockchain info')
    },

    async getBlockHash(blockindex) {
        // getblockhash takes an integer height; a BigInt (BIGINT UNSIGNED columns decode as
        // BigInt) is never a valid JSON-RPC param and makes axios' JSON.stringify throw
        // "Do not know how to serialize a BigInt". Coerce defensively at the RPC boundary.
        blockindex = Number(blockindex)

        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockhash',
            params: [blockindex],
            id: 1,
        }, 'block hash')
    },

    async getBlockHeader(blockhash, hexFormat = true) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblockheader',
            params: [blockhash, !hexFormat],
            id: 1,
        }, 'block header', { exhausted: 'There were problems getting a block header. ' })
    },

    // The RPC fetches below are deliberately OUTSIDE the try. A transport fault (a
    // Dogecoin 1.14 node dropping the TCP connection when its RPC queue fills, a node
    // restart, a network blip) must propagate unwrapped, with error.code intact, so
    // callers can tell it apart from a block whose AuxPoW section cannot be traversed.
    // A catch-all here once wrapped every throw in a bare Error, discarding error.code,
    // and the decoder counted the result toward the malformed-AuxPoW escalation: ~15s
    // of node unavailability flipped it into per-tx block reassembly aimed at the node
    // that was already saturated. Only the header-strip/parse block is wrapped, and its
    // errors carry auxPowParseFailure = true, the signal escalation actually wants.
    async getBlockWithoutAuxPow(blockhash) {
        let blockHeaderHex = await this.getBlockHeader(blockhash, true)
        let blockHex = await this.getBlock(blockhash, true)

        try {
            // Strip logic lives in stripAuxPowFromBlockHex, which is byte-identical to
            // the xchain-utxo-tracker twin. Only the framing differs between the repos
            // and that difference is deliberate: the decoder fetches the header and
            // block OUTSIDE this try so an RPC fault is not mislabeled a content
            // fault, and tags a traversal failure with auxPowParseFailure so
            // fetchBlockHex can escalate to getBlockReassembled.
            blockHex = stripAuxPowFromBlockHex(blockHeaderHex, blockHex)

            return blockHex
        } catch (err) {
            // Content fault: the bytes this node served cannot be traversed. Tag it so
            // fetchBlockHex escalates to getBlockReassembled on THIS signal only.
            const parseErr = new Error("There were problems getting a block hex without auxpow. " + err.message)
            parseErr.auxPowParseFailure = true
            parseErr.cause = err
            throw parseErr
        }
    },

    // Recovery path for a block whose AuxPoW section skipAuxPow cannot traverse:
    // rebuild the pure (AuxPoW-free) block from RPC parts instead of
    // stripping the raw block hex. getblockheader gives the 80-byte header,
    // verbose getblock gives the in-block txid order, and getrawtransaction
    // gives each tx's canonical serialization, so the result is byte-identical
    // to what getBlockWithoutAuxPow would have produced. Every RPC here is one
    // the decoder already depends on (Dogecoin 1.14 has no verbosity-2
    // getblock, so per-txid fetches are the portable route). Deterministic
    // across instances: the output depends only on chain content.
    async getBlockReassembled(blockhash) {
        try {
            // Older daemons append the AuxPoW bytes to getblockheader; the pure
            // header is always the first 80 bytes either way.
            const headerHex = (await this.getBlockHeader(blockhash, true)).substring(0, 160)
            const verboseBlock = await this.getBlockVerbose(blockhash)
            if (!verboseBlock || !Array.isArray(verboseBlock.tx)) {
                throw new Error('verbose getblock returned no tx array')
            }
            // Fetch via the bounded-concurrency batch helper: serial per-tx
            // fetches with per-tx retry backoff made a large DOGE block take
            // minutes to reassemble, wedging the decoder at this height.
            const txHexes = await this.getRawTransactions(verboseBlock.tx)
            for (let i = 0; i < txHexes.length; i++) {
                // getRawTransaction resolves null for a missing tx (mempool-eviction
                // tolerance); for a confirmed in-block tx that is an RPC fault, and
                // assembling without it would emit a corrupt block. Fail instead.
                if (!txHexes[i]) throw new Error('no raw tx for in-block txid ' + verboseBlock.tx[i])
            }
            return headerHex + encodeVarintHex(txHexes.length) + txHexes.join('')
        } catch (err) {
            // Carry the fault's identity out with the message. The three RPC fetches above
            // sit INSIDE this try, so a transport fault (an ECONNRESET from a saturated
            // Dogecoin 1.14 RPC queue, an ECONNABORTED timeout, a node restart) lands here
            // beside a genuine content fault, and only error.code and the rpcCode/rpcMessage
            // sanitizeRpcError attaches separate the two. _auxPowParseErrorCount never
            // decays, so once a height has escalated to this path every later failure at
            // that height arrives through this catch, which is precisely where an operator
            // has to tell an unreachable node from a block whose bytes are unusable.
            // Mirrors the cause attachment getBlockWithoutAuxPow makes above.
            //
            // Deliberately NOT tagged auxPowParseFailure: that flag is the only signal
            // fetchBlockHex escalates on, and aiming a per-tx fan-out at a node that is
            // merely unreachable is the failure the comment above getBlockWithoutAuxPow
            // describes. Errors leaving these RPC helpers have already passed through
            // sanitizeRpcError, which scrubs config.auth, the Authorization header and
            // error.request in place, so attaching one as cause carries no credential.
            const reassembleErr = new Error("There were problems reassembling a block without auxpow. " + err.message)
            reassembleErr.cause = err
            if (err && err.code !== undefined) reassembleErr.code = err.code
            throw reassembleErr
        }
    },

    async getBlockVerbose(blockhash) {
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [blockhash, true],
            id: 1,
        }, 'verbose block')
    },

    async getRawMempool(){
        return await this.rpcCallWithTimeoutRetry({
            jsonrpc: '2.0',
            method: 'getrawmempool',
            id: 1
        }, 'raw mempool', { resultLabel: 'Error getting raw mempool info' })
    },
}
