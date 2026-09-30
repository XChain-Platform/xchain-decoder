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

const util = require('../util')
const coins = require('../coins')
const Database = require('../db.js')
const { chainGenesisUnpinned } = require('../protocol/chain_identity')
const { logger, BLOCKCHAIN_INFO_REFRESH_MS } = require('./constants.js')
const { bigIntBufferutilsActive } = require('./payload_helpers.js')
const { resetAfterRollback, leaveReorgHaltPark, waitAtTip } = require('./sync_loop.js')
const { refreshChainTip } = require('./tip_refresh.js')
const { ingestNextBlock } = require('./block_ingest.js')

function verifyBundledConsensusPin(){
    // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN
    // before touching the DB or processing any block, mirroring the indexer.
    // A null pin (mainnet, pre-arm) skips; a mismatch on an armed network
    // throws and halts startup, so a partial/stale deploy cannot parse
    // on-chain bytes with divergent network params (fail-closed, deliberately
    // not wrapped in try/catch).
    coins.verifyConsensusPin(this.consensusNetwork)
}

async function refuseForeignChain(){
    // Refuse an endpoint that is provably a DIFFERENT CHAIN before the DB is touched
    // or a single block is read. The tier gate in the block loop can only prove
    // "wrong tier"; this proves "wrong chain", which is the case that actually
    // corrupts state: a same-tier foreign node's blocks decode under our address rules
    // and its tip drives deleteBlockByIndex() over valid local history.
    //
    // Fail-closed on a PROVEN mismatch only (deliberately not wrapped in try/catch,
    // matching verifyConsensusPin above): an unreachable node or an unpinned
    // coin/network returns null from verifyChainGenesis and start() continues, so a
    // node that is merely still booting never turns this into a crash loop.
    const genesisMismatch = await this.verifyChainGenesis()
    if (genesisMismatch)
        throw new Error('Refusing to start: ' + genesisMismatch + '. Point the decoder at a ' +
            this.coinTick + '/' + this.consensusNetwork + ' node, or correct the pinned ' +
            'chainGenesisHash in the coin registry.')

    // An unpinned network is UNCHECKED, not verified. Say so once at boot rather than
    // letting a silent skip read as proof the endpoint is ours (same discipline as the
    // absent-`chain` line in the block loop). Regtest is excluded because it is
    // unpinnable by design: every stack mines its own chain.
    if (chainGenesisUnpinned(this.chainGenesisHash) && this.consensusNetwork !== 'regtest')
        this.log('No chainGenesisHash is pinned for ' + this.coinTick + '/' + this.consensusNetwork +
            ', so this endpoint is not proven to be on our chain: a same-tier foreign node ' +
            '(another coin, or Bitcoin testnet3 vs testnet4) would still be decoded. Pin the ' +
            "value from the node's own `getblockhash 0` to close it.")
}

function openDatabaseHandles(){
    if (!this.db) {
        this.db = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
    }

    // Dedicated DB handle for mempool maintenance. updateMempool runs on a 60s
    // timer that fires during the block loop's awaits, while the block loop holds an open
    // per-block transaction on this.db. Every db method resolves its connection via
    // getConnection(), which returns the shared transactionConnection whenever one is open,
    // so routing mempool work through this.db made its DELETE/INSERT land inside the live
    // block transaction, and a failed mempool insert called endTransaction() and rolled the
    // whole block back mid-parse. A separate Database instance never opens a block
    // transaction, so its getConnection() always draws an independent autocommit connection
    // from its own pool: mempool writes commit on their own and a mempool failure can neither
    // roll back nor block the block loop. Points at the same database (tables already created
    // by this.db); it only needs a live pool, so no createDatabase/verifyTables here.
    if (!this.mempoolDb) {
        this.mempoolDb = new Database(this.dbUrl, this.dbPort, this.dbName, this.dbUser, this.dbPassword)
    }

    // Only Dogecoin can carry a single output > 2^53-1 sat (~90.07M DOGE); BTC/LTC caps
    // are lower. The patch is applied in-process (src/chain/apply_bufferutils_patch.js, required
    // by XChainBlockDecoder), so this can only fire if that module regresses or a stray
    // bitcoinjs-lib copy shadows the patched one; keep the backstop so any such
    // regression is loud at startup rather than a mid-operation fleet halt.
    // Refuse to start rather than warn. A prevout wire-decode fault now reaches the
    // retry-then-quarantine ladder instead of the unbounded rpcLookupFailure retry
    // (getSourceFromOutput), and quarantine is parity-safe only for a fault that is
    // the SAME on every instance. An inactive patch is ENVIRONMENT-dependent: this
    // instance would quarantine and skip a DOGE transaction every correctly patched
    // instance decodes, committing instance-dependent block contents. Same
    // util.throwError contract as the database checks below, so api.js start() and
    // health() report it.
    if (this.xchainBlockDecoder && this.xchainBlockDecoder.coin === 'dogecoin' && !bigIntBufferutilsActive()){
        util.throwError(new Error('CRITICAL: bitcoinjs-lib bufferutils BigInt-safe 64-bit reader is NOT active on a ' +
            'Dogecoin decoder. A DOGE output > 2^53-1 sat (~90.07M DOGE) will throw during block decode ' +
            'and wedge this decoder permanently. src/chain/apply_bufferutils_patch.js should have applied it ' +
            'in-process; investigate before running on mainnet.'))
    }
}

async function prepareDatabase(){
    let dbStatus   = await this.db.createDatabase();
    // Verify the configured database actually exists before doing anything else with
    // it, so a mistyped or unprovisioned DECODER_DB_NAME fails loudly here instead of
    // on the first query.
    let dbVerified = await this.db.verifyDatabase();
    if(!dbVerified){
        // Throw a real Error (not a bare string) so `err.message` is populated for
        // the api.js start() catch and the health() error field.
        util.throwError(new Error("Database " + this.dbName + " doesn't exist!"));
    } else {
        // Verify every table this decoder needs is present before running migrations
        // or parsing, so a bare, unmigrated database fails here rather than on the
        // first missing table mid-parse.
        let tablesVerified = await this.db.verifyTables();
        if(!tablesVerified)
            util.throwError(new Error("Database " + this.dbName + " tables don't exist!"));

        // Apply any pending `auto` schema migrations (additive/idempotent changes the
        // drift reconciler can't make on its own). Manual/destructive migrations stay
        // gated for an explicit operator run (`node src/db/migrate.js`). Recorded in the
        // schema_migrations ledger, so this is a no-op once applied.
        await this.db.runMigrations();
    }

    // Report a LATENT reorg halt at boot. A decoder restored from (or running on)
    // a database that already carries a REORG_HALT marker parses forward normally
    // and looks healthy; without this nothing says so until the next reorg hits
    // the guard in verifyReorg, weeks later. Probe once here so the fault is in
    // the startup log and in every health response from the first request on.
    // Non-fatal by design: the marker only blocks rollbacks, so a halted-but-
    // advancing decoder must not be turned into a crash loop by this check.
    await this.checkReorgHalt({ force: true });
}

async function readLoopCursors(){
    logger.info("Parsing...")

    let lastProcessedBlockIndex = this.lastProcessedBlockIndex = await this.db.getLastBlockIndex()
    let lastProcessedTxIndex = await this.db.getLastTxIndex()
    // Start the stall clock here, not in the constructor: a long pre-loop phase
    // (DB connect, txindex probe) must not count as time spent not advancing.
    this.lastAdvanceAt = Date.now()

    if (lastProcessedBlockIndex < this.startBlockIndex - 1){
        lastProcessedBlockIndex = this.lastProcessedBlockIndex = this.startBlockIndex - 1
    }

    let lastBlockchainInfo = null
    let lastBlockchainInfoRefreshAt = 0
    // Tracks which blockchain-info refresh cycle the equal-height tip-hash
    // check last ran on, so it fires at most once per refresh (not every
    // 1-second sleep tick) to avoid a constant RPC + DB round-trip.
    let tipHashCheckedAt = 0
    this.blockchainInfoLastBlock = -1
    let blocksQuantity = 0

    let startTimeStamp = Date.now()

    let blocksCount = 0
    let transactionsCount = 0
    let validTransactionsCount = 0
    let outputCount = 0

    return { lastProcessedBlockIndex, lastProcessedTxIndex, lastBlockchainInfo, lastBlockchainInfoRefreshAt, tipHashCheckedAt, blocksQuantity, startTimeStamp, blocksCount, transactionsCount, validTransactionsCount, outputCount }
}

function initialLoopLatches(){
    let nodeSyncedProblem = false
    // Node-tip-below-ours latches, one line per transition each: the node is
    // still in initial block download (wait, never reconcile), or the gap is
    // too deep to reconcile and verifyReorg refused before deleting (wait,
    // keep running, say so once).
    let nodeCatchingUpProblem = false
    let tipBelowStoredTipRefused = false

    // Wrong-tier endpoint latch, same shape as nodeSyncedProblem: the refusal
    // repeats every 3-second retry, so log it on the transition only.
    let wrongChainProblem = false
    // Wrong-CHAIN latch (block-0 pin). Separate from wrongChainProblem above
    // because the two prove different things and can fire independently: a
    // same-tier foreign endpoint passes the tier gate and fails this one.
    let wrongGenesisProblem = false
    // Said once per process, not per transition: an endpoint that omits `chain` omits
    // it every poll, so a latch here would be a per-transition line that never toggles.
    let chainFieldMissingLogged = false

    // Transaction-level parse-failure tracking for the block currently being
    // retried (see TX_PARSE_MAX_RETRIES).
    let txParseRetryHeight = -1
    let txParseRetryCount = 0

    // Deterministic-INSERT-failure tracking. A row the DB rejects deterministically
    // (Database.POISON_ROW, e.g. a 4-byte-UTF-8 char on the utf8mb3 `data` column,
    // errno 1366) can never insert as-is, so retrying the block would wedge it forever.
    // After TX_PARSE_MAX_RETRIES the tx position is added to insertQuarantine and the
    // re-parse skips it (PARSE_ERROR + no insert), mirroring the parse-throw quarantine.
    // Keyed "<blockHeight>:<txPosition>"; cleared on block commit so it stays bounded
    // and cannot leak across a height whose content changed under a reorg. Only
    // DETERMINISTIC failures quarantine; transient ones (false) still retry forever, so
    // no instance ever skips a tx a healthy instance accepts (cross-instance parity).
    let insertQuarantineHeight = -1
    let insertQuarantineCount = 0
    const insertQuarantine = new Set()
    return { nodeSyncedProblem, nodeCatchingUpProblem, tipBelowStoredTipRefused, wrongChainProblem, wrongGenesisProblem, chainFieldMissingLogged, txParseRetryHeight, txParseRetryCount, insertQuarantineHeight, insertQuarantineCount, insertQuarantine }
}

async function bootDecoder(){
    await refuseForeignChain.call(this)

    openDatabaseHandles.call(this)

    await prepareDatabase.call(this)

    // Startup txindex probe. The malformed-AuxPoW recovery path
    // (getBlockReassembled) calls getrawtransaction without a blockhash and
    // so needs txindex=1 on the node. Without it, recovery fails
    // deterministically forever (a silent permanent wedge at one height), so
    // surface the misconfiguration loudly at boot instead of at recovery
    // time. Non-fatal: decoders on such a node still work until the first
    // malformed-AuxPoW block.
    // Optional-call guard: tests stub this.connector with plain objects.
    const txIndexOk = (typeof this.connector.probeTxIndex === 'function')
        ? await this.connector.probeTxIndex()
        : null
    if (txIndexOk === false) {
        logger.error('WARNING: node does not appear to have txindex=1 (getrawtransaction on a ' +
            'confirmed tx returned nothing). The malformed-AuxPoW block recovery path ' +
            '(getBlockReassembled) requires txindex; without it a malformed-AuxPoW ' +
            'block will wedge this decoder permanently. Restart the node with txindex=1.')
    } else if (txIndexOk === null) {
        logger.info('txindex probe inconclusive (empty chain or probe RPC failed); continuing.')
    }

    // The loop-carried cursors, counters and latches live on one object the loop's
    // steps share, built in the order they are declared.
    return Object.assign(await readLoopCursors.call(this), initialLoopLatches())
}

module.exports = {
    async start(){
        verifyBundledConsensusPin.call(this)
        const loop = await bootDecoder.call(this)

        main_parsing:
        while (true){
            // Liveness heartbeat, first statement in the loop so every path back to the
            // top refreshes it, `continue main_parsing` and the outage retry included.
            // Unlike lastAdvanceAt this records that the loop RAN, not that the chain
            // moved, which is what lets /live tell a caught-up decoder from a dead one.
            this.lastPollAt = Date.now()

            if (this.stopFlag){
                if (this.mempoolInterval != null){
                    logger.info("Mempool updates stopped!")
                    clearInterval(this.mempoolInterval)
                    this.mempoolInterval = null
                }
                break
            }

            // Parked on a REORG_HALT (parkOnReorgHalt): nothing is fetched, deleted or
            // inserted until the marker clears, so this sits above the tip refresh and
            // everything under it. Below the stopFlag check on purpose, so a SIGTERM
            // arriving during a park drains at the next tick like any other iteration.
            if (this.reorgHaltParked){
                await leaveReorgHaltPark.call(this, loop)
                continue main_parsing
            }

            // Edge-triggered stale-tip warn. Evaluated every iteration
            // because the outage path below is `catch -> sleep(3000) -> continue`,
            // which never reaches the code that would otherwise notice; the latch
            // inside makes it one line per transition, not one per poll.
            this.noteNodeTipStaleTransition()

            //Getting network info to retrieve the last block index.
            //Refresh when we have no info yet, when we have caught up to the
            //previously-seen tip, OR periodically on a wall-clock interval; the
            //last condition keeps blockchainInfoLastBlock tracking the live chain
            //during a long catch-up, so the reported lag reflects the true remaining
            //gap instead of converging to zero against a frozen tip.
            if (!loop.lastBlockchainInfo
                || (loop.lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                || (Date.now() - loop.lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                if ((await refreshChainTip.call(this, loop, loop.lastProcessedBlockIndex)) === 'continue') continue
            }

            //If there is no new block, wait for some seconds to ask again
            if (loop.lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                await waitAtTip.call(this, loop)
            } else { //If there is a new block, parse it
                if ((await ingestNextBlock.call(this, loop)) === 'rollback'){
                    await resetAfterRollback.call(this, loop)
                    continue main_parsing
                }
            }
        }
    },
}
