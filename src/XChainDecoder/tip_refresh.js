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
 *
 * XChain Decoder - Decoder Class
 *
 * This file handles starting the decoder and parsing blocks and transactions
 *
 ********************************************************************/

const { format: formatLogLine } = require('node:util')
const { chainTierMismatch, chainFieldMissing, chainGenesisUnpinned } = require('../protocol/chain_identity')
const { logger, BLOCKCHAIN_INFO_REFRESH_MS, MIN_VERIFICATION_PROGRESS_TO_PARSE } = require('./constants.js')
const { nodeStillCatchingUp } = require('./payload_helpers.js')
const { parkOrRethrow } = require('./sync_loop.js')

// lastBlockchainInfo is the reply fetchChainTip just stored on the loop, passed in
// read-only; a refusal discards it from the loop and the caller sleeps and re-polls.
function refuseForeignTier(loop, lastBlockchainInfo){
    // Reject an endpoint serving a different chain BEFORE its numbers are
    // used. The shape gate above proves the response is
    // well-formed, never that it came from this decoder's chain, and every
    // consumer downstream trusts it: `blocks` drives ingestion under the
    // configured address rules and start height, and the same refresh feeds
    // the reorg-reconcile branches, where a foreign tip reads as a deep
    // reorg and deleteBlockByIndex() removes valid local blocks. So a
    // misconfigured primary, or a failover endpoint on another chain,
    // silently corrupted state and could destroy it.
    //
    // Treated exactly like the malformed branch: null the info, sleep and
    // re-poll. That is the recoverable direction (the decoder stops
    // advancing and says why, and an operator fixes the endpoint), whereas
    // continuing is the one path that loses data. The latch keeps it one
    // line per transition rather than one per 3-second retry.
    const chainMismatch = chainTierMismatch(this.consensusNetwork, lastBlockchainInfo["chain"])
    if (chainMismatch){
        if (!loop.wrongChainProblem){
            this.logError('Refusing to decode: ' + chainMismatch +
                '. Point the decoder at a ' + this.consensusNetwork + ' node and restart.')
        }
        loop.wrongChainProblem = true
        loop.lastBlockchainInfo = null
        return 'continue'
    }
    loop.wrongChainProblem = false
}

function noteMissingChainField(loop){
    // `chain` absent is NOT read as agreement. It fails open (a trimmed RPC
    // proxy must not stall the fleet over a hazard only a misconfiguration
    // creates), so the unchecked state is said out loud once instead.
    if (chainFieldMissing(loop.lastBlockchainInfo["chain"]) && !loop.chainFieldMissingLogged){
        loop.chainFieldMissingLogged = true
        this.log("getblockchaininfo carries no 'chain' field, so the endpoint's network tier cannot be verified; " +
            'endpoint-to-network binding rests on deployment config alone.')
    }
}

async function refuseForeignGenesis(loop){
    const genesisMismatch = await this.verifyChainGenesis()
    if (genesisMismatch){
        if (!loop.wrongGenesisProblem){
            this.logError('Refusing to decode: ' + genesisMismatch +
                '. Point the decoder at a ' + this.coinTick + '/' + this.consensusNetwork +
                ' node and restart.')
        }
        loop.wrongGenesisProblem = true
        loop.lastBlockchainInfo = null
        await this.sleep(3000)
        return 'continue'
    }
    loop.wrongGenesisProblem = false
}

function refuseUnsyncedNode(loop){
    if (loop.lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
        if (!loop.nodeSyncedProblem){
            logger.info("The node is not synced. Waiting for it to synchronize...")
        }

        loop.lastBlockchainInfo = null
        loop.nodeSyncedProblem = true
        return 'continue'
    } else {
        loop.nodeSyncedProblem = false
    }
}

async function fetchChainTip(loop){
    try {
        loop.lastBlockchainInfo = await this.connector.getBlockchainInfo()

        // Validate the shape before any field is used. A trimmed RPC-proxy
        // response or a per-coin getblockchaininfo variant could omit these
        // fields; without this guard `undefined < 0.99` is false (the
        // not-synced gate silently passes) and `blocks` becomes undefined
        // (every later height comparison quietly goes wrong). Mirror the
        // typeof-number discipline verifyReorg's tip refresh already applies
        // and treat a malformed result like the RPC-failure branch below.
        if (!loop.lastBlockchainInfo
            || typeof loop.lastBlockchainInfo["blocks"] !== 'number'
            || typeof loop.lastBlockchainInfo["verificationprogress"] !== 'number'){
            logger.info("Malformed getblockchaininfo response (missing or non-numeric 'blocks'/'verificationprogress'). Trying again...")
            loop.lastBlockchainInfo = null
            await this.sleep(3000)
            return 'continue'
        }

        if (refuseForeignTier.call(this, loop, loop.lastBlockchainInfo) === 'continue'){
            await this.sleep(3000)
            return 'continue'
        }
        noteMissingChainField.call(this, loop)

        // Re-prove the CHAIN, not just the tier, on the same throttled
        // cadence. Boot-time verification alone is not enough: NODE_URL_FALLBACK
        // can move this decoder onto a different endpoint mid-run, and the failover
        // target is exactly where a wrong-coin URL hides. Its own timestamp keeps
        // this to one extra getblockhash per BLOCKCHAIN_INFO_REFRESH_MS instead of
        // one per loop iteration (a caught-up loop re-polls the tip constantly, and
        // block 0 cannot move under a chain that is still the same chain).
        if (!chainGenesisUnpinned(this.chainGenesisHash)
            && (Date.now() - this.chainGenesisCheckedAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
            if ((await refuseForeignGenesis.call(this, loop)) === 'continue') return 'continue'
        }
        if (refuseUnsyncedNode.call(this, loop) === 'continue'){
            await this.sleep(3000)
            return 'continue'
        }

        this.blockchainInfoLastBlock = loop.lastBlockchainInfo["blocks"]
        loop.lastBlockchainInfoRefreshAt = Date.now()
        this.blockchainInfoLastRefreshAt = loop.lastBlockchainInfoRefreshAt
    } catch (e){
        logger.info(e)
        logger.info(formatLogLine("Error trying to get network info from the node. Trying again...", e))
        await this.sleep(3000)
        return 'continue'
    }
}

// lastProcessedBlockIndex is the loop's cursor at call time, read-only here: the
// refresh never moves it, and the regression reconcile writes it on the loop.
async function refreshChainTip(loop, lastProcessedBlockIndex){
    if ((await fetchChainTip.call(this, loop)) === 'continue') return 'continue'

    // The usual end of an IBD wait: the node's tip reached our height, so the
    // tip-regression branch below is simply never entered again and the
    // in-branch clear cannot fire. Without this the finished wait would stay
    // on every health payload for the life of the process. The log latch is
    // deliberately NOT cleared here: it speaks only for the branch below.
    if (this.nodeCatchingUp && lastProcessedBlockIndex <= this.blockchainInfoLastBlock){
        this.nodeCatchingUp = null
    }

    if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
        return await reconcileTipRegression.call(this, loop, lastProcessedBlockIndex, loop.lastBlockchainInfo)
    }
}

async function reconcileTipRegression(loop, lastProcessedBlockIndex, lastBlockchainInfo){
    if (lastProcessedBlockIndex == this.startBlockIndex - 1){
        // Benign: we have processed nothing yet and the node simply
        // hasn't reached our configured start height. Wait, don't reorg.
        logger.info("Last block from the node ("+this.blockchainInfoLastBlock+") is still behind the starting block ("+this.startBlockIndex+")")
        await this.sleep(5000)
        return 'continue'
    }

    // A node still in initial block download has not validated up to
    // our height yet; its tip below ours is a node catching up, not a
    // rollback. Wait for it to pass the stored tip, then the forward
    // hash compare below decides whether anything diverged. Measured
    // on an operator's fresh BTC mainnet node 2026-09-07: reconciling
    // here rolled back 126 valid blocks, hit the safe-depth ceiling,
    // wrote the durable halt and crash-looped 279 times over a reorg
    // that never happened. The wait is also published as
    // this.nodeCatchingUp (health payloads: node_catching_up), because a
    // silent wait is indistinguishable from a wedge: the height stops
    // moving and every surface still reads green. Both heights are
    // re-read each poll; `since` is carried over so it keeps naming the
    // instant THIS wait began.
    if (nodeStillCatchingUp(lastBlockchainInfo)){
        if (!loop.nodeCatchingUpProblem){
            this.logWarn("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"), but the node reports initialblockdownload=true: it is still catching up, not rolled back. Waiting for it to pass "+lastProcessedBlockIndex+" instead of reconciling; the hash compare decides then.")
        }
        const since = (this.nodeCatchingUp && this.nodeCatchingUp.since) || new Date().toISOString()
        this.nodeCatchingUp = { node_height: this.blockchainInfoLastBlock, stored_height: lastProcessedBlockIndex, since }
        loop.nodeCatchingUpProblem = true
        await this.sleep(5000)
        return 'continue'
    }
    if (loop.nodeCatchingUpProblem){
        this.log("The node has left initial block download with its tip ("+this.blockchainInfoLastBlock+") still below the last processed block ("+lastProcessedBlockIndex+"); treating the gap as a rollback from here on.")
        loop.nodeCatchingUpProblem = false
    }
    this.nodeCatchingUp = null
    return await reconcileOrphanBlocks.call(this, loop, lastProcessedBlockIndex)
}

async function reconcileOrphanBlocks(loop, lastProcessedBlockIndex){
    // The node's tip has dropped BELOW our last-processed height (deep
    // reorg, node rollback, or restart onto a shorter/different chain).
    // The forward hash-compare reorg path (below) is unreachable in this
    // state (it only fires when fetching a block ABOVE our height), so
    // without this branch the decoder loops forever logging the gap while
    // orphan blocks above the node tip survive, which the indexer then
    // inherits as permanently divergent history. Reconcile now:
    // verifyReorg(tip) deletes every stored block above the tip via a
    // deterministic height compare, then walks the hash-compare back to
    // the fork point. blockchainInfoLastBlock was just refreshed above, so
    // the tip is current.
    if (!loop.tipBelowStoredTipRefused){
        this.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"). Reconciling orphan blocks...")
    }
    await this.db.endTransaction()
    try {
        await this.verifyReorg(this.blockchainInfoLastBlock)
    } catch (err){
        // A gap too deep to reconcile, refused BEFORE any delete (nothing
        // rolled back, no durable halt). Exiting here would only restart
        // into the same refusal; stay up, say it once, and re-check the
        // tip every poll so a node that is merely catching up (without
        // reporting IBD) resolves it on its own and a real rollback stays
        // visible on the status surface as node_height below the tip.
        if (err && err.tipBelowStoredTip){
            if (!loop.tipBelowStoredTipRefused){
                this.logError(err.message)
            }
            loop.tipBelowStoredTipRefused = true
            await this.sleep(5000)
            return 'continue'
        }
        parkOrRethrow.call(this, err, lastProcessedBlockIndex)
        return 'continue'
    }
    loop.tipBelowStoredTipRefused = false
    // Re-clamp: a deep reorg can empty the blocks table, causing
    // getLastBlockIndex() to return -1 and nextBlockHeight to become 0
    // on a nonzero-start network. Clamp here, the same as the pre-loop guard.
    loop.lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
    loop.lastProcessedTxIndex = await this.db.getLastTxIndex()
    loop.blocksQuantity = 0
    loop.transactionsCount = 0
    loop.validTransactionsCount = 0
    loop.outputCount = 0
    loop.startTimeStamp = Date.now()
    this.log("Blocks were updated after node-tip regression")
    return 'continue'
}

module.exports = { refreshChainTip }
