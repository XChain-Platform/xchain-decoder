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

const util = require('./util')
const coins = require('./coins')
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto')
const Database = require('./db.js')
const ecc = require('tiny-secp256k1')
const BlockchainConnector = require('./chain/blockchain_connector')
const CryptoNetworks = require('./chain/crypto_networks')
const XChainBlockDecoder = require('./chain/XChainBlockDecoder')
const { oracleAddressFromCreate, V0_GIVE_COIN_INDEX, V0_GET_COIN_INDEX, V0_GET_ADDRESS_INDEX, V0_EXPIRATION_INDEX, V2_EXPIRATION_INDEX } = require('./protocol/oracle_fee_output')
const { isDispenserExpiryRealignActive } = require('./protocol/dispenser_expiry_realign')
const { cancelGraceFloor } = require('./protocol/dispenser_cancel_grace')
const { captureCommands, collapseDispenserRegistrations, isBatchSubCommandCaptureActive } = require('./protocol/batch_sub_command_capture')
const { chainTierMismatch, chainFieldMissing, chainGenesisUnpinned } = require('./protocol/chain_identity')
const { format: formatLogLine } = require('node:util');
const { logger, CHECK_BLOCK_DELAY_MS, BLOCKCHAIN_INFO_REFRESH_MS, MEMPOOL_INTERVAL, REORG_HALT_PARK_TICK_MS, FUNDING_VOUT_BASE, SYNCED_THRESHOLD, DISPENSER_EXPIRE_SAFE_DEPTH, MIN_VERIFICATION_PROGRESS_TO_PARSE, VALID_ACTION_NAMES, DB_TRANSACTION_BLOCKS_QUANTITY, LOG_BLOCK_INTERVAL, TX_PARSE_MAX_RETRIES, AUXPOW_REASSEMBLE_AFTER } = require('./XChainDecoder/constants.js')
const { nodeStillCatchingUp, compiledPushSize, canonicalizeActionPayload, bigIntBufferutilsActive } = require('./XChainDecoder/payload_helpers.js')
const syncStatusMethods = require('./XChainDecoder/sync_status.js')
const chainIntegrityMethods = require('./XChainDecoder/chain_integrity.js')
const sourceResolutionMethods = require('./XChainDecoder/source_resolution.js')
const envelopeRecognitionMethods = require('./XChainDecoder/envelope_recognition.js')
const dispenserAndOracleFeeMethods = require('./XChainDecoder/dispenser_and_oracle_fees.js')
const transactionParsingMethods = require('./XChainDecoder/transaction_parsing.js')
const reorgVerificationMethods = require('./XChainDecoder/reorg_verification.js')
const mempoolRefreshMethods = require('./XChainDecoder/mempool_refresh.js')

//We need to init the ecc to parse taproot addresses from output scripts
bitcoin.initEccLib(ecc);
// Maximum compiled on-chain ACTION push, in bytes, measured before
// bitcoin.script.decompile strips the OP_PUSHDATA prefix (see compiledDataLength).
// This is the protocol arbiter for ACTION size: any tx whose compiled push exceeds
// this is dropped. Vendored single source of truth: ./protocol/constants.js
// (byte-identical to xchain-documentation/protocol/constants.js); the encoder's
// matching guard is xchain-encoder validator MAX_COMPILED_ACTION_DATA_LENGTH, kept
// equal by the cross-service regression suite.
//
// The cap bounds the WIRE bytes, not the STORED record. Both gates (confirmed-block
// and mempool) compare compiledDataLength, and canonicalizeActionPayload runs AFTER
// the gate, so an expanding alias grows the persisted payload past this number
// (CAST -> BROADCAST adds 5 bytes, MSG -> MESSAGE 4, ADDR -> ADDRESS and
// DROP -> AIRDROP 3 each), so a payload compiled to exactly 8192 bytes is stored as
// an 8197-byte BROADCAST string. That is intended and harmless: transactions.data is
// MEDIUMTEXT, so nothing truncates. It is deliberately not "fixed" by re-measuring
// the canonical buffer at
// the gate: tightening it would drop transactions whose on-chain push is legal and
// that other nodes accept, forking the fleet and retroactively invalidating
// already-decoded near-cap alias history. Moving the measurement point is a
// consensus change needing a flag-day (a *_ACTIVATION entry in
// ./protocol/constants.js keyed on block height and network, deployed fleet-wide
// before its anchor), not an in-place edit. aliasExpansionBoundary.test.js pins the
// measured behavior.
const MAX_ACTION_DATA_LENGTH = require('./protocol/constants.js').MAX_ACTION_DATA_LENGTH

// Bytes the OP_PUSHDATA2 prefix adds to a compiled push (1-byte opcode + 2-byte
// little-endian length), i.e. the overhead for any payload above 255 bytes.
// Vendored single source of truth: ./protocol/constants.js (byte-identical to
// xchain-documentation/protocol/constants.js); the encoder's copy is
// xchain-encoder/src/common/validator.js. Bound to the canonical NAME rather than inlined
// as a literal so a cross-service drift check can key on the symbol.
const OP_RETURN_PUSH_OVERHEAD = require('./protocol/constants.js').OP_RETURN_PUSH_OVERHEAD

// Taproot envelope encoding. ENVELOPE_MAX_PAYLOAD is the per-encoding ceiling
// for the reassembled envelope payload (the legacy lanes keep
// MAX_ACTION_DATA_LENGTH); ENVELOPE_RECOGNITION_ACTIVATION carries the
// per-chain, per-network LOCAL block heights at/above which recognition (and
// the envelope rejection rules) are active. Both vendored from
// ./protocol/constants.js, byte-identical to the canonical copy in
// xchain-documentation/protocol/constants.js.
const ENVELOPE_MAX_PAYLOAD = require('./protocol/constants.js').ENVELOPE_MAX_PAYLOAD
const ENVELOPE_RECOGNITION_ACTIVATION = require('./protocol/constants.js').ENVELOPE_RECOGNITION_ACTIVATION
// Short-form ACTION-name aliases; see ./protocol/action_aliases.js for the table and why it
// sits in its own module (batch_sub_command_capture.js expands the same aliases on a
// BATCH's SUB-COMMAND names and is required BY this file, so a shared literal here
// would be a require cycle). Re-exported below under this name, which is how the
// ActionManifestConformance guard binds it to the canonical manifest.
const ACTION_ALIASES = require('./protocol/action_aliases.js')
function initializeDecoderIdentity(decoder, network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, feeDestination) {
    decoder.network = CryptoNetworks.getBitcoinJsNetwork(network)

    // Uppercase native-coin ticker ('BTC'|'DOGE'|'LTC') for this chain. This is
    // the identity a v0 DISPENSER's GIVE_COIN/GET_COIN fields must name and the
    // value the indexer validates against (config['COIN']); the dispenser-open
    // gate below compares against it so the decoder only opens dispensers the
    // indexer will accept. getBitcoinJsNetwork above already threw on an unknown
    // key, so this cannot throw.
    decoder.coinTick = CryptoNetworks.getCoinTick(network)

    // Net portion ('mainnet'|'testnet'|'regtest') of the "<fullname>-<network>"
    // key, for the boot-time consensus-pin verification in start(). The
    // getBitcoinJsNetwork call above already threw on an unknown key, so the
    // suffix is guaranteed to be a valid network name here.
    decoder.consensusNetwork = String(network).slice(String(network).lastIndexOf('-') + 1)

    // Coin/network-prefixed loggers so cadence/reorg/stall lines are self-describing
    // even when a log pipeline strips container labels. Reads the fields at call time.
    decoder.log = (...args) => logger.info(formatLogLine('[' + decoder.coinTick + '/' + decoder.consensusNetwork + ']', ...args))
    // Warn exists so a notable-but-not-failed event (a reorg starting) can reach a
    // warn-and-above alerting rule without being dressed up as an error. console.log
    // writes to stdout, which those rules do not read.
    decoder.logWarn = (...args) => logger.warn(formatLogLine('[' + decoder.coinTick + '/' + decoder.consensusNetwork + ']', ...args))
    decoder.logError = (...args) => logger.error(formatLogLine('[' + decoder.coinTick + '/' + decoder.consensusNetwork + ']', ...args))

    // Native-coin protocol fee destination address for this coin+network. When set (not the
    // unset placeholder), the decoder also persists any output paying it to transaction_outputs
    // so the indexer can validate native-coin fee payments. Null/placeholder disables capture.
    decoder.feeDestination = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
        ? feeDestination
        : null

    decoder.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
    decoder.dbUrl = dbUrl
    decoder.dbPort = dbPort
    decoder.dbName = dbName
    decoder.dbUser = dbUser
    decoder.dbPassword = dbPassword
    decoder.startBlockIndex = CryptoNetworks.getFirstBlock(network)
    // Pinned block-0 hash of this chain, or null when the registry leaves it
    // unpinned. It is the ONLY value that separates a same-tier foreign endpoint
    // from ours (BTC-mainnet and DOGE-mainnet both report chain="main"), so
    // start() and the throttled tip refresh assert it against `getblockhash 0`.
    decoder.chainGenesisHash = CryptoNetworks.getChainGenesisHash(network)
    // Timestamp (ms) of the last SUCCESSFUL block-0 read. Zero means never read, so
    // the first refresh always checks. Throttled on its own clock rather than riding
    // the getblockchaininfo refresh: a caught-up loop re-polls the tip every
    // iteration, and block 0 cannot change under a chain that is still the same chain.
    decoder.chainGenesisCheckedAt = 0
    // Default EXPIRATION window (days) for v0 dispenser opens that omit the
    // EXPIRATION field; must match the indexer's default-expiration rule.
    decoder.expirationFeeDefaultDays = CryptoNetworks.getExpirationFeeDefaultDays(network)
    decoder.xchainBlockDecoder = new XChainBlockDecoder(network)
}

function initializeDecoderProgress(decoder) {
    decoder.db = null
    decoder.mempoolDb = null
    decoder.fm = null

    decoder.debugTime = {}

    decoder.synced = false

    decoder.lastProcessedBlockIndex = -1
    decoder.blockchainInfoLastBlock = -1
    // Timestamp (ms) of the most recent successful getBlockchainInfo() call.
    // Zero means the tip has never been fetched. Used by getSyncStatus() to
    // flag a frozen tip so callers can distinguish a genuine zero lag from an
    // outage where the cached tip stopped advancing.
    decoder.blockchainInfoLastRefreshAt = 0
    // Timestamp (ms) of the most recent FORWARD advance of lastProcessedBlockIndex,
    // set at the top of the block loop and again on every committed block. Zero
    // means the loop has not started, which isStalled() reads as "not stalled".
    decoder.lastAdvanceAt = 0
    // Timestamp (ms) of the most recent parse-loop ITERATION, set at the loop top
    // whether or not a block arrived. Independent of chain progress on purpose:
    // it is the only signal that separates a loop that is idle because it is
    // caught up from a loop that is no longer running. Zero means the loop has
    // not iterated yet (still in initial sync), which isPollSilent() reads as
    // "not silent" so a booting decoder is never called dead.
    decoder.lastPollAt = 0
    // Structured logger from the observability shim, injected by api.js once
    // installObservability has run. Null until then, and every use falls back to
    // decoder.log, so a caller that never wires one (tests, migrate) still warns.
    decoder.obsLogger = null
    // Last logged value of isNodeHeightStale(), so the tip-stale warn is EDGE
    // triggered. The block loop re-evaluates roughly every 3s during a node
    // outage, so a level-triggered line would emit ~20 a minute for its duration.
    decoder._nodeHeightStaleLogged = false
    decoder.mempoolInterval = null
    decoder.mempoolBusy = false
    // Node-mempool observation snapshot from the last updateMempool cycle:
    // the coin node's TOTAL mempool tx count (getrawmempool length, XChain or
    // not) and when it was taken. -1/null until the first successful poll.
    // Read by the API's getmempool method so the explorer can show
    // "<node unconfirmed> / <XChain unconfirmed>" without its own node RPC.
    decoder.nodeMempoolTxCount = -1
    decoder.nodeMempoolUpdatedAt = null

}

function initializeDecoderMode(decoder) {
    decoder.stopFlag = false

    // Key the AuxPoW-stripping fetch path on coin identity ALONE, never on the
    // AUX_POW env flag: an 'auxpow' coin (Dogecoin) carries a merged-mining AuxPoW
    // section between the 80-byte header and the tx count, so the plain getBlock
    // path would wedge/misparse at the first merged-mined block, and a non-auxpow
    // coin (BTC, LTC) carries no such section, so stripping one truncates a valid
    // block whenever its version signals bit 0x100. Both directions are
    // read off the coin's declared wireFormat in the canonical registry (via
    // xchainBlockDecoder, built above), matching bulk-sync/dump.js. The `auxPow`
    // constructor parameter is retained for call-site stability (FEE_DESTINATION
    // follows it positionally) and is deliberately no longer consulted.
    decoder.auxPow = decoder.xchainBlockDecoder.wireFormat === 'auxpow'

    decoder.rpcErrors = 0
    decoder.parseErrors = 0
}

function initializeDecoderReorg(decoder) {
    // Lifetime reorg counters, mirroring xchain-utxo-tracker. Each rolled-back block
    // already writes a durable REORG row, but that trace is DB-only: without these a
    // metrics-only deployment (no monitor plugin, indexer possibly down) has no
    // scrapeable signal for a decoder thrashing through repeated shallow reorgs.
    // Counted once per completed verifyReorg run, so count is reorg EVENTS and depth
    // is the blocks rolled back by the most recent one.
    decoder.reorgCount = 0
    decoder.lastReorgDepth = 0

    // Consecutive block-fetch failures at _fetchErrorHeight. _fetchErrorCount counts
    // every failure (operator visibility); _auxPowParseErrorCount counts only the
    // AuxPoW-header-strip content faults that may escalate to per-tx block
    // reassembly. Both reset on a height change and on any success.
    decoder._fetchErrorHeight = null
    decoder._fetchErrorCount = 0
    decoder._auxPowParseErrorCount = 0

    // Latent REORG_HALT marker state. The durable marker written by verifyReorg
    // must also be visible to periodic health and status probes. These fields
    // cache that probe so a halted database cannot appear healthy between reorg
    // checks or qualify as a healthy bootstrap snapshot.
    // reorgHaltCheckedAt is the epoch-ms of the last successful probe
    // (0 = never probed), which also drives the TTL that keeps a hot monitoring
    // loop from issuing one query per request.
    decoder.reorgHalted = false
    decoder.reorgHaltReason = null
    decoder.reorgHaltAt = null
    decoder.reorgHaltCheckedAt = 0
    // Whether a REORG_HALT row is known to be READABLE, as distinct from
    // whether this decoder is halted. null = no halt has been raised or read
    // yet; false = a halt exists in memory whose durable write could not be
    // confirmed, which is the one state where a restart silently resumes the
    // rollback and the bootstrap gate finds nothing to refuse on.
    decoder.reorgHaltMarkerPersisted = null
    decoder._reorgHaltProbeInFlight = null
}

function initializeDecoderHaltState(decoder) {
    // Parse-loop park state for a REORG_HALT refusal (parkOnReorgHalt). Without a park
    // the refusal escapes start() and exits the process so the restart policy acts,
    // but the marker is restart-durable and only an operator clear releases it, so
    // an uncapped `--restart unless-stopped` turned one halt into an unbounded
    // restart loop: an operator's testnet decoder restarted 5737 times in three
    // days, and the restart count was the only surface that said so. Parked, the
    // loop stops parsing and the process stays up, which is what the CLI's restart
    // count, the halt-aware healthcheck and the audited clear all already assume.
    // reorgHaltParkedHeight is the stored tip the park began at, published so an
    // operator can tell a park from a latent marker on a decoder still advancing.
    decoder.reorgHaltParked = false
    decoder.reorgHaltParkedAt = null
    decoder.reorgHaltParkedHeight = null

    // Non-null only while the parse loop is waiting out a node in initial block
    // download whose tip sits below our stored tip (see the wait branch in
    // start()). That wait is otherwise indistinguishable from a wedge on every
    // health surface: the height stops moving and nothing says why. Published
    // verbatim as node_catching_up so `xchain-node ps` can name the wait.
    // Shape: { node_height, stored_height, since } where since is the ISO
    // timestamp the CURRENT wait began, held fixed until it ends.
    decoder.nodeCatchingUp = null
}

class XChainDecoder {
    constructor(network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, auxPow, feeDestination) {
        initializeDecoderIdentity(this, network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, feeDestination)
        initializeDecoderProgress(this)
        initializeDecoderMode(this)
        initializeDecoderReorg(this)
        initializeDecoderHaltState(this)
    }

    async start(){
        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN
        // before touching the DB or processing any block, mirroring the indexer.
        // A null pin (mainnet, pre-arm) skips; a mismatch on an armed network
        // throws and halts startup, so a partial/stale deploy cannot parse
        // on-chain bytes with divergent network params (fail-closed, deliberately
        // not wrapped in try/catch).
        coins.verifyConsensusPin(this.consensusNetwork)

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
            // gated for an explicit operator run (`node src/migrate.js`). Recorded in the
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

        // Re-derive the loop cursors from the DB after any mid-block rollback, then
        // pause before the retry. Every rollback path MUST run this before continuing:
        // in particular lastProcessedTxIndex advances in memory while a block is being
        // parsed, so retrying a rolled-back block with the stale counter would assign
        // different tx_index values than a clean instance decoding the same block
        // (replicated content, so that is a cross-instance divergence, not cosmetics).
        const resetAfterRollback = async () => {
            lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
            lastProcessedTxIndex = await this.db.getLastTxIndex()
            blocksQuantity = 0
            await this.sleep(3000)
        }

        // Answer a failed reconcile: park on a REORG_HALT refusal, rethrow anything
        // else. Shared by the three verifyReorg call sites so all three classify a halt
        // the same way; before this, two of them let it escape start() into the
        // exit-and-restart loop parkOnReorgHalt exists to end.
        const parkOrRethrow = (err, blockHeight) => {
            if (!(err && err.reorgHalt)) throw err
            this.parkOnReorgHalt(err.message, blockHeight)
        }

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
                if (!(await this.resumeFromReorgHaltPark())){
                    await this.sleep(REORG_HALT_PARK_TICK_MS)
                    continue main_parsing
                }
                // Resumed. Re-derive the cursors from the stored tip exactly as the
                // rollback paths do, and drop the cached tip so the next pass re-polls
                // the node and re-runs the reorg check the clear has now unblocked.
                lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                lastProcessedTxIndex = await this.db.getLastTxIndex()
                blocksQuantity = 0
                lastBlockchainInfo = null
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
            if (!lastBlockchainInfo
                || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                || (Date.now() - lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                try {
                    lastBlockchainInfo = await this.connector.getBlockchainInfo()

                    // Validate the shape before any field is used. A trimmed RPC-proxy
                    // response or a per-coin getblockchaininfo variant could omit these
                    // fields; without this guard `undefined < 0.99` is false (the
                    // not-synced gate silently passes) and `blocks` becomes undefined
                    // (every later height comparison quietly goes wrong). Mirror the
                    // typeof-number discipline verifyReorg's tip refresh already applies
                    // and treat a malformed result like the RPC-failure branch below.
                    if (!lastBlockchainInfo
                        || typeof lastBlockchainInfo["blocks"] !== 'number'
                        || typeof lastBlockchainInfo["verificationprogress"] !== 'number'){
                        logger.info("Malformed getblockchaininfo response (missing or non-numeric 'blocks'/'verificationprogress'). Trying again...")
                        lastBlockchainInfo = null
                        await this.sleep(3000)
                        continue
                    }

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
                        if (!wrongChainProblem){
                            this.logError('Refusing to decode: ' + chainMismatch +
                                '. Point the decoder at a ' + this.consensusNetwork + ' node and restart.')
                        }
                        wrongChainProblem = true
                        lastBlockchainInfo = null
                        await this.sleep(3000)
                        continue
                    }
                    wrongChainProblem = false

                    // `chain` absent is NOT read as agreement. It fails open (a trimmed RPC
                    // proxy must not stall the fleet over a hazard only a misconfiguration
                    // creates), so the unchecked state is said out loud once instead.
                    if (chainFieldMissing(lastBlockchainInfo["chain"]) && !chainFieldMissingLogged){
                        chainFieldMissingLogged = true
                        this.log("getblockchaininfo carries no 'chain' field, so the endpoint's network tier cannot be verified; " +
                            'endpoint-to-network binding rests on deployment config alone.')
                    }

                    // Re-prove the CHAIN, not just the tier, on the same throttled
                    // cadence. Boot-time verification alone is not enough: NODE_URL_FALLBACK
                    // can move this decoder onto a different endpoint mid-run, and the failover
                    // target is exactly where a wrong-coin URL hides. Its own timestamp keeps
                    // this to one extra getblockhash per BLOCKCHAIN_INFO_REFRESH_MS instead of
                    // one per loop iteration (a caught-up loop re-polls the tip constantly, and
                    // block 0 cannot move under a chain that is still the same chain).
                    if (!chainGenesisUnpinned(this.chainGenesisHash)
                        && (Date.now() - this.chainGenesisCheckedAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                        const genesisMismatch = await this.verifyChainGenesis()
                        if (genesisMismatch){
                            if (!wrongGenesisProblem){
                                this.logError('Refusing to decode: ' + genesisMismatch +
                                    '. Point the decoder at a ' + this.coinTick + '/' + this.consensusNetwork +
                                    ' node and restart.')
                            }
                            wrongGenesisProblem = true
                            lastBlockchainInfo = null
                            await this.sleep(3000)
                            continue
                        }
                        wrongGenesisProblem = false
                    }

                    if (lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
                        if (!nodeSyncedProblem){
                            logger.info("The node is not synced. Waiting for it to synchronize...")
                        }
                        
                        lastBlockchainInfo = null
                        nodeSyncedProblem = true
                        await this.sleep(3000)
                        continue
                    } else {
                        nodeSyncedProblem = false
                    }
                    
                    this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
                    lastBlockchainInfoRefreshAt = Date.now()
                    this.blockchainInfoLastRefreshAt = lastBlockchainInfoRefreshAt
                } catch (e){
                    logger.info(e)
                    logger.info(formatLogLine("Error trying to get network info from the node. Trying again...", e))
                    await this.sleep(3000)
                    continue
                }
                
                // The usual end of an IBD wait: the node's tip reached our height, so the
                // tip-regression branch below is simply never entered again and the
                // in-branch clear cannot fire. Without this the finished wait would stay
                // on every health payload for the life of the process. The log latch is
                // deliberately NOT cleared here: it speaks only for the branch below.
                if (this.nodeCatchingUp && lastProcessedBlockIndex <= this.blockchainInfoLastBlock){
                    this.nodeCatchingUp = null
                }

                if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
                    if (lastProcessedBlockIndex == this.startBlockIndex - 1){
                        // Benign: we have processed nothing yet and the node simply
                        // hasn't reached our configured start height. Wait, don't reorg.
                        logger.info("Last block from the node ("+this.blockchainInfoLastBlock+") is still behind the starting block ("+this.startBlockIndex+")")
                        await this.sleep(5000)
                        continue
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
                        if (!nodeCatchingUpProblem){
                            this.logWarn("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"), but the node reports initialblockdownload=true: it is still catching up, not rolled back. Waiting for it to pass "+lastProcessedBlockIndex+" instead of reconciling; the hash compare decides then.")
                        }
                        const since = (this.nodeCatchingUp && this.nodeCatchingUp.since) || new Date().toISOString()
                        this.nodeCatchingUp = { node_height: this.blockchainInfoLastBlock, stored_height: lastProcessedBlockIndex, since }
                        nodeCatchingUpProblem = true
                        await this.sleep(5000)
                        continue
                    }
                    if (nodeCatchingUpProblem){
                        this.log("The node has left initial block download with its tip ("+this.blockchainInfoLastBlock+") still below the last processed block ("+lastProcessedBlockIndex+"); treating the gap as a rollback from here on.")
                        nodeCatchingUpProblem = false
                    }
                    this.nodeCatchingUp = null

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
                    if (!tipBelowStoredTipRefused){
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
                            if (!tipBelowStoredTipRefused){
                                this.logError(err.message)
                            }
                            tipBelowStoredTipRefused = true
                            await this.sleep(5000)
                            continue
                        }
                        parkOrRethrow(err, lastProcessedBlockIndex)
                        continue main_parsing
                    }
                    tipBelowStoredTipRefused = false
                    // Re-clamp: a deep reorg can empty the blocks table, causing
                    // getLastBlockIndex() to return -1 and nextBlockHeight to become 0
                    // on a nonzero-start network. Clamp here, the same as the pre-loop guard.
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                    lastProcessedTxIndex = await this.db.getLastTxIndex()
                    blocksQuantity = 0
                    transactionsCount = 0
                    validTransactionsCount = 0
                    outputCount = 0
                    startTimeStamp = Date.now()
                    this.log("Blocks were updated after node-tip regression")
                    continue
                }
            }
            
            //If there is no new block, wait for some seconds to ask again
            if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                this.synced = true
                if (this.mempoolInterval == null){
                    logger.info("Mempool parsing started!")
                    this.updateMempool().catch(err => logger.error(formatLogLine('[updateMempool] unhandled error:', err)))
                    this.mempoolInterval = setInterval(() => {
                        this.updateMempool().catch(err => logger.error(formatLogLine('[updateMempool] unhandled error:', err)))
                    }, MEMPOOL_INTERVAL)
                }

                // Equal-height tip-replacement check: if the node swapped its tip
                // for a different block at the same height (rare but possible), the
                // forward hash-compare below never fires until the NEXT block arrives.
                // Compare the node's current tip hash against the stored one on each
                // blockchain-info refresh (throttled so we add at most one RPC + one
                // DB query per 30-second refresh cycle, not every 1-second sleep tick).
                if (lastBlockchainInfoRefreshAt > tipHashCheckedAt && lastProcessedBlockIndex >= this.startBlockIndex){
                    tipHashCheckedAt = lastBlockchainInfoRefreshAt
                    // Guard ONLY the detection reads: an RPC/DB blip there is transient and
                    // should log-and-skip until the next refresh, as before.
                    let needsReconcile = false
                    try {
                        const nodeHash = await this.connector.getBlockHash(lastProcessedBlockIndex)
                        const storedBlock = await this.db.getBlockByIndex(lastProcessedBlockIndex)
                        needsReconcile = !!(storedBlock && nodeHash && storedBlock.block_hash !== nodeHash)
                    } catch (e){
                        logger.error(formatLogLine('Error during equal-height tip-hash detection reads, skipping:', e))
                    }
                    if (needsReconcile){
                        // Run the reconcile OUTSIDE the detection try so a fail-closed verifyReorg
                        // abort is never swallowed as a transient blip, which left a partially
                        // rolled-back DB under a stale in-memory cursor while this.synced stayed
                        // true. Its own catch classifies rather than swallows: a REORG_HALT
                        // refusal parks the loop (nothing a restart can fix), every other abort
                        // still propagates out of start() and halts loudly.
                        this.log("Equal-height tip replacement detected at height " + lastProcessedBlockIndex + ". Reconciling...")
                        await this.db.endTransaction()
                        try {
                            await this.verifyReorg(this.blockchainInfoLastBlock)
                        } catch (err){
                            parkOrRethrow(err, lastProcessedBlockIndex)
                            continue main_parsing
                        }
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        continue
                    }
                }

                await this.sleep(CHECK_BLOCK_DELAY_MS)
            } else { //If there is a new block, parse it
                // Too far behind to serve mempool: drop out of synced mode and stop the
                // mempool timer until catch-up finishes.
                if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
                    this.synced = false
                    if (this.mempoolInterval != null){
                        logger.info("Mempool updates stopped!")
                        clearInterval(this.mempoolInterval)
                        this.mempoolInterval = null
                    }   
                }
                
                let nextBlockHeight = lastProcessedBlockIndex + 1
            
                let nextBlockHash = null
                let nextBlockHex = null
                // Track consecutive fetch failures at this exact height. A transient
                // RPC hiccup clears on the next success; a deterministic failure (e.g.
                // a malformed AuxPoW section that makes getBlockWithoutAuxPow throw)
                // would otherwise retry here silently forever. We never skip the block
                // (that would corrupt the index): after a few attempts we escalate to
                // parseErrors so the stall is visible to monitoring, and on an AuxPoW
                // chain fetchBlockHex switches to per-tx block reassembly, which
                // recovers the identical pure block without touching the AuxPoW bytes.
                //
                // TWO counters, because they answer different questions.
                // _fetchErrorCount counts EVERY consecutive failure at this height and
                // exists purely for operator visibility (the parseErrors bump below), so
                // a stall stays observable on non-AuxPoW chains too. Only
                // _auxPowParseErrorCount, which counts content faults, drives the
                // per-tx reassembly escalation in fetchBlockHex.
                if (this._fetchErrorHeight !== nextBlockHeight) {
                    this._fetchErrorHeight = nextBlockHeight
                    this._fetchErrorCount = 0
                    this._auxPowParseErrorCount = 0
                }
                try {
                    nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)
                    nextBlockHex = await this.fetchBlockHex(nextBlockHash, nextBlockHeight)
                    this._fetchErrorCount = 0
                    this._auxPowParseErrorCount = 0
                } catch (e){
                    this._fetchErrorCount++
                    // Only a fault in the AuxPoW header strip is evidence that THIS BLOCK's
                    // bytes are the problem; getBlockWithoutAuxPow tags those (and only
                    // those) with auxPowParseFailure. A transport fault, which on a
                    // Dogecoin 1.14 node under RPC-queue pressure arrives as a bare
                    // ECONNRESET/ECONNREFUSED socket error, propagates untagged and must
                    // not push this height toward per-tx reassembly.
                    if (e && e.auxPowParseFailure) {
                        this._auxPowParseErrorCount++
                    }
                    if (this._fetchErrorCount === 5) {
                        this.parseErrors++
                    }
                    logger.error(formatLogLine('Error fetching block at height ' + nextBlockHeight + ' (attempt ' + this._fetchErrorCount + '):', e))
                    await this.sleep(3000)
                    continue
                }
                
                // A throw here would otherwise escape start() and permanently stop the
                // decode loop (api.js only logs the rejection), wedging the pipeline at
                // this height. Never skip a whole block: a block we cannot decode is a
                // parser bug, not data to discard. Stay alive and keep retrying so
                // the process remains visible to health checks and recovers if the
                // failure was transient (e.g. corrupted RPC response).
                var block = null
                let previousBlockHash = null
                try {
                    block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
                    previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
                } catch (e){
                    this.parseErrors++
                    logger.error(formatLogLine(`Failed to decode block ${nextBlockHeight} (${nextBlockHash}), retrying:`, e))
                    await this.db.endTransaction()
                    lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                    lastProcessedTxIndex = await this.db.getLastTxIndex()
                    blocksQuantity = 0
                    await this.sleep(3000)
                    continue
                }

                //verify if there is an reorg
                if (nextBlockHeight > this.startBlockIndex){
                    let previousBlock = null
                    try {
                        previousBlock = await this.db.getBlockByIndex(nextBlockHeight - 1)
                    } catch (err){
                        // getBlockByIndex retries internally and THROWS when the read never
                        // succeeds, so a failed read and a missing row are distinct cases;
                        // both warrant the same response here, retry this height. The throw
                        // must not escape start(), which would permanently stop the parse
                        // loop (api.js only logs the rejection). Same log prefix as the
                        // missing-row branch below so the retry regression coverage matches.
                        logger.error(formatLogLine(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`, err))
                        await this.sleep(3000)
                        continue
                    }

                    // A null now means the row is genuinely absent (never a DB error). That
                    // still previously dereferenced straight into `previousBlock.block_hash`
                    // (TypeError), escaped start(), and permanently stopped the parse loop.
                    // Treat it as transient and retry this height, matching the block-fetch
                    // error path above.
                    if (!previousBlock){
                        logger.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`)
                        await this.sleep(3000)
                        continue
                    }

                    //previousBlockHash is not the same, it must be a reorg
                    if (previousBlockHash != previousBlock.block_hash){
                        await this.db.endTransaction()
                        this.logWarn("A reorg has been detected at block " + nextBlockHeight + ". Cleaning blocks...")
                        const preReorgBlock = lastProcessedBlockIndex
                        try {
                            await this.verifyReorg(this.blockchainInfoLastBlock)
                        } catch (err){
                            // A REORG_HALT refusal parks the loop instead of exiting the
                            // process; every other abort still propagates and halts loudly.
                            parkOrRethrow(err, lastProcessedBlockIndex)
                            continue main_parsing
                        }
                        // Re-clamp: same as the pre-loop guard and the node-tip regression path.
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                        // Count rolled-back blocks as the difference between the pre-reorg tip
                        // and the newly confirmed last good block so the log entry is actionable.
                        const rolledBackCount = Math.max(0, preReorgBlock - lastProcessedBlockIndex)
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        transactionsCount = 0
                        validTransactionsCount = 0
                        outputCount = 0
                        startTimeStamp = Date.now()
                        this.log("Blocks were updated (" + rolledBackCount + " blocks rolled back)")
                        continue
                    }
                }


                if (blocksQuantity == 0){
                    await this.db.beginTransaction()
                }
                
                if (!(await this.db.insertBlock(
                    {
                        block_index:nextBlockHeight,
                        block_hash:nextBlockHash, 
                        block_time:block.timestamp,
                        previous_block_hash:previousBlockHash
                    }
                ))){
                    // insertBlock's error path already rolled the block transaction back.
                    logger.info("Error trying to insert a Block to the database")
                    await resetAfterRollback()
                    continue main_parsing
                }

                // WHERE the dispenser soft-expire runs is a consensus decision, so it rides a
                // flag-day (DISPENSER_EXPIRY_REALIGN_ACTIVATION, keyed on block TIME).
                //
                // LEGACY (below the gate): here, at block START, before the transaction loop.
                // The open-dispenser address set loaded just below therefore excludes anything
                // this block's header time expired, so payments to it are not captured. The
                // INDEXER expires at block END (utility.processExpirations), so for every tx in
                // this same block it still treats that dispenser as open, and since it only sees
                // outputs the decoder persisted, the boundary block pays coin with no DISPENSE.
                // That defect is preserved verbatim below the gate: a from-genesis re-decode has
                // to reproduce what the fleet actually wrote, byte for byte.
                //
                // REALIGNED (at/above the gate): skipped here and run after the transaction loop
                // instead (same block transaction), which puts both services' measurement points
                // in the same place so a boundary block yields the same DISPENSE set on both.
                const expireDispensersAtBlockEnd =
                    isDispenserExpiryRealignActive(this.consensusNetwork, block.timestamp)

                //Soft-expire open dispensers past their expiration (marks them with
                //this block height instead of deleting, so a reorg can restore them).
                //false means the UPDATE failed and the block transaction was already
                //rolled back; continuing would land every subsequent write on fresh
                //autocommit connections OUTSIDE any transaction (durable rows the
                //rollback was meant to discard), so retry the block instead.
                if (!expireDispensersAtBlockEnd &&
                    (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
                    logger.error(`deleteOpenDispensers failed at block ${nextBlockHeight}; block rolled back, retrying`)
                    await resetAfterRollback()
                    continue main_parsing
                }

                // Load the set of open-dispenser addresses once for this block (below the
                // realign gate, after expiring stale ones above; at/above it, before any
                // expiry runs, which is the whole point: a dispenser this block's header
                // time passes is still open for every tx in the block, as the indexer has
                // it) so parseTransaction can test each output
                // against it in JS instead of issuing one DB query per output; the
                // per-output lookup was thousands of serialized round-trips per mainnet
                // block. Kept current within the block by .add()ing any dispenser opened
                // by a transaction below, matching the previous per-output query timing.
                // null signals the query failed: decoding the block against an empty set
                // would silently drop every dispense output on this instance only, so
                // retry the block instead.
                //
                // CANCELLATION GRACE (at/above DISPENSER_CANCEL_GRACE_ACTIVATION): the floor
                // widens the set by dispensers whose expiration is inside the indexer's
                // cancellation grace period, which the indexer keeps fillable for an hour past
                // a cancel while the decoder's soft-expire knows nothing about cancels. Below
                // the gate the floor is null and the set is the unwidened one, so a
                // from-genesis re-decode reproduces what the fleet wrote. The floor derives
                // only from this block's header time, so every honest node loads the same set.
                let openDispenserAddresses = await this.db.getAllOpenDispenserAddresses(
                    cancelGraceFloor(this.consensusNetwork, block.timestamp))
                if (openDispenserAddresses == null){
                    logger.error(`Could not load open dispenser addresses for block ${nextBlockHeight}; retrying block`)
                    await this.db.endTransaction()
                    await resetAfterRollback()
                    continue main_parsing
                }

                var transactions = block.transactions
                blocksCount = blocksCount + 1

                for (let txIndex=0;txIndex < transactions.length;txIndex++){
                    let nextTransaction = transactions[txIndex]
                    let nextTransactionHash = null
                    let parseResult = null

                    // Insert-quarantine skip: this tx position deterministically failed to
                    // INSERT on a prior pass of this block. Skip it exactly like a quarantined
                    // parse-throw - PARSE_ERROR event, NO tx_index consumed, no insert - so a
                    // poison row cannot wedge the block. The block transaction is open here
                    // (beginTransaction ran when blocksQuantity hit 0), so the event commits
                    // with the block. Deterministic across instances, so parity holds.
                    if (insertQuarantine.has(nextBlockHeight + ':' + txIndex)){
                        this.parseErrors++
                        let quarantinedHash = null
                        try { quarantinedHash = nextTransaction.getId() } catch(_){ /* unparseable id; leave null */ }
                        let eventResult = await this.db.insertEvent("PARSE_ERROR", {
                            block_index: nextBlockHeight,
                            tx_position: txIndex,
                            tx_hash: quarantinedHash,
                            error: 'deterministic INSERT failure (quarantined after ' + TX_PARSE_MAX_RETRIES + ' block retries)'
                        }, block.timestamp)
                        if (eventResult === false){
                            // insertEvent already rolled the block transaction back
                            await resetAfterRollback()
                            continue main_parsing
                        }
                        continue
                    }

                    try {
                        nextTransactionHash = nextTransaction.getId()
                        parseResult = await this.parseTransaction(nextTransaction, openDispenserAddresses, undefined, nextBlockHeight)
                    } catch (e){
                        if (e && e.rpcLookupFailure){
                            // A prevout/fee-output RPC lookup failed even after the
                            // connector's internal retries. That is node/infrastructure
                            // trouble, not a poison transaction: quarantining would make
                            // this instance skip a tx every healthy instance accepts
                            // (instance-dependent block contents). Retry the block
                            // indefinitely instead; rpc_errors/health make the stall
                            // visible while the node recovers.
                            logger.error(formatLogLine(`RPC lookup failed in block ${nextBlockHeight} (tx position ${txIndex}), retrying block:`, e))
                            await this.db.endTransaction()
                            await resetAfterRollback()
                            continue main_parsing
                        }

                        if (txParseRetryHeight != nextBlockHeight){
                            txParseRetryHeight = nextBlockHeight
                            txParseRetryCount = 0
                        }
                        txParseRetryCount++

                        if (txParseRetryCount <= TX_PARSE_MAX_RETRIES){
                            // Could be transient (DB hiccup inside parseTransaction):
                            // roll the block back and re-parse it from scratch.
                            logger.error(formatLogLine(`parseTransaction failed in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${txParseRetryCount}/${TX_PARSE_MAX_RETRIES}), retrying block:`, e))
                            await this.db.endTransaction()
                            await resetAfterRollback()
                            continue main_parsing
                        }

                        // The transaction keeps throwing after whole-block retries: treat it
                        // as a poison transaction and quarantine it (skip + audit event) so
                        // one undecodable tx cannot wedge the pipeline at this height forever.
                        this.parseErrors++
                        logger.error(formatLogLine(`Quarantining undecodable tx in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries:`, e))
                        let eventResult = await this.db.insertEvent("PARSE_ERROR", {
                            block_index: nextBlockHeight,
                            tx_position: txIndex,
                            tx_hash: nextTransactionHash,
                            error: String((e && e.message) || e)
                        }, block.timestamp)
                        if (eventResult === false){
                            // insertEvent already rolled the block transaction back
                            await resetAfterRollback()
                            continue main_parsing
                        }
                        continue
                    }
                    
                    if (parseResult != null){
                        let dispenseOutputs = parseResult['dispenseOutputs']

                        if (this.hasStorableContent(parseResult)){
                            lastProcessedTxIndex = lastProcessedTxIndex + 1
                            validTransactionsCount = validTransactionsCount + 1

                            // Storage gate (buildStoredActionRecord): a tx can carry BOTH an
                            // XChain ACTION and money-bearing dispense/payment outputs. When the
                            // ACTION is oversized or names an unknown action, those outputs are
                            // NOT dropped: the bad action is blanked and the row is still
                            // written. Only a tx with nothing else to record is skipped, and
                            // that skip still consumes a tx_index (changing tx_index assignment
                            // for invalid-action txs would diverge from already-decoded history).
                            let stored = this.buildStoredActionRecord(parseResult, nextTransactionHash, false)
                            if (stored.skip) continue
                            // The canonical ACTION string as stored; the dispenser and
                            // COINPAY handling below reads the same value the row holds.
                            let decodedData = stored.data

                            let insertResult = await this.db.insertTransaction({
                                index: lastProcessedTxIndex,
                                hash: nextTransactionHash,
                                block_index: nextBlockHeight,
                                source: parseResult["source"],
                                source_pubkey: parseResult["sourcePubkey"],
                                destination: parseResult["destination"],
                                amount: parseResult["amount"],
                                fee: 0,
                                data: stored.data,
                                raw_data: stored.rawData

                            })
                            if (insertResult === this.db.POISON_ROW){
                                // Deterministic content/constraint rejection (block already
                                // rolled back by insertTransaction). Retrying the block would
                                // wedge it forever. Bound the retries like a parse-throw, then
                                // quarantine this tx position so the re-parse skips it. (The
                                // retry margin guards against a misclassified transient error;
                                // the errno set is conservative, so this normally quarantines
                                // on the first exceedance.)
                                if (insertQuarantineHeight != nextBlockHeight){
                                    insertQuarantineHeight = nextBlockHeight
                                    insertQuarantineCount = 0
                                }
                                insertQuarantineCount++
                                if (insertQuarantineCount > TX_PARSE_MAX_RETRIES){
                                    insertQuarantine.add(nextBlockHeight + ':' + txIndex)
                                    logger.error(`Quarantining tx with deterministic INSERT failure in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries`)
                                } else {
                                    logger.error(`insertTransaction deterministic failure in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${insertQuarantineCount}/${TX_PARSE_MAX_RETRIES}), retrying block`)
                                }
                                await resetAfterRollback()
                                continue main_parsing
                            } else if (insertResult === false){
                                // Transient INSERT failure; insertTransaction's error path
                                // already rolled the block back. Retry indefinitely (never skip
                                // a tx a healthy instance accepts).
                                await resetAfterRollback()
                                continue main_parsing
                            } else {
                                //Store dispenses outputs. false means the INSERT failed and
                                //the block transaction was already rolled back: stop writing
                                //(anything further would land outside a transaction) and
                                //retry the block.
                                for (let nextOutput of dispenseOutputs){
                                    nextOutput.txIndex = lastProcessedTxIndex
                                    let insertResult = await this.db.insertTransactionOutput(
                                        nextOutput
                                    )
                                    if (insertResult === false){
                                        logger.error(`insertTransactionOutput (dispense) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                        await resetAfterRollback()
                                        continue main_parsing
                                    }
                                    if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                        logger.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
                                    }
                                }

                                //Store payment outputs the indexer needs to read:
                                //  • COINPAY: every native-coin output (settlement is determined
                                //    per-output; the indexer fans out per-output by LEFT JOIN-ing
                                //    transaction_outputs in getDecoderBlockData).
                                //  • Any action: the native-coin fee output paying the protocol
                                //    FEE_DESTINATION, so the indexer can validate native-coin fee
                                //    payments (xchain-indexer/src/utility.js detectFeePaymentMode /
                                //    validateNativeCoinFee). Captured only when feeDestination is set.
                                //  • DISPENSER v0/v2: the PRICE v1 oracle-usage-fee output paying
                                //    the dispenser's ORACLE_ADDRESS, so the indexer can validate it
                                //    (utility.validateOracleFee). Gated on
                                //    ORACLE_FEE_OUTPUT_ACTIVATION, and a v2 refill resolves to one
                                //    address or to the source's whole open set depending on
                                //    ORACLE_FEE_SET_CAPTURE_ACTIVATION; see
                                //    resolveOracleFeeAddresses.
                                // The action strings the capture decision is taken over. Both tests
                                // below used to read the TOP-LEVEL action name only, so a BATCH
                                // carrying either action persisted nothing and its settlement
                                // never reached the indexer. For a non-BATCH transaction, and for
                                // every block below BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION,
                                // this list is exactly [decodedData] and both tests reduce to the
                                // startsWith they replace; at/above the gate a BATCH yields its
                                // SUB-COMMANDS instead, split to agree with
                                // xchain-indexer/src/actions/batch.js (see batchSubCommandCapture).
                                let commands = captureCommands(decodedData, this.consensusNetwork, block.timestamp)
                                let isCoinpay = commands.some(nextCommand => nextCommand.startsWith("COINPAY|"))
                                let oracleFeeAddresses = await this.resolveOracleFeeAddressesForCommands(commands, parseResult["source"], block.timestamp, nextTransactionHash)
                                if (oracleFeeAddresses === false){
                                    // Deterministic DB fault while resolving a refill's oracle
                                    // address. Capturing nothing here would drop an output a
                                    // healthy node captures, so retry the block instead.
                                    logger.error(`resolveOracleFeeAddresses failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                    await resetAfterRollback()
                                    continue main_parsing
                                }
                                // Membership set, empty when this transaction is associated with no
                                // oracle at all. Below ORACLE_FEE_SET_CAPTURE_ACTIVATION it holds at
                                // most the one legacy pick, so the capture decision is identical to
                                // the equality test it replaced.
                                let oracleFeeAddressSet = new Set(oracleFeeAddresses)
                                if (isCoinpay || this.feeDestination || oracleFeeAddressSet.size > 0){
                                    for (let nextOutput of parseResult["paymentOutputs"]){
                                        // Both address tests are truthiness-guarded: an unset
                                        // feeDestination is null, and an output whose address could
                                        // not be resolved is null too, so a bare !== comparison
                                        // would capture it by accident. The oracle test is set
                                        // membership rather than equality (a v2 refill can resolve
                                        // to several open dispensers' oracles above the flag-day),
                                        // and the set never holds a null member, so an unresolved
                                        // output address cannot match it either.
                                        let isFeeOutput    = this.feeDestination && nextOutput.destinationAddress === this.feeDestination
                                        let isOracleOutput = nextOutput.destinationAddress && oracleFeeAddressSet.has(nextOutput.destinationAddress)
                                        if (!isCoinpay && !isFeeOutput && !isOracleOutput)
                                            continue
                                        nextOutput.txIndex = lastProcessedTxIndex
                                        let insertResult = await this.db.insertTransactionOutput(
                                            nextOutput
                                        )
                                        if (insertResult === false){
                                            logger.error(`insertTransactionOutput (payment) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                            await resetAfterRollback()
                                            continue main_parsing
                                        }
                                        if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                            logger.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
                                        }
                                    }
                                }
                                
                                //Catch any dispenser message to add it to
                                //the list of possible dispenses.
                                //
                                //v0 wire format (must stay in sync with the
                                //indexer (see xchain-indexer/src/actions/dispenser.js):
                                //  DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT
                                //    |GIVE_OWNERSHIP|GIVE_ESCROW
                                //    |GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS
                                //    |FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS
                                //    |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
                                //
                                // THE COMMAND VIEW IS `commands` ABOVE, deliberately the same
                                // variable and therefore the same flag-day as payment-output
                                // capture: [decodedData] for every non-BATCH transaction and for
                                // every block below BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION, the
                                // BATCH's sub-commands at/above it. Registration and capture are two
                                // halves of ONE decision (this registry IS the address set that
                                // decides which outputs are captured as dispenses), so arming them at
                                // different instants would leave the decoder half-batch-aware for no
                                // gain. Below the gate a BATCH's sub-commands stay invisible here
                                // exactly as they were, and the walk reduces to the single
                                // `decodedData.startsWith("DISPENSER")` test it replaces, so a
                                // from-genesis re-decode is byte-identical.
                                //
                                // What was broken: that top-level test is false for
                                // `BATCH|0|DISPENSER|0|...`, so a dispenser created inside a batch
                                // never entered the open set, its buyer's payments were never
                                // captured, and no DISPENSE ever fired - while the INDEXER, which
                                // dispatches the sub-command, registered it. Money-bearing, and a
                                // live decoder/indexer divergence.
                                //
                                // TWO PASSES, both in sub-command position order:
                                //   1. every v0 create is validated, the set is collapsed to one
                                //      registration per OPERATING ADDRESS (see
                                //      collapseDispenserRegistrations: the dispensers PRIMARY KEY is
                                //      (tx_index, address_id), which a batch can collide with), and
                                //      the survivors are inserted;
                                //   2. the format-1/2 lifecycle mirrors run AFTERWARDS, so an edit
                                //      anywhere in the batch reaches a dispenser created anywhere in
                                //      the same batch. The indexer dispatches in strict position
                                //      order, so an edit placed BEFORE its create fails there while
                                //      the decoder extends a row: that is the hold-open-longer
                                //      direction its advisory contract permits. The reverse ordering
                                //      would let an edit AFTER its create miss the row, which closes
                                //      early - the money-bearing direction.
                                //
                                // Per sub-command, not per transaction: EXPIRATION is read from THIS
                                // command's field [14] (defaulting from the shared block time, as the
                                // indexer's own default does), and the operating address from THIS
                                // command's GET_ADDRESS. There is no per-sub-command DISPENSER_ACTION_INDEX
                                // to reproduce: the indexer mints one per sub-command from its own
                                // action_index sequence (actions/batch.js -> db.createActionIndex ->
                                // getNextActionIndex), an id space the decoder has never held for
                                // top-level dispensers either. These rows are keyed on
                                // (tx_index, operating address) and nothing here is keyed on an
                                // action index, so nothing is approximated by not having one.
                                //
                                // THE PREFIX CARRIES ITS DELIMITER at/above the same gate, and only
                                // there. `startsWith("DISPENSER")` selects on a bare action NAME, but
                                // the wire delimits the name with '|', so it also matches every
                                // longer string sharing that head: `DISPENSERX|0|...`, which
                                // xchain-indexer/src/actions/index.js dispatches nowhere, and the real but
                                // indexer-SYNTHESIZED DISPENSER_CLOSE / DISPENSER_EXPIRE (both sit in
                                // FEE_QUOTE_EXEMPT beside DISPENSE and ORDER_MATCH), whose
                                // wire-spelled form carries no resolvable DISPENSER_ACTION_INDEX and
                                // so resolves no dispenser there either. The indexer runs NOTHING for
                                // any of them while the bare prefix has the decoder splitting on '|',
                                // reading field [1] as a DISPENSER FORMAT, and registering a create
                                // (or extending an open row on a format-2 read). The registry IS the
                                // set that decides which outputs become DISPENSE outputs, so the
                                // decoder then captures dispenses no indexer will ever settle. The
                                // direction is over-capture, which is why it was survivable and why
                                // it closes on a flag-day rather than as a hotfix.
                                //
                                // WHERE IT IS ACTUALLY REACHABLE, which is not where it looks. NOT at
                                // the top level: buildStoredActionRecord runs the VALID_ACTION_NAMES
                                // gate first, and that set holds 'DISPENSER' and no other name
                                // beginning DISPENSER, so `DISPENSERX|...` is blanked to '' before
                                // this walk ever sees it. The one top-level string that survives that
                                // gate and still misses `DISPENSER|` is the bare token 'DISPENSER'
                                // with no pipe at all, whose field [1] is undefined and whose FORMAT
                                // therefore parses NaN, matching no branch below either way.
                                // Sub-commands get NO such gate: the name checked was BATCH, and
                                // nothing re-checks the pieces. Row 26's walk is what made this
                                // reachable, and `BATCH|0|DISPENSERX|0|...` really does register.
                                //
                                // WHY IT IS GATED ANYWAY, given that the below-gate branch is a
                                // provable no-op today. That proof rests entirely on the membership
                                // of VALID_ACTION_NAMES, a set that can gain a DISPENSER-prefixed
                                // name later; the day it does, a from-genesis re-decode of history
                                // BELOW the flag-day must still reproduce the over-captured rows the
                                // fleet wrote, and only a gate can promise that in advance. It rides
                                // BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION rather than a constant
                                // of its own because that gate is BUILT AND STILL UNARMED on mainnet:
                                // the tightening costs no flag-day, and the inheritance it closes
                                // arms in the same instant that introduced it. A second constant
                                // would arm one half of one decision separately.
                                //
                                // `DISPENSER|` is the whole tightening: DISPENSER has no legacy
                                // VERSION-less wire form to spare (actions.js injects VERSION 0 for
                                // ISSUE/MINT/SEND only), and no alias resolves to it (ACTION_ALIASES
                                // is TRANSFER/ADDR/DROP/CAST/MSG), so every form the indexer
                                // dispatches to actionDispenser literally begins 'DISPENSER|'.
                                const dispenserCommandPrefix =
                                    isBatchSubCommandCaptureActive(this.consensusNetwork, block.timestamp)
                                        ? "DISPENSER|"
                                        : "DISPENSER"
                                let dispenserCreateCandidates = []
                                for (let dispenserCommand of commands){
                                    if (typeof dispenserCommand !== 'string' || !dispenserCommand.startsWith(dispenserCommandPrefix))
                                        continue
                                    let decodedDataSplit = dispenserCommand.split("|")
                                    // Field [1] is the DISPENSER FORMAT (create=0, cancel=1,
                                    // edit=2; xchain-indexer/src/actions/dispenser.js this.formats).
                                    // The decoder mirrors all three so its open-dispenser view (the
                                    // address set that gates transaction_output capture) tracks the
                                    // same lifecycle the indexer derives. Formats 1 and 2 reference
                                    // the target by DISPENSER_ACTION_INDEX, an id in the INDEXER's
                                    // global action_index space that the decoder does not maintain
                                    // (same unresolvable id space as the ^<id> GET_ADDRESS the
                                    // create path fails loud on). The decoder therefore resolves the
                                    // target by the cancel/edit tx SOURCE address: the indexer gates
                                    // both on SOURCE == dispenser SOURCE or GET_ADDRESS, and the
                                    // decoder row records BOTH of those addresses (address_id = the
                                    // operating address, source_address_id = the create SOURCE when
                                    // delegated), so a SOURCE-address match reproduces the indexer's
                                    // authorisation outcome for delegated dispensers too.
                                    // What stays approximate is only WHICH dispenser an address's
                                    // cancel targets when that address has several open at once: the
                                    // action_index that would disambiguate is not in the decoder's id
                                    // space, so the row keyed on the operating address wins, then the
                                    // most recent. The residual gap is enumerated in
                                    // xchain-indexer/src/chain/dispenser_divergence_metrics.js.
                                    let commandVersion = decodedDataSplit[1]
                                    let dispenserFormat = parseInt(commandVersion, 10)

                                    // Everything after GET_AMOUNT is optional on v0, so the
                                    // length gate ends the required run there rather than at
                                    // ORACLE_ADDRESS; see hasRequiredDispenserCreateFields for
                                    // the field map and for what the old >= 14 gate cost.
                                    if (dispenserFormat === 0 && this.hasRequiredDispenserCreateFields(decodedDataSplit)){
                                        let giveCoin = decodedDataSplit[V0_GIVE_COIN_INDEX]
                                        let getCoin = decodedDataSplit[V0_GET_COIN_INDEX]
                                        let getAddress = decodedDataSplit[V0_GET_ADDRESS_INDEX]

                                        // Treat a missing token OR an empty-string token as an
                                        // omitted EXPIRATION and substitute the same default the
                                        // indexer uses; only a present, non-empty value is validated.
                                        let expirationToken = decodedDataSplit[V0_EXPIRATION_INDEX]
                                        let expiration
                                        if (expirationToken === undefined || expirationToken === "") {
                                            expiration = this.getDefaultExpiration(block.timestamp)
                                        } else {
                                            expiration = Number(expirationToken)
                                        }

                                        // Require an INTEGER, matching the indexer, which rejects any
                                        // non-integer EXPIRATION outright (isInteger, see
                                        // xchain-indexer/src/actions/dispenser.js). dispensers.expiration
                                        // is BIGINT UNSIGNED, so a fractional value like 1700000000.5
                                        // either fails the write under a strict sql_mode - wedging the
                                        // block loop, which then retries the same deterministic tx
                                        // forever - or truncates under a lax one, leaving the decoder
                                        // holding a dispenser the indexer never registered.
                                        // Number.isSafeInteger already excludes NaN and Infinity, so it
                                        // subsumes the isNaN test it replaces; the default expiration is
                                        // integral by construction (block timestamp + whole days).
                                        //
                                        // SAFE integer, not merely integer, and no u32 ceiling. The old
                                        // `expiration > 4294967295` reject was recognition drift: the
                                        // indexer escrows any non-negative integer EXPIRATION into its own
                                        // BIGINT UNSIGNED column, so a dispenser opened past year 2106 (or
                                        // spelled 9999999999 for "never") stayed open and escrowed there
                                        // while the decoder skipped registration, and a later coin payment
                                        // to it was never flagged as a dispense. Number.isSafeInteger is
                                        // the bound that actually holds: at or below it Number() round-trips
                                        // the payload token exactly, so the decoder stores the same value
                                        // the indexer does, and it stays far inside BIGINT UNSIGNED.
                                        // Dropping the ceiling outright would NOT be safe - Number.isInteger
                                        // is true for 1e300, which overflows the column and wedges the block
                                        // loop on the same deterministic tx forever.
                                        if (!Number.isSafeInteger(expiration) || expiration < 0) {
                                            this.parseErrors++
                                            logger.error(`Skipping dispenser in tx ${nextTransactionHash}: invalid expiration value '${decodedDataSplit[V0_EXPIRATION_INDEX]}'`)
                                        } else if (this.dispenserOpensForThisChain(giveCoin, getCoin)){
                                            if (getAddress && getAddress.length > 0 && getAddress.charAt(0) === "^"){
                                                // Fail loud on a compacted `^<id>` GET_ADDRESS. This is a
                                                // reference into the INDEXER's index_addresses id space,
                                                // which the decoder cannot resolve (its own index_addresses
                                                // uses a different, AUTO_INCREMENT id space). Registering a
                                                // dispenser under the raw `^<id>` token would key it on a
                                                // string that never equals a real payment-output address,
                                                // so the dispenser would silently never dispense (and a
                                                // junk index_addresses row would be created). The SDK no
                                                // longer compacts DISPENSER.GET_ADDRESS, so any token
                                                // reaching here is a third-party composer or a historical
                                                // replay: surface it instead of registering a dead
                                                // dispenser. Do NOT roll the block back - the tx is
                                                // otherwise valid, this delegated dispenser is simply not
                                                // registered.
                                                this.parseErrors++
                                                logger.error(`Skipping dispenser in tx ${nextTransactionHash} (txIndex ${lastProcessedTxIndex}): unresolved compacted GET_ADDRESS reference '${getAddress}' - the decoder cannot resolve ^<id> address references, so this delegated dispenser was NOT registered`)
                                            } else {
                                                // The dispenser operates on GET_ADDRESS when a delegated
                                                // address is given, otherwise on the tx SOURCE (indexer
                                                // default). The indexer matches dispense triggers on this
                                                // operating address (get_address_id), so the decoder must
                                                // register and gate on the SAME key or dispenses paid to a
                                                // delegated address are never emitted.
                                                const operatingAddress = (getAddress && getAddress.length > 0)
                                                    ? getAddress
                                                    : parseResult["source"]
                                                // Mode B dispensers carry their PRICE v1 oracle address so a
                                                // later v2 refill, whose payload names no address, can
                                                // still have its oracle-fee output captured.
                                                // Compacted `^<id>` tokens resolve to null, same reason as
                                                // GET_ADDRESS above.
                                                dispenserCreateCandidates.push({
                                                    address: operatingAddress,
                                                    // The create SOURCE, kept alongside the operating
                                                    // address so a later cancel/edit/refill issued by the
                                                    // creator of a DELEGATED (GET_ADDRESS) dispenser still
                                                    // resolves to this row, exactly as the indexer's
                                                    // "SOURCE == dispenser SOURCE or GET_ADDRESS" gate
                                                    // allows. Stored only when it differs from the
                                                    // operating address.
                                                    sourceAddress: parseResult["source"],
                                                    oracleAddress: oracleAddressFromCreate(decodedDataSplit),
                                                    expiration: expiration
                                                })
                                            }
                                        }
                                    }
                                }

                                // Pass 1b: one row per OPERATING ADDRESS, in first-appearance order.
                                // A transaction carrying a single create (every non-BATCH transaction,
                                // and every transaction below the gate) collapses to that create
                                // unchanged, so this insert is byte-identical to the one it replaces.
                                for (let nextRegistration of collapseDispenserRegistrations(dispenserCreateCandidates)){
                                    if (!(await this.db.insertDispenser({
                                        txIndex: lastProcessedTxIndex,
                                        address: nextRegistration.address,
                                        sourceAddress: nextRegistration.sourceAddress,
                                        oracleAddress: nextRegistration.oracleAddress,
                                        expiration: nextRegistration.expiration
                                    }))){
                                        // insertDispenser's error path already rolled the block back.
                                        await resetAfterRollback()
                                        continue main_parsing
                                    }
                                    // Keep the in-memory open-dispenser set current so a
                                    // later transaction in this same block that pays this
                                    // freshly-opened dispenser is still recognized as a
                                    // dispense (mirrors the old per-output DB lookup).
                                    if (nextRegistration.address)
                                        openDispenserAddresses.add(nextRegistration.address)
                                }

                                // Pass 2: the format-1/2 lifecycle mirrors, after every create of
                                // this transaction is registered (see the ordering note above).
                                // Same gated prefix as pass 1: the two passes must agree about what
                                // a DISPENSER command IS, or a string one pass registers is a string
                                // the other declines to mirror.
                                for (let dispenserCommand of commands){
                                    if (typeof dispenserCommand !== 'string' || !dispenserCommand.startsWith(dispenserCommandPrefix))
                                        continue
                                    let decodedDataSplit = dispenserCommand.split("|")
                                    let dispenserFormat = parseInt(decodedDataSplit[1], 10)
                                    if (dispenserFormat === 1){
                                        // Format 1 = cancel. Wire: VERSION|DISPENSER_ACTION_INDEX|MEMO.
                                        // NOT MIRRORED. The decoder's open-dispenser view is advisory
                                        // and must never close a row on a guessed target: it has
                                        // no DISPENSER_ACTION_INDEX, so it could only resolve the cancel
                                        // by SOURCE, and with two open dispensers on one source that
                                        // closes the wrong one, which stops capturing payments to a
                                        // still-live dispenser (money-bearing). Left unmirrored, a
                                        // cancelled dispenser stays in the decoder's open set until its
                                        // own expiration and the indexer drops the extra triggers.
                                        // Full reasoning: db.js, above extendOpenDispenserExpirationBySource.
                                    } else if (dispenserFormat === 2){
                                        // Format 2 = edit. Wire: VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW
                                        //   |EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO.
                                        // Only a present, valid, future EXPIRATION affects the decoder's
                                        // open-view (GIVE_ESCROW refills and LIST changes do not move the
                                        // expiry the soft-expire keys on). The indexer overlays the last
                                        // valid non-null edit EXPIRATION onto the base (getExpiredItems),
                                        // and rejects a non-future value (bclte(EXPIRATION, BLOCK_TIME)), so
                                        // an empty EXPIRATION is a no-op here and a past/invalid one is
                                        // skipped.
                                        //
                                        // EXTEND ONLY, and against every open row of the source rather
                                        // than a guessed one: the decoder must not close early,
                                        // and an edit that lengthens an expiry is exactly the case where
                                        // failing to mirror WOULD close early. An edit that shortens one
                                        // is deliberately not mirrored.
                                        const editSource = parseResult["source"]
                                        const editExpirationToken = decodedDataSplit[V2_EXPIRATION_INDEX]
                                        if (editSource && editSource.length > 0 &&
                                            editExpirationToken !== undefined && editExpirationToken !== ""){
                                            const newExpiration = Number(editExpirationToken)
                                            // Same integer contract as the create guard above: the edit
                                            // path writes through extendOpenDispenserExpirationBySource
                                            // into the same BIGINT UNSIGNED column, and the indexer
                                            // rejects a fractional edit EXPIRATION with the identical
                                            // isInteger test, and the same SAFE-integer ceiling rather than
                                            // a u32 one (see the create guard: a u32 reject here would
                                            // silently decline to mirror an extend the indexer accepted,
                                            // closing the decoder's row early on a dispenser that is still
                                            // open and escrowed).
                                            if (Number.isSafeInteger(newExpiration) && newExpiration >= 0 &&
                                                newExpiration > block.timestamp){
                                                // nextBlockHeight lets the mirror also clear a soft-expiry
                                                // THIS block stamped: deleteOpenDispensers ran before this
                                                // loop, so without it the `IS NULL` filter silently skipped
                                                // exactly the row a same-block extend is for, and the
                                                // decoder went dark on a dispenser the indexer keeps open.
                                                // The row is open again from the next block's load, which
                                                // ends the PERSISTENT divergence.
                                                //
                                                // RESIDUAL, and NOT benign: this restores the DB row, not
                                                // this block's in-memory capture set, so outputs paying
                                                // that dispenser in the REST of this block are still
                                                // missed, and under-capture is the money-bearing direction.
                                                // Re-seeding the set is not blocked by the guessed-target
                                                // rule (the extend already acts on EVERY open row of the
                                                // source, so reading those rows' operating addresses back
                                                // is set membership with no ranking); it is blocked because
                                                // widening the captured set changes the persisted output
                                                // set mid-block, which needs its own activation flag-day
                                                // with the legacy set preserved below it so a from-genesis
                                                // re-decode stays byte-identical. Outputs BEFORE the edit
                                                // tx in this block are unreachable by any re-seed and need
                                                // the end-of-block expiry realignment instead, which is
                                                // now what DISPENSER_EXPIRY_REALIGN_ACTIVATION arms: at/above
                                                // that gate nothing is stamped before the loop, so there is
                                                // no same-block stamp to clear and no mid-block gap at all.
                                                // The clear below stays for the legacy era it was written
                                                // for, where it is still the only thing ending the
                                                // PERSISTENT divergence.
                                                if ((await this.db.extendOpenDispenserExpirationBySource(editSource, newExpiration, nextBlockHeight)) === false){
                                                    // extendOpenDispenserExpirationBySource's error path already rolled the block back.
                                                    await resetAfterRollback()
                                                    continue main_parsing
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            // Verify a payload that says something has an author. A
                            // record with no resolvable source address cannot be
                            // attributed to anyone, so it is skipped rather than stored.
                            if ((parseResult["data"].length > 0) && (parseResult["source"] == null)){
                                logger.error(`Skipping tx ${nextTransactionHash}: XChain data found but source address could not be resolved`)
                            }
                        }
                    }
                    
                    outputCount = outputCount + nextTransaction.outs.length
                }
                
                transactionsCount = transactionsCount + transactions.length

                // REALIGNED soft-expire (at/above DISPENSER_EXPIRY_REALIGN_ACTIVATION): the
                // block's transactions have all been seen, so expire now, exactly where the
                // indexer's utility.processExpirations sits. Every tx in this block therefore
                // saw the dispenser open on BOTH sides, and a boundary block yields the same
                // DISPENSE set. Runs INSIDE the block transaction (the commit below is what
                // makes it durable), so a reorg still restores the row through
                // deleteBlockByIndex, and the same-block extend above can still clear a stamp
                // this height wrote on a re-processed block. Same rollback contract as the
                // legacy call site: false means the UPDATE failed and the block transaction is
                // already rolled back, so retry the block rather than writing on past it.
                // Below the gate this is a no-op; the block-start call already ran.
                if (expireDispensersAtBlockEnd &&
                    (await this.db.deleteOpenDispensers(nextBlockHeight, block.timestamp)) !== true){
                    logger.error(`deleteOpenDispensers failed at end of block ${nextBlockHeight}; block rolled back, retrying`)
                    await resetAfterRollback()
                    continue main_parsing
                }

                // Commit once the batch is full, or immediately on the block that reaches
                // the node tip so a caught-up decoder never holds a block uncommitted.
                if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
                    if ((nextBlockHeight % LOG_BLOCK_INTERVAL === 0) || ((this.blockchainInfoLastBlock - nextBlockHeight) <= SYNCED_THRESHOLD)) {
                        this.log("Parsing block "+(nextBlockHeight)+"("+nextBlockHash+") Txs ("+transactionsCount+") Outputs ("+outputCount+")")
                        this.log("Inserting data Blocks ("+blocksCount+") Valid Transactions ("+validTransactionsCount+")")
                    }
                    const committed = await this.db.commitTransaction()
                    if (!committed){
                        // commitTransaction returned false: the commit failed and the whole
                        // block batch was rolled back (endTransaction). Do NOT advance the tip
                        // to nextBlockHeight, which would permanently skip the rolled-back
                        // window and leave a hole in the decoded chain. Reset to the last
                        // durably committed block and retry, mirroring the block-decode
                        // recovery path above.
                        logger.error(`Commit failed at block ${nextBlockHeight}; resetting to last committed block and retrying`)
                        lastProcessedBlockIndex = this.lastProcessedBlockIndex = Math.max(await this.db.getLastBlockIndex(), this.startBlockIndex - 1)
                        lastProcessedTxIndex = await this.db.getLastTxIndex()
                        blocksQuantity = 0
                        // Reset the in-memory log/ETA accumulators too, as the reorg
                        // recovery path does. The rolled-back batch never reached the
                        // DB, so leaving these set would double-count transactions and
                        // skew the ms/block ETA on the retry. Logging-only, no tip effect.
                        transactionsCount = 0
                        validTransactionsCount = 0
                        outputCount = 0
                        blocksCount = 0
                        startTimeStamp = Date.now()
                        await this.sleep(3000)
                        continue
                    }

                    // The block committed: any poison-tx positions for it are now permanently
                    // recorded (PARSE_ERROR) and skipped, so drop them. Keeps insertQuarantine
                    // bounded to the block being retried and prevents a stale height:pos entry
                    // from surviving a later reorg that changes this height's content.
                    if (insertQuarantine.size > 0) insertQuarantine.clear()

                    // Hard-purge dispensers soft-expired at a reorg-safe depth. Runs
                    // AFTER the block transaction commits (a transient failure here
                    // must not roll back committed block data) and is deterministic
                    // across nodes (keyed off canonical height, not wall clock).
                    await this.db.purgeExpiredDispensers(nextBlockHeight - DISPENSER_EXPIRE_SAFE_DEPTH)

                    blocksCount = 0
                    transactionsCount = 0
                    validTransactionsCount = 0
                    outputCount = 0
                    
                    let endTimeStamp = Date.now()
                    
                    let msPerBlock = ((endTimeStamp - startTimeStamp)/DB_TRANSACTION_BLOCKS_QUANTITY)
                    startTimeStamp = Date.now()
                    
                    let msLeft = (this.blockchainInfoLastBlock - nextBlockHeight)*msPerBlock
                    
                    if (msLeft > 0){
                        let msPerBlockFormatted = this.millisecondsToTimeString(msPerBlock)
                        let msLeftFormatted = this.millisecondsToTimeString(msLeft)
                        logger.info("Last block time ("+msPerBlockFormatted+"). ETA: "+msLeftFormatted)
                    }
                    
                    blocksQuantity = -1
                }
                
                blocksQuantity = blocksQuantity + 1
                lastProcessedBlockIndex = this.lastProcessedBlockIndex = nextBlockHeight
                // The one forward-progress site: a block is committed and the cursor
                // moved. Every other assignment to lastProcessedBlockIndex re-reads the
                // cursor after a rollback, which is recovery, not progress.
                this.lastAdvanceAt = Date.now()
            }
        }
    }
}

Object.assign(XChainDecoder.prototype,
    syncStatusMethods,
    chainIntegrityMethods,
    sourceResolutionMethods,
    envelopeRecognitionMethods,
    dispenserAndOracleFeeMethods,
    transactionParsingMethods,
    reorgVerificationMethods,
    mempoolRefreshMethods)

// The class IS the export, and everything below hangs off it. Attached with one
// Object.assign rather than a run of `module.exports.X =` lines: `module.exports`
// already IS the class here, so the two spellings are the same assignment, and
// one of them leaves the file with a single export shape. No call site changes,
// because `require('./XChainDecoder').X` still reads the same property.
Object.assign(XChainDecoder, {
    // Exported for the cross-service regression suite, which asserts this equals the
    // encoder's compiled-push guard and the canonical protocol constant.
    MAX_ACTION_DATA_LENGTH,
    // Exported for the compiled-push-size conformance test, which pins this formula
    // against bitcoin.script.compile and the encoder's identical helper.
    compiledPushSize,
    // Exported so the same conformance test can pin the OP_PUSHDATA2 overhead by NAME
    // against the canonical protocol constant.
    OP_RETURN_PUSH_OVERHEAD,
    // Exported so a regression test can pin it >= the deepest per-chain reorg window.
    DISPENSER_EXPIRE_SAFE_DEPTH,
    nodeStillCatchingUp,
    // Exported so the funding-fee-output collision regression test can assert attributed
    // funding outputs are stored at vout + FUNDING_VOUT_BASE (never colliding with real vouts).
    FUNDING_VOUT_BASE,
    // Exported for the DOGE large-output bufferutils-patch self-check regression test.
    bigIntBufferutilsActive,
    // Exported for the malformed-AuxPoW fallback regression test.
    AUXPOW_REASSEMBLE_AFTER,
    // Exported for the alias-canonicalization tests and so the
    // ActionManifestConformance test can pin VALID_ACTION_NAMES/ACTION_ALIASES.
    canonicalizeActionPayload,
    VALID_ACTION_NAMES,
    ACTION_ALIASES,
    // Taproot envelope: the per-encoding payload ceiling and the per-chain
    // recognition-height map, exported for the cross-service conformance suites
    // (encoder/docs copies must stay byte-equal).
    ENVELOPE_MAX_PAYLOAD,
    ENVELOPE_RECOGNITION_ACTIVATION,
});

module.exports = XChainDecoder
