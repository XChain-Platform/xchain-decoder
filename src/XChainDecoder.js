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

const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto')
const ecc = require('tiny-secp256k1')
const BlockchainConnector = require('./chain/blockchain_connector')
const CryptoNetworks = require('./chain/crypto_networks')
const XChainBlockDecoder = require('./chain/XChainBlockDecoder')
const { format: formatLogLine } = require('node:util');
const { logger, FUNDING_VOUT_BASE, DISPENSER_EXPIRE_SAFE_DEPTH, resolveDispenserExpireSafeDepth, VALID_ACTION_NAMES, AUXPOW_REASSEMBLE_AFTER } = require('./XChainDecoder/constants.js')
const { nodeStillCatchingUp, compiledPushSize, canonicalizeActionPayload, bigIntBufferutilsActive } = require('./XChainDecoder/payload_helpers.js')
const syncStatusMethods = require('./XChainDecoder/sync_status.js')
const chainIntegrityMethods = require('./XChainDecoder/chain_integrity.js')
const sourceResolutionMethods = require('./XChainDecoder/source_resolution.js')
const envelopeRecognitionMethods = require('./XChainDecoder/envelope_recognition.js')
const dispenserAndOracleFeeMethods = require('./XChainDecoder/dispenser_and_oracle_fees.js')
const transactionParsingMethods = require('./XChainDecoder/transaction_parsing.js')
const reorgVerificationMethods = require('./XChainDecoder/reorg_verification.js')
const startupMethods = require('./XChainDecoder/startup.js')
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
    decoder.dispenserExpireSafeDepth = resolveDispenserExpireSafeDepth(decoder.coinTick, decoder.consensusNetwork)

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
}

Object.assign(XChainDecoder.prototype,
    syncStatusMethods,
    chainIntegrityMethods,
    sourceResolutionMethods,
    envelopeRecognitionMethods,
    dispenserAndOracleFeeMethods,
    transactionParsingMethods,
    reorgVerificationMethods,
    startupMethods,
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
    resolveDispenserExpireSafeDepth,
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
