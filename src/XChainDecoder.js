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
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto')
const Database = require('./db.js')
const ecc = require('tiny-secp256k1')
const BlockchainConnector = require('./BlockchainConnector')
const CryptoNetworks = require('./CryptoNetworks')
const XChainBlockDecoder = require('./XChainBlockDecoder')
const { isOracleFeeCaptureActive, isOracleFeeSetCaptureActive, oracleAddressFromCreate, isCompactedOracleAddress } = require('./oracleFeeOutput')
const { isDispenserExpiryRealignActive } = require('./dispenserExpiryRealign')
const { chainTierMismatch, chainFieldMissing, chainGenesisMismatch, chainGenesisUnpinned } = require('./chainIdentity')
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })
const lenientTextDecoder = new TextDecoder('utf-8')

//We need to init the ecc to parse taproot addresses from output scripts
bitcoin.initEccLib(ecc);

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so reported lag stays accurate
const MEMPOOL_INTERVAL = 60000 //60 seconds between mempool checks
// How often a health surface may re-probe the durable REORG_HALT marker. The marker
// changes at most once in a decoder's life, so a slow TTL is ample; the point of the
// cache is that an unauthenticated health endpoint must not turn into one DB query
// per request.
const REORG_HALT_PROBE_INTERVAL_MS = 60000
// How long the block loop may make no forward progress, while the node tip is fresh and
// visibly ahead, before isStalled() calls the decoder wedged. The loop never skips a
// block on a fetch/parse fault (skipping would corrupt the index), so a deterministic
// fault at one height retries forever with the process alive and the DB reachable; this
// window is what makes that visible to a liveness probe. Deliberately generous: it must
// clear the slowest legitimate single-block commit and a deep reorg rollback on the
// slowest host, because the consumer of the signal restarts the container. Override per
// host with DECODER_STALL_ALERT_MS.
const STALL_ALERT_MS = Number(process.env.DECODER_STALL_ALERT_MS) || 900000
// How long the parse loop may go without completing an ITERATION before /live calls the
// decoder dead. Distinct from STALL_ALERT_MS, which measures chain PROGRESS: a caught-up
// decoder makes no progress for hours and is perfectly healthy, so only iteration count
// can tell "idle because there is nothing to do" from "the loop is gone". Deliberately
// twice the stall window, because the consumer restarts the container: every normal path
// through the loop, including the outage path (catch -> sleep(3000) -> continue) and the
// slowest single-block commit, returns to the loop top far inside it. Override per host
// with DECODER_POLL_SILENT_MS.
const POLL_SILENT_MS = Number(process.env.DECODER_POLL_SILENT_MS) || (2 * STALL_ALERT_MS)
// Consecutive failed fetch attempts at ONE height (3s apart) that count as wedged on
// their own. _fetchErrorCount resets to 0 on any successful fetch and on a height
// change, so unlike the elapsed-time window it cannot be tripped by slow-but-working
// block processing. 20 attempts is ~1 minute of retrying the same height.
const STALL_FETCH_ATTEMPTS = Number(process.env.DECODER_STALL_FETCH_ATTEMPTS) || 20
const MEMPOOL_BATCH_SIZE = 1000

const MAGIC_WORD = "XCHN"
const MAGIC_WORD_BUFFER = Buffer.from(MAGIC_WORD)
const P2SH_BUFFER = Buffer.from("p2sh")
const P2WSH_BUFFER = Buffer.from("p2wsh")

// transaction_outputs is keyed by (tx_index, vout). For a P2SH/P2WSH reveal we ALSO attribute
// the native-coin fee output(s) that physically live on the funding (commit) transaction to the
// reveal's tx_index (see findFundingFeeOutputs). Those rows carry the FUNDING tx's vout numbers,
// which are a different output-index domain than the reveal tx's own vouts: storing both under the
// same tx_index lets a funding fee output collide on the primary key with one of the reveal tx's
// own outputs (a dispense or COINPAY output at the same vout number), and the duplicate INSERT is
// silently dropped. To keep the two domains disjoint, funding-attributed outputs are stored at
// vout + FUNDING_VOUT_BASE. A real Bitcoin-family transaction can never reach this many outputs
// (block-size limits cap output counts far below), so vout >= FUNDING_VOUT_BASE unambiguously
// marks an attributed funding output and can never collide with a real reveal-tx vout. Readers
// must treat vout as an opaque per-tx output key, not the literal on-chain output index (the
// indexer's detectFeePaymentMode keys on destination address, so the offset is transparent to it).
const FUNDING_VOUT_BASE = 1000000

const SYNCED_THRESHOLD = 3 //Maximum blocks behind to be synced
// Soft-expired dispensers (marked, not deleted, so a reorg can restore them) are
// hard-purged once this many blocks deep, and a pure function of canonical height
// so every node purges identically. This MUST stay >= the deepest per-chain
// reorg-recovery window, or a row is deleted before a legal in-window reorg can
// restore it (deleteBlockByIndex then matches zero rows), permanently losing a
// money-bearing dispenser on the reorged node. The platform's deepest window is
// DOGE = 120 (xchain-utxo-tracker DEFAULT_UNDO_BLOCKS: BTC 12 / LTC 48 / DOGE 120);
// the previous flat 100 sat BELOW DOGE's window. Invariant: SAFE_DEPTH >=
// deepest undo window + margin. The +6 margin means a small undo-window re-tune
// cannot land exactly at the purge threshold; dispenserSafeDepth.test.js
// enforces the invariant with a conformance read of undo-blocks.js, so raising
// any chain's window past the margin fails the suite until this is bumped.
// Purging deeper is the conservative direction (rows are merely retained longer
// before hard-purge; expiry semantics and action evaluation are unchanged).
const DISPENSER_EXPIRE_SAFE_DEPTH = 126 // 120 (DOGE undo window) + 6 margin
// There is deliberately no DISPENSER_CLOSE_DELAY twin of the indexer's here: the decoder
// does not mirror dispenser cancels, so it never needs to close a row at the height the
// indexer's DISPENSER_CLOSE fires. Reintroducing a closing mirror would need that pinned
// cross-repo value back, and would first need the decoder to resolve cancel targets
// exactly rather than by SOURCE (see db.js above extendOpenDispenserExpirationBySource).
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

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
// DROP -> AIRDROP 3 each). That is intended and harmless (transactions.data is
// MEDIUMTEXT), and deliberately not "fixed" by re-measuring the canonical buffer at
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
// xchain-encoder/src/validator.js. Bound to the canonical NAME rather than inlined
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
// BIP342 tapscript leaf version; also the control block's first byte masked of
// its output-key parity bit.
const TAPROOT_LEAF_VERSION = 0xc0
// BIP341 annex marker: when a witness stack of >= 2 items ends in an item
// whose first byte is 0x50, that item is an annex and sits outside the
// script-path elements. An annex-bearing reveal is never recognized (§3.8).
const TAPROOT_ANNEX_MARKER = 0x50

// Compiled size of a single script push once bitcoin.script.compile adds its
// length prefix: a direct push opcode for <=75 bytes, OP_PUSHDATA1 (+2) for
// <=255, or OP_PUSHDATA2 (+3) beyond that. Single source for measuring both
// push[0] (data) and push[1] (rawData) in parseTransaction; this formula is
// the protocol-arbiter side of the encoder's identical compiledPushSize
// (xchain-encoder/src/validator.js), and the compiledPushSizeConformance test
// pins both against bitcoin.script.compile byte-for-byte across the 75/255
// prefix boundaries. Do not fork this logic inline. Only the OP_PUSHDATA2
// branch names a constant: the +1/+2 branches are different opcodes that
// OP_RETURN_PUSH_OVERHEAD does not describe.
function compiledPushSize(byteLength){
    if (byteLength <= 75)  return byteLength + 1   // direct push opcode
    if (byteLength <= 255) return byteLength + 2   // OP_PUSHDATA1
    return byteLength + OP_RETURN_PUSH_OVERHEAD    // OP_PUSHDATA2
}

const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'SEND', 'SLASH', 'SLEEP', 'STAKE', 'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW'
])

// Short-form ACTION-name aliases. A spec-following client may encode any of
// these leading tokens (e.g. the BRC20/SRC20-compatible TRANSFER, or MSG for a
// shorter MESSAGE) and produce a valid on-chain payload. We expand the alias to
// its canonical name BEFORE the VALID_ACTION_NAMES gate and rewrite the stored
// payload to the canonical form, so the decoder DB never holds aliased names and
// every downstream consumer sees one spelling per action.
const ACTION_ALIASES = {
    'TRANSFER': 'SEND',
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG': 'MESSAGE'
}

// Canonicalize the ACTION name in a raw payload buffer, expanding a short-form
// alias to its canonical form. Single source for the tokenize+lookup logic
// shared by the confirmed-block and mempool decode paths: those two sites had
// drifted into structurally different implementations (string split/join vs
// byte splice) that happened to agree only because every encoder-producible
// payload is valid UTF-8. Do not fork this logic inline.
//
// Tokenizes on the FIRST 0x7C ('|') byte only, matching the on-chain wire
// format (ACTION|param|param|...). The name portion is lenient-decoded ONLY
// for the alias lookup, so invalid UTF-8 in the name cannot throw; every byte
// after the first pipe is returned verbatim. Callers that need a string decode
// the returned buffer themselves, so U+FFFD substitution for invalid UTF-8 is
// applied exactly once, at the call site.
//
// Returns { buffer, rawActionName, actionName, isKnown }. `buffer` is the
// original reference, unmodified, unless the name was a recognized alias
// (unknown names are left alone too); `rawActionName` is the name exactly as
// it appeared on-chain, for logging.
function canonicalizeActionPayload(buffer) {
    const pipeIndex = buffer.indexOf(0x7C) // '|'
    const nameEnd = pipeIndex === -1 ? buffer.length : pipeIndex
    const rawActionName = lenientTextDecoder.decode(buffer.subarray(0, nameEnd))
    const actionName = ACTION_ALIASES[rawActionName] ?? rawActionName
    const isKnown = VALID_ACTION_NAMES.has(actionName)
    const outBuffer = (isKnown && actionName !== rawActionName)
        ? Buffer.concat([Buffer.from(actionName, 'ascii'), buffer.subarray(nameEnd)])
        : buffer
    return { buffer: outBuffer, rawActionName, actionName, isKnown }
}

const DB_TRANSACTION_BLOCKS_QUANTITY = 1 //How many blocks need to be processed before inserting the data into the database
const LOG_BLOCK_INTERVAL = 1000 //During catch-up sync, only log progress every N blocks

// How many times a block is re-parsed after a transaction-level parse throw before
// the offending transaction is quarantined (skipped + PARSE_ERROR event). Retrying
// first means a transient blip can never make this instance skip a transaction that
// other decoder instances accept; only a tx that fails every attempt is quarantined,
// which is deterministic across instances running this code. Throws tagged
// rpcLookupFailure (node RPC trouble inside parseTransaction) never count toward
// this cap: an RPC outage is not a poison tx, so those retry the block indefinitely
// rather than quarantining content other instances accept.
const TX_PARSE_MAX_RETRIES = 3

// After this many consecutive fetch failures at one height on an AuxPoW chain,
// treat the failure as deterministic (e.g. an AuxPoW section skipAuxPow cannot
// traverse) and switch to getBlockReassembled, which rebuilds the pure block
// from getblockheader + verbose getblock + per-txid getrawtransaction and so
// never reads the AuxPoW bytes at all. The block is never skipped, and the
// reassembled bytes equal the stripped bytes, so instances stay convergent.
const AUXPOW_REASSEMBLE_AFTER = 5

// Probe whether bitcoinjs-lib's 64-bit reader tolerates a value > 2^53-1 (the BigInt-safe
// bufferutils patch) rather than throwing 'value out of range'. The decoder relies on this
// patch to decode a Dogecoin output > 2^53-1 sat (~90.07M DOGE) without wedging block
// decode; it ships via a Dockerfile COPY over node_modules, so a stock/unpatched
// node_modules (a Dockerfile regression, or a non-Docker run) would silently reintroduce
// the wedge. Reads a synthetic 2^53 uint64 (one past the stock reader's ceiling). The
// bufferutils module is injectable for testing. Returns false on any failure (fail-safe:
// an unrecognizable module reads as "patch not confirmed").
function bigIntBufferutilsActive(bufferutils){
    try {
        let bu = bufferutils || require('bitcoinjs-lib/src/bufferutils')
        if (!bu.BufferReader) return false
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch(_){
        return false
    }
}

class XChainDecoder {
    constructor(network, dbUrl, dbPort, dbName, dbUser, dbPassword, nodeUrl, nodePort, nodeUser, nodePassword, auxPow, feeDestination) {
        this.network = CryptoNetworks.getBitcoinJsNetwork(network)

        // Uppercase native-coin ticker ('BTC'|'DOGE'|'LTC') for this chain. This is
        // the identity a v0 DISPENSER's GIVE_COIN/GET_COIN fields must name and the
        // value the indexer validates against (config['COIN']); the dispenser-open
        // gate below compares against it so the decoder only opens dispensers the
        // indexer will accept. getBitcoinJsNetwork above already threw on an unknown
        // key, so this cannot throw.
        this.coinTick = CryptoNetworks.getCoinTick(network)

        // Net portion ('mainnet'|'testnet'|'regtest') of the "<fullname>-<network>"
        // key, for the boot-time consensus-pin verification in start(). The
        // getBitcoinJsNetwork call above already threw on an unknown key, so the
        // suffix is guaranteed to be a valid network name here.
        this.consensusNetwork = String(network).slice(String(network).lastIndexOf('-') + 1)

        // Coin/network-prefixed loggers so cadence/reorg/stall lines are self-describing
        // even when a log pipeline strips container labels. Reads the fields at call time.
        this.log = (...args) => console.log('[' + this.coinTick + '/' + this.consensusNetwork + ']', ...args)
        this.logError = (...args) => console.error('[' + this.coinTick + '/' + this.consensusNetwork + ']', ...args)

        // Native-coin protocol fee destination address for this coin+network. When set (not the
        // unset placeholder), the decoder also persists any output paying it to transaction_outputs
        // so the indexer can validate native-coin fee payments. Null/placeholder disables capture.
        this.feeDestination = (feeDestination && feeDestination !== 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')
            ? feeDestination
            : null

        this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
        this.dbUrl = dbUrl
        this.dbPort = dbPort
        this.dbName = dbName
        this.dbUser = dbUser
        this.dbPassword = dbPassword
        this.startBlockIndex = CryptoNetworks.getFirstBlock(network)
        // Pinned block-0 hash of this chain, or null when the registry leaves it
        // unpinned. It is the ONLY value that separates a same-tier foreign endpoint
        // from ours (BTC-mainnet and DOGE-mainnet both report chain="main"), so
        // start() and the throttled tip refresh assert it against `getblockhash 0`.
        this.chainGenesisHash = CryptoNetworks.getChainGenesisHash(network)
        // Timestamp (ms) of the last SUCCESSFUL block-0 read. Zero means never read, so
        // the first refresh always checks. Throttled on its own clock rather than riding
        // the getblockchaininfo refresh: a caught-up loop re-polls the tip every
        // iteration, and block 0 cannot change under a chain that is still the same chain.
        this.chainGenesisCheckedAt = 0
        // Default EXPIRATION window (days) for v0 dispenser opens that omit the
        // EXPIRATION field; must match the indexer's default-expiration rule.
        this.expirationFeeDefaultDays = CryptoNetworks.getExpirationFeeDefaultDays(network)
        this.xchainBlockDecoder = new XChainBlockDecoder(network)
      
        this.db = null
        this.mempoolDb = null
        this.fm = null
      
        this.debugTime = {}
      
        this.synced = false

        this.lastProcessedBlockIndex = -1
        this.blockchainInfoLastBlock = -1
        // Timestamp (ms) of the most recent successful getBlockchainInfo() call.
        // Zero means the tip has never been fetched. Used by getSyncStatus() to
        // flag a frozen tip so callers can distinguish a genuine zero lag from an
        // outage where the cached tip stopped advancing.
        this.blockchainInfoLastRefreshAt = 0
        // Timestamp (ms) of the most recent FORWARD advance of lastProcessedBlockIndex,
        // set at the top of the block loop and again on every committed block. Zero
        // means the loop has not started, which isStalled() reads as "not stalled".
        this.lastAdvanceAt = 0
        // Timestamp (ms) of the most recent parse-loop ITERATION, set at the loop top
        // whether or not a block arrived. Independent of chain progress on purpose:
        // it is the only signal that separates a loop that is idle because it is
        // caught up from a loop that is no longer running. Zero means the loop has
        // not iterated yet (still in initial sync), which isPollSilent() reads as
        // "not silent" so a booting decoder is never called dead.
        this.lastPollAt = 0
        // Structured logger from the observability shim, injected by api.js once
        // installObservability has run. Null until then, and every use falls back to
        // this.log, so a caller that never wires one (tests, migrate) still warns.
        this.obsLogger = null
        // Last logged value of isNodeHeightStale(), so the tip-stale warn is EDGE
        // triggered. The block loop re-evaluates roughly every 3s during a node
        // outage, so a level-triggered line would emit ~20 a minute for its duration.
        this._nodeHeightStaleLogged = false
        this.mempoolInterval = null
        this.mempoolBusy = false

        this.stopFlag = false

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
        this.auxPow = this.xchainBlockDecoder.wireFormat === 'auxpow'

        this.rpcErrors = 0
        this.parseErrors = 0

        // Consecutive block-fetch failures at _fetchErrorHeight. _fetchErrorCount counts
        // every failure (operator visibility); _auxPowParseErrorCount counts only the
        // AuxPoW-header-strip content faults that may escalate to per-tx block
        // reassembly. Both reset on a height change and on any success.
        this._fetchErrorHeight = null
        this._fetchErrorCount = 0
        this._auxPowParseErrorCount = 0

        // Latent REORG_HALT marker state. The durable marker written by verifyReorg
        // used to be read only by verifyReorg, so a decoder carrying one looked
        // perfectly healthy right up until the next reorg tripped it, which can be
        // weeks later and then reads as a sudden unexplained outage. Worse, a
        // bootstrap-snapshot job published such a halted database as the newest
        // "good" archive in the meantime. These fields cache a periodic probe so
        // health()/GET /status can report the marker BEFORE a reorg finds it.
        // reorgHaltCheckedAt is the epoch-ms of the last successful probe
        // (0 = never probed), which also drives the TTL that keeps a hot monitoring
        // loop from issuing one query per request.
        this.reorgHalted = false
        this.reorgHaltReason = null
        this.reorgHaltAt = null
        this.reorgHaltCheckedAt = 0
        this._reorgHaltProbeInFlight = null
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Default EXPIRATION for a v0 dispenser open that omits the field: block time
    // plus the configured default window in seconds. Keep in sync with
    // xchain-indexer/src/utility.js getDefaultExpiration so both views agree on
    // whether an EXPIRATION-less dispenser is open.
    getDefaultExpiration(blockTime){
        return Number(blockTime) + (this.expirationFeeDefaultDays * 86400)
    }

    markTime(timeName){
        this.debugTime[timeName] = Date.now()
    }
    
    logTime(timeName){
        let endTime = Date.now()
        let msTime = (endTime - this.debugTime[timeName])
                    
        console.log("Time('"+timeName+"'): "+(msTime)+"ms")
    }
    
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
        seconds = Math.floor((ms / 1000) % 60),
        minutes = Math.floor((ms / (1000 * 60)) % 60),
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
        days = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return days+"d"+ hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
    }
    
    // True when the cached node tip is frozen: we have polled at least once and the
    // last successful getBlockchainInfo() was more than 2x the refresh interval ago,
    // i.e. at least two consecutive polls failed. The single definition of the test
    // isSynced(), isStalled() and getSyncStatus() each used to spell out inline;
    // three copies of one threshold is three chances to drift.
    //
    // Never-polled (blockchainInfoLastRefreshAt 0) is NOT stale: a booting decoder
    // has no frozen tip, it has no tip.
    isNodeHeightStale(){
        return this.blockchainInfoLastRefreshAt > 0
            && (Date.now() - this.blockchainInfoLastRefreshAt) > 2 * BLOCKCHAIN_INFO_REFRESH_MS
    }

    // Age (seconds) of the last successful tip poll, or null before the first one.
    // Exported as a Prometheus gauge so an alert can fire on tip age directly rather
    // than on the boolean's 2x-interval threshold.
    nodeTipAgeSeconds(){
        if (!(this.blockchainInfoLastRefreshAt > 0)) return null
        return (Date.now() - this.blockchainInfoLastRefreshAt) / 1000
    }

    // Emit ONE warn when the node tip goes stale and one info when it recovers.
    // Called from the block loop, which iterates every ~3s during an outage, so the
    // edge latch is what keeps this from becoming log spam. Never throws: an
    // instrumentation fault must not wedge the parse loop.
    noteNodeTipStaleTransition(){
        try {
            const stale = this.isNodeHeightStale()
            if (stale === this._nodeHeightStaleLogged) return
            this._nodeHeightStaleLogged = stale
            const logger = this.obsLogger
            const ageSeconds = this.nodeTipAgeSeconds()
            const fields = {
                coin: this.coinTick,
                network: this.consensusNetwork,
                tip_age_seconds: ageSeconds,
                node_height: this.blockchainInfoLastBlock,
                last_processed_block: this.lastProcessedBlockIndex
            }
            if (stale){
                const message = 'node tip stale: getblockchaininfo has not refreshed'
                if (logger && typeof logger.warn === 'function') logger.warn(message, fields)
                else this.log(message, JSON.stringify(fields))
            } else {
                const message = 'node tip recovered: getblockchaininfo refreshing again'
                if (logger && typeof logger.info === 'function') logger.info(message, fields)
                else this.log(message, JSON.stringify(fields))
            }
        } catch (_) { /* instrumentation must never break the block loop */ }
    }

    // Wire the observability log shim in after construction (api.js owns the handle).
    setObservabilityLogger(logger){
        this.obsLogger = logger || null
    }

    isSynced(){
        // A frozen tip during a node outage must not read as synced: the chain may
        // have advanced far past the last cached tip, so synced:true would be false-healthy.
        if (this.isNodeHeightStale()) return false
        return this.synced
    }

    // True when the block loop is wedged: alive and retrying, but no longer making
    // progress the chain is waiting on. Without it a wedged decoder reports healthy
    // forever, because nothing a probe can reach reads the retry loop's own counters.
    //
    // Fail-QUIET by construction, because the consumer restarts the container:
    //   - a fresh process (lastAdvanceAt 0) is never stalled;
    //   - a caught-up decoder is never stalled (it advances only when blocks arrive), so
    //     the node tip must be visibly AHEAD;
    //   - the tip must be FRESH (same 2x-refresh test isSynced uses). During a node
    //     outage both sides freeze, and restarting the decoder fixes nothing.
    // The pinned-height fetch counter is a FASTER path to the same verdict, not an
    // independent one: it self-resets on any successful fetch, so once the gates above
    // pass it flags a wedge in about a minute instead of waiting out the elapsed-time
    // window. It sits BELOW those gates deliberately, and moving it above them re-opens
    // a restart loop: `_fetchErrorCount` is bumped by the catch around
    // getBlockHash/fetchBlockHex, and a Dogecoin 1.14 node under RPC-queue pressure
    // surfaces as a bare ECONNRESET, i.e. a TRANSPORT fault rather than a bad block.
    // Ungated, a decoder that is merely BEHIND the tip reaches that fetch every
    // iteration and climbs STALL_FETCH_ATTEMPTS in roughly a minute at the 3s sleep;
    // the container healthcheck (15s interval, 3 retries, 60s start period, autoheal)
    // then restarts it about every two minutes for the whole duration of a fault that
    // restarting cannot fix, against a coin node already under pressure. The accepted
    // flap trade-off was scoped to a deterministically bad BLOCK, never to a transport
    // fault.
    isStalled() {
        if (!this.lastAdvanceAt) return false
        if (this.blockchainInfoLastBlock < 0 || this.lastProcessedBlockIndex < 0) return false
        if ((this.blockchainInfoLastBlock - this.lastProcessedBlockIndex) <= 1) return false
        if (this.isNodeHeightStale()) return false
        if (this._fetchErrorCount >= STALL_FETCH_ATTEMPTS) return true
        return (Date.now() - this.lastAdvanceAt) > STALL_ALERT_MS
    }

    // True when the parse loop has stopped ITERATING. isStalled() cannot see this and
    // is not meant to: every one of its gates above is a statement about chain
    // progress, and it deliberately returns false for a caught-up decoder and false
    // again on a stale tip. So a loop that dies while caught up leaves
    // decoderRunning true, dbOk true and stalled false, and /live answers 200 forever
    // while nothing parses. Three modes reach that state: the loop throws its way out
    // of a caught-up idle, it hangs inside an await, or SIGTERM breaks it. Only an
    // iteration counter independent of the chain covers all three.
    //
    // Fail-quiet in the same style as isStalled(), because the consumer restarts the
    // container: lastPollAt 0 (loop has not iterated yet, e.g. a long initial sync)
    // is never silent.
    isPollSilent() {
        if (!this.lastPollAt) return false
        return (Date.now() - this.lastPollAt) > POLL_SILENT_MS
    }

    getSyncStatus() {
        if (this.lastProcessedBlockIndex === -1) {
            return { last_processed_block: null, node_height: null, lag: null }
        }
        // A stale tip means: we have polled at least once but the last successful
        // getBlockchainInfo() was more than 2x the normal refresh interval ago,
        // i.e. at least two consecutive poll attempts have failed (node outage).
        // In that window blockchainInfoLastBlock is frozen, so a zero lag does not
        // mean caught-up; it means we cannot see how far the chain has advanced.
        const nodeHeightStale = this.isNodeHeightStale()

        const status = {
            last_processed_block: this.lastProcessedBlockIndex,
            node_height: this.blockchainInfoLastBlock,
            lag: this.blockchainInfoLastBlock - this.lastProcessedBlockIndex
        }
        if (nodeHeightStale) status.node_height_stale = true
        return status
    }

    // Probe the durable REORG_HALT marker and cache the answer, on a TTL, so every
    // operator-facing surface can report a LATENT halt. The marker is written by
    // verifyReorg; if only verifyReorg read it, a decoder carrying one would keep
    // parsing blocks and report "healthy" until the next reorg tripped it, so a
    // week-old fault would present as a sudden outage.
    //
    // Never throws: a probe fault leaves the last known state in place and is logged
    // once per transition, because a DB blip must not flap a health surface. Fails
    // SAFE in the sense that matters here: it never clears a halt it could not read.
    async checkReorgHalt({ force = false, now = Date.now() } = {}){
        if (!force && this.reorgHaltCheckedAt > 0
            && (now - this.reorgHaltCheckedAt) < REORG_HALT_PROBE_INTERVAL_MS){
            return this.getReorgHaltStatus()
        }
        // Collapse concurrent probes (a health endpoint under a monitoring burst)
        // onto one in-flight query rather than one query per caller.
        if (this._reorgHaltProbeInFlight) return this._reorgHaltProbeInFlight
        this._reorgHaltProbeInFlight = (async () => {
            try {
                if (!this.db) return this.getReorgHaltStatus()
                let marker
                if (typeof this.db.getReorgHaltMarker === 'function'){
                    marker = await this.db.getReorgHaltMarker()
                } else if (typeof this.db.isReorgHalted === 'function'){
                    // Older/minimal db shapes (and the mocks in the verifyReorg suites)
                    // expose only the boolean probe.
                    const halted = await this.db.isReorgHalted()
                    marker = { halted: !!(halted && halted.halted !== undefined ? halted.halted : halted), at: null, reason: null }
                } else {
                    return this.getReorgHaltStatus()
                }
                const wasHalted = this.reorgHalted
                this.reorgHalted        = !!(marker && marker.halted)
                this.reorgHaltReason    = (marker && marker.reason) || null
                this.reorgHaltAt        = (marker && marker.at) || null
                this.reorgHaltCheckedAt = now
                if (this.reorgHalted && !wasHalted){
                    console.error('XChainDecoder: LATENT REORG_HALT MARKER PRESENT - this decoder carries a durable ' +
                        'REORG_HALT row from an aborted rollback. It will keep parsing forward and look healthy, but ' +
                        'the NEXT reorg will refuse to roll back and stop the decoder. This database is NOT a valid ' +
                        'bootstrap source. REQUIRED OPERATOR ACTION: full resync from a known-good snapshot.' +
                        (this.reorgHaltReason ? ' Marker detail: ' + this.reorgHaltReason : ''))
                } else if (!this.reorgHalted && wasHalted){
                    console.warn('XChainDecoder: REORG_HALT marker is gone; halt cleared.')
                }
                return this.getReorgHaltStatus()
            } catch (e){
                console.warn('XChainDecoder: REORG_HALT probe failed (non-fatal), keeping last known state (' +
                    this.reorgHalted + '): ' + (e && e.message))
                return this.getReorgHaltStatus()
            } finally {
                this._reorgHaltProbeInFlight = null
            }
        })()
        return this._reorgHaltProbeInFlight
    }

    // Cached view of the halt marker for health surfaces. `checked_at` is null until
    // the first successful probe, so a consumer can tell "not halted" apart from
    // "never looked".
    getReorgHaltStatus(){
        return {
            halted:     !!this.reorgHalted,
            reason:     this.reorgHaltReason || null,
            at:         this.reorgHaltAt || null,
            checked_at: this.reorgHaltCheckedAt || null
        }
    }

    stop(){
        this.stopFlag = true
    }
    
    //This function is used to decipher the data inside xchain transaction
    async removeObfuscation(data, txid){
        var decryptedData = null

        // A txid too short to yield a 16-byte key AND a 16-byte IV is not a
        // decryptable input: without this guard a null/undefined txid throws
        // TypeError out of `.substr`, and anything under 32 characters reaches
        // crypto with a truncated IV, both of which the catch below rethrows
        // because it only swallows padding/decrypt errors.
        //
        // Returning null here cannot mask a misparse: both callers pass a
        // hex-encoded 32-byte hash (always exactly 64 characters), so no input
        // from a parsed transaction can take this branch. It only makes the
        // function total for the fuzz suite's out-of-band callers.
        if (typeof txid !== 'string' || txid.length < 32){
            return null
        }

        if (Buffer.isBuffer(data)){

            try {
                var cipherKey = txid.substr(0,16)
                var iv = txid.substr(16,16)
                
                var decipher = crypto.createDecipheriv('aes-128-ctr', cipherKey, iv);
                decryptedData = decipher.update(data) // + decipher.final()
                decryptedData = Buffer.concat([decryptedData, decipher.final()])
            } catch (err){
                if ((err.code != "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH") && (err.code != "ERR_OSSL_BAD_DECRYPT")){
                    throw err
                }
                decryptedData = null
            }
        }
        return decryptedData
    }
    
    async parseRawTransaction(rawTransaction){
        // Parse via xchainBlockDecoder.transactionFromHex, not bitcoin.Transaction.fromHex:
        // the former strips the LTC MWEB marker+flag (0x08/0x09) that makes vanilla strict
        // parsing throw a deterministic UInt64 range error. See getSourceFromOutput.
        return await this.parseTransaction(this.xchainBlockDecoder.transactionFromHex(rawTransaction))
    }
    
    async getSourceFromOutput(txId, outputIndex){
        let source = null
        let output = null
        let outputTransaction = null

        // A prevout lookup that FAILS is not a prevout that does not exist. Swallowing
        // the failure into source=null made this instance skip (or mis-source) a tx that
        // every healthy instance accepts, committing instance-dependent block contents.
        // Tag and rethrow instead: the block loop rolls the whole block back and retries,
        // so a block is only ever committed from fully-resolved lookups. The prevout of a
        // confirmed tx always exists on a txindex node, so an empty RPC result is a
        // lookup failure too, never "absent".
        try {
            let outputRawTransaction = await this.connector.getRawTransaction(txId)
            if (!outputRawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed prevout tx ${txId}`)
            }
            // MUST parse through transactionFromHex (strips the LTC MWEB marker+flag), not
            // bitcoin.Transaction.fromHex. A funding/prevout tx on Litecoin can carry the
            // MWEB flag (0x08/0x09); vanilla strict parsing throws a deterministic UInt64
            // range error, which the catch below then mis-tags as rpcLookupFailure=true.
            // The block loop treats rpcLookupFailure as transient node trouble and retries
            // the block FOREVER, so a deterministic content-parse error would wedge every
            // LTC decoder instance permanently. transactionFromHex is the same parser the
            // block path uses; for BTC/DOGE and non-flagged txs it is a plain parse.
            outputTransaction = this.xchainBlockDecoder.transactionFromHex(outputRawTransaction)
        } catch (err){
            this.rpcErrors++
            console.error(`getSourceFromOutput: failed to fetch tx ${txId} (output ${outputIndex}): `, err)
            err.rpcLookupFailure = true
            throw err
        }
        // An out-of-range output index is deterministic content (the same on every
        // instance), so it may still resolve to a null source below.
        output = outputTransaction.outs[outputIndex]

        if (output != null){
            let script = output.script
            //Check if output is a P2SH or P2WSH data-carrying reveal output. If so,
            //the spent output's own address is the script (commit) address, not the
            //signer; walk back one hop to the commit tx's first input and take
            //THAT prev output's address (the funder/issuer). Without the P2WSH branch
            //the source of every P2WSH-encoded action resolved to the bech32 script
            //address (bcrt1q...), which holds no gas → spurious "insufficient funds (FEE)".
            let isP2sh = (
                (script.length == 23) //23 bytes for a standard p2sh
                && (script[0] == 0xa9) //OP_HASH160
                && (script[1] == 0x14) //PUSH 20 bytes
                && (script[23 - 1] == 0x87) //OP_EQUAL
            )
            let isP2wsh = (
                (script.length == 34) //34 bytes for a standard p2wsh
                && (script[0] == 0x00) //OP_0 (witness v0)
                && (script[1] == 0x20) //PUSH 32 bytes
            )
            if (isP2sh || isP2wsh){
                let prevOutputIndex = outputTransaction.ins[0].index
                let prevTxHash = util.uint8ArrayToHex(Buffer.from(outputTransaction.ins[0].hash).reverse())
                // Same fail-loud contract as the first fetch: tag the failure so the
                // block loop retries the block instead of quarantining the tx.
                let prevTransaction
                try {
                    let prevRawTransaction = await this.connector.getRawTransaction(prevTxHash)
                    if (!prevRawTransaction){
                        throw new Error(`empty getrawtransaction result for confirmed commit-funding tx ${prevTxHash}`)
                    }
                    // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex; see above.
                    prevTransaction = this.xchainBlockDecoder.transactionFromHex(prevRawTransaction)
                } catch (err){
                    this.rpcErrors++
                    console.error(`getSourceFromOutput: failed to fetch commit-funding tx ${prevTxHash}: `, err)
                    err.rpcLookupFailure = true
                    throw err
                }
                output = prevTransaction.outs[prevOutputIndex]
            }
            
            
            try {
                if (!this.isFutureSegwitScript(output.script))
                    source = bitcoin.address.fromOutputScript(output.script, this.network)
            } catch(err){
                // No representable address for this output script (P2PK, bare
                // multisig, ...): leave source null rather than failing the parse.
            }
        }
        
        return source
    }
    
    extractPubkeyFromInput(input){
        // P2WPKH or P2SH-P2WPKH: pubkey is second witness element
        if (input.witness && input.witness.length >= 2){
            let pubkey = input.witness[1]
            if (pubkey && (pubkey.length === 33 || pubkey.length === 65)){
                return pubkey.toString('hex')
            }
        }
        // P2PKH: scriptSig is <sig> <pubkey>, decompile and take last element
        if (input.script && input.script.length > 0){
            let decompiledScript = bitcoin.script.decompile(input.script)
            if (decompiledScript && decompiledScript.length >= 2){
                let lastElement = decompiledScript[decompiledScript.length - 1]
                if (Buffer.isBuffer(lastElement) && (lastElement.length === 33 || lastElement.length === 65)){
                    return lastElement.toString('hex')
                }
            }
        }
        return null
    }

    isFutureSegwitScript(script) {
        // Native segwit scripts: version byte (OP_0..OP_16) + push length + witness program
        // Total length is 4-42 bytes.  OP_0 (v0) and OP_1 (v1/taproot) are handled by
        // bitcoinjs-lib; OP_2-OP_16 (0x52-0x60) are "future" versions that trigger a
        // console warning.  Must also verify the push-length byte matches, otherwise
        // non-segwit scripts like P2PKH (starts with OP_DUP=0x76) would be misclassified.
        if (script.length < 4 || script.length > 42) return false
        let version = script[0]
        if (version < 0x52 || version > 0x60) return false
        let pushLen = script[1]
        return pushLen >= 2 && pushLen <= 40 && script.length === pushLen + 2
    }

    // Local recognition height for the Taproot envelope on this decoder's
    // chain+network, or null when the envelope is never active here (DOGE, or
    // an unknown key). Null-safe by construction so a mis-set env can only
    // disable recognition, never enable it early.
    envelopeRecognitionHeight(){
        const coinMap = ENVELOPE_RECOGNITION_ACTIVATION[this.coinTick]
        const height = coinMap ? coinMap[this.consensusNetwork] : null
        return (typeof height === 'number') ? height : null
    }

    // Whether envelope recognition (and the §3.8 rejection rules, which
    // activate at the SAME height) applies at `blockHeight`. A missing height
    // (undefined caller, e.g. a bare parseRawTransaction) resolves to
    // INACTIVE: the pre-flag behavior is the shipped one, so defaulting closed
    // can never make replay diverge from history.
    envelopeActiveAt(blockHeight){
        const activationHeight = this.envelopeRecognitionHeight()
        return activationHeight !== null
            && typeof blockHeight === 'number'
            && blockHeight >= activationHeight
    }

    // Pattern-match one input's witness stack against the envelope grammar
    // (envelope spec §3.2). Pure and RPC-free by contract (§3.8: recognition is
    // free pattern-matching; the commit fetch happens once, later, at parse).
    // Returns { script, payload } or null; NEVER throws (a foreign/fuzzed
    // witness must not crash the block loop).
    //
    // Rules pinned by spec §3.8 and the adversarial vectors:
    // - witness is indexed from the END per BIP341 (control block last, script
    //   second-to-last); a stack carrying an annex (last item leading 0x50) is
    //   NOT recognized, forever;
    // - the magic and format byte are cleartext; a wrong magic or an unknown
    //   format byte yields null (invisible, not an invalid action);
    // - the structure is exact: OP_FALSE OP_IF <"XCHN"> <0x00> <payload push
    //   1..n> OP_ENDIF <32-byte key> OP_CHECKSIG, nothing more. Any payload
    //   element that decompiles to a bare opcode (a minimally-encoded 1-byte
    //   push the encoder's rebalance never emits) breaks the pattern and
    //   yields null deterministically.
    detectEnvelopeWitness(witness){
        try {
            if (!witness || witness.length < 2) return null
            let stackTop = witness.length - 1
            const lastItem = witness[stackTop]
            if (!Buffer.isBuffer(lastItem) || lastItem.length === 0) return null
            // Annex present: at least (script, control, annex) would remain,
            // but the rule is unconditional: annex-bearing => not an envelope.
            if (lastItem[0] === TAPROOT_ANNEX_MARKER) return null
            const controlBlock = witness[stackTop]
            if ((controlBlock[0] & 0xfe) !== TAPROOT_LEAF_VERSION) return null
            if (controlBlock.length < 33 || ((controlBlock.length - 33) % 32) !== 0) return null
            const script = witness[stackTop - 1]
            if (!Buffer.isBuffer(script) || script.length < 8) return null

            const decompiled = bitcoin.script.decompile(script)
            // Minimum shape: OP_0, OP_IF, magic, format, 1 push, OP_ENDIF, key, OP_CHECKSIG.
            if (!decompiled || decompiled.length < 8) return null
            let i = 0
            if (decompiled[i++] !== bitcoin.opcodes.OP_0) return null
            if (decompiled[i++] !== bitcoin.opcodes.OP_IF) return null
            if (!Buffer.isBuffer(decompiled[i]) || !decompiled[i].equals(MAGIC_WORD_BUFFER)) return null
            i++
            const formatByte = decompiled[i++]
            if (!Buffer.isBuffer(formatByte) || formatByte.length !== 1) return null
            // Unknown format bytes are not recognized: invisible by design,
            // future formats activate via their own flag heights (§3.2).
            if (formatByte[0] !== 0x00) return null
            // The 32-byte internal-key push sits AFTER OP_ENDIF, so this loop
            // stops exactly at OP_ENDIF for a well-formed envelope; a payload
            // element that decompiled to a bare opcode stops it early and the
            // OP_ENDIF check below fails the walk.
            const payloadPushes = []
            while (i < decompiled.length && Buffer.isBuffer(decompiled[i])){
                payloadPushes.push(decompiled[i])
                i++
            }
            if (payloadPushes.length === 0) return null
            if (decompiled[i++] !== bitcoin.opcodes.OP_ENDIF) return null
            if (!Buffer.isBuffer(decompiled[i]) || decompiled[i].length !== 32) return null
            i++
            if (decompiled[i++] !== bitcoin.opcodes.OP_CHECKSIG) return null
            if (i !== decompiled.length) return null
            return { script, payload: Buffer.concat(payloadPushes) }
        } catch (err){
            // Fuzzed/hostile witnesses must never crash recognition.
            return null
        }
    }

    // Source attribution for an envelope reveal (envelope spec §3.4): the
    // reveal's ins[0] prevout is the commit output, a payload-dependent
    // one-time P2TR address nothing else references, so the source is the
    // address FUNDING the commit: the prevout of the COMMIT transaction's
    // ins[0]. This is structurally the same walk-back getSourceFromOutput
    // already performs for P2SH/P2WSH data-carrier outputs (fetch the spent
    // tx, hop to ITS ins[0] prevout), scoped to recognized envelopes only so
    // ordinary actions spent FROM a taproot address keep their shipped
    // attribution. Takes the already-fetched commit transaction (the commit is
    // fetched exactly once per recognized envelope, §3.8); fail-loud contract
    // matches getSourceFromOutput (rpcLookupFailure tagging).
    async getEnvelopeSourceFromCommit(commitTransaction){
        if (!commitTransaction.ins || commitTransaction.ins.length === 0) return null
        const prevTxHash = util.uint8ArrayToHex(Buffer.from(commitTransaction.ins[0].hash).reverse())
        const prevOutputIndex = commitTransaction.ins[0].index
        let prevTransaction
        try {
            const prevRawTransaction = await this.connector.getRawTransaction(prevTxHash)
            if (!prevRawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed commit-funding tx ${prevTxHash}`)
            }
            // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex.
            prevTransaction = this.xchainBlockDecoder.transactionFromHex(prevRawTransaction)
        } catch (err){
            this.rpcErrors++
            console.error(`getEnvelopeSourceFromCommit: failed to fetch commit-funding tx ${prevTxHash}: `, err)
            err.rpcLookupFailure = true
            throw err
        }
        const output = prevTransaction.outs[prevOutputIndex]
        if (output == null) return null
        let source = null
        try {
            if (!this.isFutureSegwitScript(output.script))
                source = bitcoin.address.fromOutputScript(output.script, this.network)
        } catch (err){
            // No representable address (P2PK, bare multisig, ...): null source,
            // matching getSourceFromOutput.
        }
        return source
    }

    // Fetch + parse the envelope commit transaction, once per recognized
    // envelope (§3.8). Same fail-loud rpcLookupFailure contract as every other
    // confirmed-prevout fetch: the commit of a confirmed reveal always exists
    // on a txindex node, so an empty result is a lookup failure, never absence.
    async fetchEnvelopeCommitTransaction(commitTxId){
        try {
            const rawTransaction = await this.connector.getRawTransaction(commitTxId)
            if (!rawTransaction){
                throw new Error(`empty getrawtransaction result for confirmed envelope commit tx ${commitTxId}`)
            }
            return this.xchainBlockDecoder.transactionFromHex(rawTransaction)
        } catch (err){
            this.rpcErrors++
            console.error(`fetchEnvelopeCommitTransaction: failed to fetch commit tx ${commitTxId}: `, err)
            err.rpcLookupFailure = true
            throw err
        }
    }

    // For a P2SH/P2WSH reveal, the native-coin fee output lives on the funding (commit) transaction:
    // the wallet/SDK place the fee output on the first tx they generate, and the reveal (this action's
    // tx) spends that commit's P2SH outputs. Fetch the funding tx and return any output paying the
    // protocol FEE_DESTINATION, shaped as a paymentOutput, so the indexer sees it among this action's
    // transaction_outputs and can validate the native-coin fee. Deterministic (same commit → same
    // output). Returns [] only for deterministic reasons (no fee destination configured, no funding
    // txid). A FAILED lookup throws (tagged rpcLookupFailure) so the block loop retries the block:
    // treating it as "no fee output" committed fee outputs on some instances and not others, and
    // whether an action paid its fee must never depend on which instance decoded it.
    async findFundingFeeOutputs(fundingTxId, prefetchedFundingTx = null){
        let results = []
        if (!this.feeDestination || !fundingTxId) return results
        // prefetchedFundingTx: the Taproot-envelope path fetches the commit
        // exactly once (spec §3.8) and hands the parsed tx in here, so the fee
        // resolver extends to the commit without a second RPC round trip. The
        // chunk lanes keep the fetch below.
        let fundingTx = prefetchedFundingTx
        if (!fundingTx){
            try {
                let fundingTxHex = await this.connector.getRawTransaction(fundingTxId)
                if (!fundingTxHex){
                    throw new Error(`empty getrawtransaction result for confirmed funding tx ${fundingTxId}`)
                }
                // transactionFromHex (MWEB-flag-safe), not bitcoin.Transaction.fromHex; see getSourceFromOutput.
                fundingTx = this.xchainBlockDecoder.transactionFromHex(fundingTxHex)
            } catch (err){
                this.rpcErrors++
                console.error(`findFundingFeeOutputs: failed to fetch funding tx ${fundingTxId}:`, err.message)
                err.rpcLookupFailure = true
                throw err
            }
        }
        for (let vout = 0; vout < fundingTx.outs.length; vout++){
            let output = fundingTx.outs[vout]
            let outputAddress = null
            try {
                if (!this.isFutureSegwitScript(output.script))
                    outputAddress = bitcoin.address.fromOutputScript(output.script, this.network)
            } catch (err){
                //the output script has no matching address; skip
            }
            if (outputAddress && outputAddress === this.feeDestination){
                results.push({ vout: vout, destinationAddress: outputAddress, amount: output.value })
            }
        }
        return results
    }

    // A v0 DISPENSER open is valid for THIS chain only when BOTH coin fields name
    // this chain's native coin. This mirrors the indexer's four format==0 checks
    // (xchain-indexer/src/actions/dispenser.js): GIVE_COIN and GET_COIN must each be
    // a supported COIN AND equal the local COIN. Requiring both to equal this.coinTick
    // satisfies all four at once (the local coin is by definition supported).
    //
    // The decoder previously opened a dispenser whenever EITHER coin field was merely
    // non-empty, admitting three shapes the indexer rejects outright: GIVE_COIN set
    // with GET_COIN empty, GET_COIN set with GIVE_COIN empty, and either field naming
    // a foreign network (e.g. a DOGE-configured decoder seeing DISPENSER|0|BTC|...).
    // The decoder then held an open-dispenser row the indexer has no record of and
    // reclassified every later ordinary native-coin payment to that address as a
    // (failed) dispense. Tightening the gate keeps decoder and indexer in agreement.
    //
    // Only command version 0 carries these coin fields; the caller already gates this
    // check behind commandVersion === 0, so other/future versions are unaffected.
    dispenserOpensForThisChain(giveCoin, getCoin){
        return giveCoin === this.coinTick && getCoin === this.coinTick
    }

    // Does a split v0 DISPENSER create payload carry every field the indexer
    // requires? Split indices are offset by one from the indexer's field list
    // because the decoder splits the whole action string, ACTION token included:
    //
    //   [0] DISPENSER [1] VERSION [2] GIVE_COIN [3] GIVE_TICK [4] GIVE_AMOUNT
    //   [5] GIVE_OWNERSHIP [6] GIVE_ESCROW [7] GET_COIN [8] GET_TICK
    //   [9] GET_AMOUNT [10] GET_ADDRESS [11] FIAT_CODE [12] FIAT_AMOUNT
    //   [13] ORACLE_ADDRESS [14] EXPIRATION [15] ALLOW_LIST [16] BLOCK_LIST
    //   [17] MEMO
    //
    // Everything from GET_ADDRESS on is optional (GET_ADDRESS defaults to
    // SOURCE, EXPIRATION to a block-time window), so the required run ends at
    // GET_AMOUNT and a conforming create is at least 10 tokens long.
    //
    // This gate was >= 14, which silently dropped every create whose optional
    // tail was omitted rather than padded - the shape the wallet emits when the
    // seller keeps the default expiry (`DISPENSER|0|BTC|TICK|500||2000|BTC||0.01`,
    // 10 tokens). The indexer opened those dispensers and showed them valid with
    // escrow locked while the decoder never registered the operating address, so
    // buyer payments were never recognised as dispenses: the buyer's coin went to
    // the seller and no tokens came back. Verified on BTC regtest - a 10-token
    // create took a payment and dispensed nothing; the same create with an
    // explicit EXPIRATION (15 tokens) dispensed correctly.
    hasRequiredDispenserCreateFields(decodedDataSplit){
        return Array.isArray(decodedDataSplit) && decodedDataSplit.length >= 10
    }

    // The ORACLE_ADDRESSes whose native-coin outputs this transaction's payment-output
    // capture must persist, as an array (empty when there are none).
    //
    // A Mode B dispenser pays its PRICE v1 oracle operator up front as a real on-chain
    // output, and the indexer rejects the create/refill when it cannot SEE that output
    // in `transaction_outputs` (utility.validateOracleFee). The decoder stays
    // address-keyed and prices nothing: it captures any output paying the oracle address
    // this transaction is associated with and leaves every amount/eligibility question to
    // the indexer, exactly as it does for the protocol FEE_DESTINATION.
    //
    //   v0 (create): the address is in the payload itself (field 13), so this is always a
    //       one-element answer.
    //   v2 (edit/refill): the payload carries no address. It names the target by
    //       DISPENSER_ACTION_INDEX, an id in the INDEXER's action space the decoder does
    //       not maintain, so the oracle address is read back from the open dispenser rows
    //       this decoder registered, resolved by SOURCE address. That match covers the
    //       create SOURCE as well as the operating address, so a delegated (GET_ADDRESS)
    //       dispenser refilled by its original creator resolves too. An unmatched SOURCE
    //       captures nothing and the indexer rejects that refill, which is fail-closed.
    //
    //       Which rows a v2 resolves to is itself gated, on
    //       ORACLE_FEE_SET_CAPTURE_ACTIVATION:
    //         at/above it - EVERY open Mode B dispenser of that source, and the caller
    //             tests membership. No ORDER BY can identify the DISPENSER_ACTION_INDEX
    //             target, so the set is the only answer that captures the right output for
    //             a source holding more than one open dispenser.
    //         below it - the legacy single top-ranked pick, preserved byte-for-byte
    //             because widening the persisted output set is consensus-affecting and a
    //             re-decode of pre-flag-day history must reproduce what the fleet wrote.
    //             Its known defect (a refill of any non-top-ranked row captures nothing)
    //             is stated at getOpenDispenserOracleAddressBySource in db.js.
    //
    // Returns false on a DB fault so the caller can roll the block back: silently
    // capturing nothing would make this node disagree with a healthy one about what the
    // transaction paid, which is a ledger fork rather than a missed row.
    async resolveOracleFeeAddresses(decodedData, source, blockTime, transactionHash){
        if (typeof decodedData !== 'string' || !decodedData.startsWith("DISPENSER|"))
            return []
        // Consensus gate. Below it the decoder captures nothing, so a fee-bearing Mode B
        // create is rejected whether or not it paid - the fail-closed direction, and the
        // one that keeps a from-genesis re-decode byte-identical to what live nodes wrote.
        // The gate is armed to the indexer's FIX_OUTPUT_FANOUT instant because capturing a
        // SECOND output on a data-bearing transaction fans it out to two rows, which below
        // that flag-day is a consensus-critical fault that halts the block.
        if (!isOracleFeeCaptureActive(this.consensusNetwork, blockTime))
            return []

        let fields = decodedData.split("|")
        let format = parseInt(fields[1], 10)

        if (format === 0){
            if (isCompactedOracleAddress(fields)){
                // Unresolvable `^<id>` reference into the indexer's address-id space. Log
                // it the way the sibling GET_ADDRESS case does rather than capturing
                // against a token no output can pay. The SDK does not compact this field
                // (addressRefFields.js `noCompact`), so this is a third-party composer or
                // a historical replay.
                this.parseErrors++
                console.error(`Oracle-fee output NOT captured for tx ${transactionHash}: compacted ORACLE_ADDRESS reference '${fields[13]}' cannot be resolved by the decoder, so the indexer will reject this dispenser create`)
                return []
            }
            let createOracleAddress = oracleAddressFromCreate(fields)
            return createOracleAddress ? [createOracleAddress] : []
        }

        if (format === 2){
            if (!source || source.length === 0) return []
            if (isOracleFeeSetCaptureActive(this.consensusNetwork, blockTime)){
                let oracleAddresses = await this.db.getOpenDispenserOracleAddressesBySource(source)
                if (oracleAddresses === false) return false
                // db.js returns an array; any iterable of addresses (a Set, say) is accepted
                // so an alternate accessor shape degrades to a correct capture rather than
                // to a silently empty one. A bare string is NOT one: spreading it would
                // make every character a set member.
                if (!oracleAddresses || typeof oracleAddresses === 'string' ||
                    typeof oracleAddresses[Symbol.iterator] !== 'function') return []
                // Drop null/empty entries defensively: an unresolvable address must never
                // become a set member, or an output whose own address failed to resolve
                // (also null) would match it and be captured by accident.
                return [...oracleAddresses].filter(nextAddress => typeof nextAddress === 'string' && nextAddress.length > 0)
            }
            let oracleAddress = await this.db.getOpenDispenserOracleAddressBySource(source)
            if (oracleAddress === false) return false
            return oracleAddress ? [oracleAddress] : []
        }

        return []
    }

    // blockHeight gates Taproot-envelope recognition (envelope spec §7): the
    // confirmed-block path passes the block being parsed, the mempool path
    // passes its next-block estimate. Omitted/undefined resolves to INACTIVE
    // (shipped pre-flag behavior), so no caller can accidentally recognize
    // envelopes below the flag height.
    async parseTransaction(transaction, openDispenserAddresses, db, blockHeight){
        // openDispenserAddresses is a Set of every open-dispenser address, loaded
        // once per block by the caller. Membership is tested in JS here instead of
        // issuing a DB round-trip per output. Defensive fallback to an empty Set
        // keeps callers that don't pass it (e.g. some unit tests) working.
        if (!openDispenserAddresses) openDispenserAddresses = new Set()
        // db is the handle used for the pubkey-capture writes below. The block path passes
        // this.db (default); the mempool path passes this.mempoolDb so pubkey writes for a
        // pending tx never touch the block's open transaction.
        if (!db) db = this.db
        // A zero-input transaction has no ins[0] to dereference below (the coinbase/
        // standard_input guard also reads ins[0]). An LTC MWEB/HogEx integration tx can
        // parse to zero canonical inputs after marker+flag stripping; such a tx carries no
        // XChain data. Skip it cleanly here, mirroring the mempool path's ins.length guard,
        // so it never throws a TypeError that costs 3 wasted block re-parses + a spurious
        // PARSE_ERROR quarantine event.
        if (!transaction.ins || transaction.ins.length === 0) return null
        let nextTxId = transaction.getId()
        let firstInputTxId = util.uint8ArrayToHex(Buffer.from(transaction.ins[0].hash).reverse())
        let standardInput = ("standard_input" in transaction.ins[0]?transaction.ins[0]["standard_input"]:true)
        let dispenseOutputs = []
        let paymentOutputs = []
        // For a P2SH/P2WSH reveal, the funding (commit) tx (whose outputs this reveal spends) is the
        // first input's previous tx. Native-coin fee outputs are placed there (not on the reveal), so we
        // capture the funding txid to look them up before returning. Null for non-P2SH transactions.
        let p2shFundingTxId = null

        //Ignore coin base transactions
        if ((firstInputTxId != "0000000000000000000000000000000000000000000000000000000000000000") && standardInput){
            let source = null
            let dataBuffer = Buffer.allocUnsafe(0)
            let rawData = null
            let getSource = false

            // Taproot-envelope recognition (envelope spec §3.8), height-gated:
            // below the flag height this whole surface is inert and the tx
            // parses EXACTLY as shipped (a pre-flag mixed-carrier tx replays as
            // the fleet indexed it live). Recognition is a pure, RPC-free
            // pattern match over the inputs' witness stacks.
            const envelopeActive = this.envelopeActiveAt(blockHeight)
            let envelopeInputs = []
            if (envelopeActive){
                for (let txInputIndex = 0; txInputIndex < transaction.ins.length; txInputIndex++){
                    const detected = this.detectEnvelopeWitness(transaction.ins[txInputIndex].witness)
                    if (detected) envelopeInputs.push({ index: txInputIndex, payload: detected.payload })
                }
            }
            // Set when this tx's action is carried by a (single, valid)
            // envelope; routes the per-encoding ceiling, the commit-based
            // source attribution and the commit fee-output resolution below.
            let envelopeCarrier = false
            let envelopeCommitTransaction = null

            for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
                // Invariant guard: a real on-chain output index must stay below FUNDING_VOUT_BASE
                // so it can never collide with an attributed funding fee output stored at
                // vout + FUNDING_VOUT_BASE. This is structurally impossible for a Bitcoin-family
                // tx (output counts are bounded far below the base), so if it ever fires the base
                // has been mis-sized and the funding/real vout domains are no longer disjoint.
                if (txOutputIndex >= FUNDING_VOUT_BASE){
                    console.error(`FATAL invariant violation: real output index ${txOutputIndex} in tx ${nextTxId} reaches FUNDING_VOUT_BASE (${FUNDING_VOUT_BASE}); funding fee outputs can no longer be stored collision-free`)
                }
                let nextOutput = transaction.outs[txOutputIndex]
                let decompiledScript = bitcoin.script.decompile(nextOutput.script)
                let nextDataBuffer = new Buffer.allocUnsafe(0)

                let outputAddress = null
                try {
                    if (!this.isFutureSegwitScript(nextOutput.script))
                        outputAddress = bitcoin.address.fromOutputScript(nextOutput.script, this.network)
                } catch (err){
                    //the output script has no matching address
                }

                if (outputAddress){
                    let outputIsDispense = openDispenserAddresses.has(outputAddress)

                    if (outputIsDispense){
                        let dispenseOutput = {
                            txIndex:nextTxId,
                            vout:txOutputIndex,
                            destinationAddress:outputAddress,
                            amount:nextOutput.value
                        }

                        dispenseOutputs.push(dispenseOutput)
                        getSource = true
                    } else {
                        // Capture every non-OP_RETURN, non-dispense output. The indexer
                        // fans out per-output processing for payment actions (e.g. COINPAY)
                        // by LEFT JOIN-ing transaction_outputs and parsing once per row.
                        paymentOutputs.push({
                            vout:txOutputIndex,
                            destinationAddress:outputAddress,
                            amount:nextOutput.value
                        })
                    }
                }
                
                if ((decompiledScript != null) && (decompiledScript.length > 0)){
                    // OP_RETURN carrier
                    if (
                        (decompiledScript.length == 2)
                        && (decompiledScript[0] == bitcoin.opcodes.OP_RETURN)
                    ){
                        let dataWithoutObfuscation = await this.removeObfuscation(decompiledScript[1], firstInputTxId)

                        if (dataWithoutObfuscation != null){
                            if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
                                // P2SH chunk carrier: the OP_RETURN only flags the encoding,
                                // the payload chunks live in the inputs' redeem scripts.
                                if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2SH_BUFFER)){
                                    p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                                    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
                                        let nextInput = transaction.ins[txInputIndex]
                                        try {
                                            let decodedScriptSig = bitcoin.script.decompile(nextInput["script"])
                                            if (!decodedScriptSig || decodedScriptSig.length < 3 || !Buffer.isBuffer(decodedScriptSig[2])) continue
                                            let decodedRedeemScript = bitcoin.script.decompile(decodedScriptSig[2])
                                            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
                                            let decodedData = decodedRedeemScript[0]
                                            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
                                        } catch (e) {
                                            this.parseErrors++
                                            console.error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
                                            // Do NOT drop this input's chunk and keep concatenating: a missing
                                            // interior chunk leaves nextDataBuffer holding a silently truncated
                                            // ACTION payload that can still decompile to a corrupted push, with no
                                            // quarantine event. Fail the whole tx instead so the block loop routes
                                            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
                                            // path (this file's fail-loud-or-quarantine contract).
                                            throw new Error(`P2SH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
                                        }
                                    }

                                // P2WSH chunk carrier: same shape as P2SH, chunks in the witness.
                                } else if (dataWithoutObfuscation.subarray(MAGIC_WORD.length).equals(P2WSH_BUFFER)){
                                    p2shFundingTxId = firstInputTxId // commit tx carrying any native-coin fee output
                                    for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
                                        let nextInput = transaction.ins[txInputIndex]
                                        try {
                                            if (!nextInput["witness"] || nextInput["witness"].length < 3 || !Buffer.isBuffer(nextInput["witness"][2])) continue
                                            let decodedRedeemScript = bitcoin.script.decompile(nextInput["witness"][2])
                                            if (!decodedRedeemScript || decodedRedeemScript.length < 1 || !Buffer.isBuffer(decodedRedeemScript[0])) continue
                                            let decodedData = decodedRedeemScript[0]
                                            nextDataBuffer = Buffer.concat([nextDataBuffer,decodedData])
                                        } catch (e) {
                                            this.parseErrors++
                                            console.error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}:`, e)
                                            // Do NOT drop this input's chunk and keep concatenating: a missing
                                            // interior chunk leaves nextDataBuffer holding a silently truncated
                                            // ACTION payload that can still decompile to a corrupted push, with no
                                            // quarantine event. Fail the whole tx instead so the block loop routes
                                            // it through the TX_PARSE_MAX_RETRIES retry-then-PARSE_ERROR quarantine
                                            // path (this file's fail-loud-or-quarantine contract).
                                            throw new Error(`P2WSH data extraction failed for input ${txInputIndex} of tx ${nextTxId}: ${e && e.message ? e.message : e}`)
                                        }
                                    }
                                } else {
                                    nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
                                }
                            }
                        }
                        
                    } else
                    // MULTISIGN carrier
                    if (
                        (decompiledScript.length == 6)
                        && (decompiledScript[5] == bitcoin.opcodes.OP_CHECKMULTISIG)
                    ){
                        if (!Buffer.isBuffer(decompiledScript[1]) || !Buffer.isBuffer(decompiledScript[2])) {
                            continue
                        }

                        let pubkey1 = decompiledScript[1].subarray(1) //removing the 02 at the beginning
                        let pubkey2 = decompiledScript[2].subarray(1) //removing the 02 at the beginning

                        let data = Buffer.concat([pubkey1, pubkey2])

                        // We intentionally do NOT strip trailing zero bytes here.
                        // The encoder's prepareData() zero-pads the plaintext chunk to fill
                        // the 64-byte MULTISIGN slot BEFORE obfuscation, so after decryption
                        // the trailing bytes are literal 0x00 (not keystream). The final
                        // partial chunk always carries this pad; a full 64-byte chunk also
                        // has a ~1/256 chance of a genuine 0x00 last ciphertext byte. Stripping
                        // either dropped a real byte, decrypted one byte short, and silently
                        // corrupted the payload (bitcoin.script.decompile returned null on the
                        // truncated buffer). Instead we decrypt the full chunk. The trailing
                        // 0x00 bytes fall outside the payload's own self-describing
                        // compiled-script length and are discarded when the reassembled buffer
                        // is run through bitcoin.script.decompile() below.
                        let dataWithoutObfuscation = await this.removeObfuscation(data, firstInputTxId)
                        
                        if (dataWithoutObfuscation != null){
                            if (dataWithoutObfuscation.subarray(0, MAGIC_WORD.length).equals(MAGIC_WORD_BUFFER)){
                                nextDataBuffer = Buffer.concat([nextDataBuffer,dataWithoutObfuscation.subarray(MAGIC_WORD.length)])
                            }
                        }
                    } 
                }

                if (nextDataBuffer.length > 0){
                    dataBuffer = Buffer.concat([dataBuffer,nextDataBuffer])
                }
            }
            
            // Carrier arbitration for the Taproot envelope (envelope spec §3.8),
            // active only at/above the recognition height. Deterministic rules,
            // pinned by the adversarial vectors:
            // - a tx containing an envelope PLUS any other candidate carrier
            //   (OP_RETURN XCHN data, chunk marker, MULTISIGN outputs, i.e.
            //   anything the loop above accumulated or flagged) is NOT a valid
            //   action;
            // - a tx with two or more envelope inputs is NOT a valid action;
            // - an envelope anywhere but ins[0] is NOT a valid action (§3.5:
            //   reveal input 0 MUST be the commit outpoint; attribution and
            //   fee resolution assume it).
            // "Not a valid action" clears the action payload only: dispense and
            // payment outputs stay recorded, exactly like any other no-action
            // money-bearing tx.
            if (envelopeActive && envelopeInputs.length > 0){
                const otherCarrierPresent = (dataBuffer.length > 0) || (p2shFundingTxId != null)
                if (envelopeInputs.length >= 2 || otherCarrierPresent || envelopeInputs[0].index !== 0){
                    this.parseErrors++
                    console.error(`Tx ${nextTxId}: envelope rejected deterministically (` +
                        `${envelopeInputs.length} envelope input(s) at [${envelopeInputs.map(e => e.index).join(',')}]` +
                        `${otherCarrierPresent ? ', mixed with another carrier' : ''}); no action`)
                    dataBuffer = Buffer.allocUnsafe(0)
                    p2shFundingTxId = null
                } else {
                    // Single valid envelope at ins[0]: it IS the carrier. The
                    // payload is the reassembled compiled action stream (raw by
                    // design, §3.3: no deobfuscation step exists for the
                    // envelope) and feeds the identical decompile below, so the
                    // indexer stays encoding-blind. ins[0] spends the commit,
                    // so firstInputTxId IS the commit txid: native fee outputs
                    // ride it (§3.5), resolved via the same funding-fee
                    // mechanism as the chunk lanes; the commit is fetched once
                    // here and reused for attribution + fee resolution.
                    dataBuffer = envelopeInputs[0].payload
                    envelopeCarrier = true
                    envelopeCommitTransaction = await this.fetchEnvelopeCommitTransaction(firstInputTxId)
                    p2shFundingTxId = firstInputTxId
                }
            }

            // compiledDataLength starts as the raw accumulated byte count.
            // For P2SH/P2WSH/OP_RETURN this equals the compiled push size (the
            // script already carries the OP_PUSHDATA prefix). For MULTISIGN the
            // slots are zero-padded to 64 bytes each, so this value is inflated
            // by up to 59 bytes of pad on the final chunk. We re-measure below
            // once the decompile result is available -- EXCEPT for the
            // envelope, whose §4 measurand is exactly this initial value: the
            // reassembled payload byte length before parse. The re-measure
            // must not run for it: compiledPushSize models push framing only
            // up to OP_PUSHDATA2 (+3), but an envelope rawData push above
            // 65,535 bytes is framed with OP_PUSHDATA4 (+5) inside the payload
            // stream, so re-measuring would under-count by 2 bytes right at
            // the ENVELOPE_MAX_PAYLOAD boundary and accept a payload the
            // encoder validator (which measures true compiled length) refuses.
            let compiledDataLength = dataBuffer.length

            if (dataBuffer.length > 0){
                let decompiledData = bitcoin.script.decompile(dataBuffer)
                if (decompiledData != null && decompiledData.length > 0) {
                    // A single-byte OP_0 segment ([0x00]) decompiles to the integer 0,
                    // not a Buffer, and a non-standard script can decompile to a leading
                    // opcode integer. On any non-Buffer result, reject the degenerate decode:
                    // clear dataBuffer and leave rawData/getSource untouched so a stray opcode
                    // integer can never reach the raw_data column or trigger a spurious source
                    // lookup. Every downstream consumer can then rely on dataBuffer being a
                    // Buffer (otherwise the integer silently fails .length guards and throws in
                    // hex-encoding paths). No valid payload is zero-length, so this is inert
                    // for real data.
                    if (!Buffer.isBuffer(decompiledData[0])){
                        // Visibility only. One shape inside this branch is not the inert
                        // zero-length case the blanking was written for: an EMPTY LEADING
                        // PUSH (OP_0, which decompiles to the integer 0) followed by more
                        // payload. The action push is empty but a second push, the rawData
                        // the sender paid to carry, is still sitting in the stream, and the
                        // blanking below discards it without a trace, so an operator seeing
                        // no action for the tx has nothing to correlate. Report it
                        // distinctly and count it toward parse_errors (a monitoring counter
                        // only). ACCEPTANCE IS DELIBERATELY UNCHANGED: the payload is still
                        // blanked and rawData/getSource are still left untouched. Whether
                        // this wire shape should be accepted end-to-end is a cross-service
                        // flag-day decision that also governs
                        // xchain-encoder/src/validator.js, and must not change here alone.
                        if (decompiledData[0] === 0 && (decompiledData.length > 1 || dataBuffer.length > 1)){
                            this.parseErrors++
                            const droppedPushBytes = decompiledData
                                .slice(1)
                                .reduce((total, push) => total + (Buffer.isBuffer(push) ? push.length : 0), 0)
                            console.error(`Tx ${nextTxId}: empty leading push (OP_0) in a ${dataBuffer.length}-byte ` +
                                `payload carrying ${decompiledData.length - 1} further element(s) totalling ` +
                                `${droppedPushBytes} data byte(s); payload blanked and the trailing push(es), ` +
                                `including any rawData, are NOT read (acceptance unchanged)`)
                        }
                        dataBuffer = Buffer.allocUnsafe(0)
                    } else {
                        dataBuffer = decompiledData[0]
                        // Re-measure compiledDataLength from the decompiled buffer so MULTISIGN
                        // zero-pad inflation does not cause valid payloads in [8161, 8192] bytes
                        // to trip the MAX_ACTION_DATA_LENGTH guard. For P2SH/P2WSH/OP_RETURN the
                        // result is identical to the pre-decompile measurement: the push overhead
                        // (1 byte direct, 2 bytes OP_PUSHDATA1, 3 bytes OP_PUSHDATA2) is added
                        // back, matching exactly what the encoder's compiled script measured.
                        // Never for the envelope: its §4 measurand is the initial pre-decompile
                        // value (see the comment above compiledDataLength's binding).
                        if (!envelopeCarrier){
                            compiledDataLength = compiledPushSize(dataBuffer.length)
                        }
                        if (decompiledData.length > 1){
                            // Mirror the Buffer gate on decompiledData[0] above: decompile
                            // returns opcodes as integers, so a payload whose second element
                            // is an opcode (a trailing OP_1..OP_16/OP_1NEGATE, or the
                            // MULTISIGN zero-pad's OP_0) would otherwise flow a bare integer
                            // into rawData and the raw_data column, a shape no consumer
                            // expects (the encoder's push[1] is always a Buffer).
                            rawData = Buffer.isBuffer(decompiledData[1]) ? decompiledData[1] : null
                            // Count the second push too. The encoder bounds the WHOLE compiled
                            // script (both pushes) against MAX_COMPILED_ACTION_DATA_LENGTH, so
                            // measuring only push[0] here let a small action push + a large
                            // rawData push (e.g. a FILE) decode past the guard that the encoder
                            // and validator would have rejected. Add push[1]'s compiled size
                            // (data length + the same OP_PUSH overhead) so the decoder's ceiling
                            // matches the encoder's.
                            if (Buffer.isBuffer(rawData) && !envelopeCarrier){
                                compiledDataLength += compiledPushSize(rawData.length)
                            }
                        }
                        getSource = true
                    }
                } else {
                    dataBuffer = Buffer.allocUnsafe(0)
                }
            }
            
            //Get the source from the output spent by the first input of this transaction
            //only if there is data or a dispense and the source was not retrieved before.
            //Envelope reveals attribute differently (§3.4): ins[0]'s prevout is the
            //one-time P2TR commit output, so the source is the address funding the
            //COMMIT (its ins[0] prevout), resolved from the already-fetched commit.
            if (getSource && (source == null)){
                source = envelopeCarrier
                    ? await this.getEnvelopeSourceFromCommit(envelopeCommitTransaction)
                    : await this.getSourceFromOutput(firstInputTxId, transaction.ins[0].index)
            }

            //Extract and store public key from the first input if source was found
            if (source){
                let pubkey = this.extractPubkeyFromInput(transaction.ins[0])
                if (pubkey){
                    let addressId = await db.getAddressId(source)
                    if (addressId && !(await db.hasPubkey(addressId))){
                        await db.insertPubkey(addressId, pubkey)
                    }
                }
            }

            //For a P2SH/P2WSH reveal, attribute the native-coin fee output (which lives on the funding
            //commit tx) to this action so the indexer can validate it (see findFundingFeeOutputs).
            if (p2shFundingTxId){
                let fundingFeeOutputs = await this.findFundingFeeOutputs(p2shFundingTxId, envelopeCommitTransaction)
                for (let feeOutput of fundingFeeOutputs){
                    // Remap the FUNDING tx's vout into the reserved funding domain before this output
                    // is stored under the REVEAL's tx_index, so it can never collide on the
                    // (tx_index, vout) primary key with one of the reveal tx's own outputs (a dispense
                    // or COINPAY output at the same vout number). See FUNDING_VOUT_BASE.
                    paymentOutputs.push({
                        ...feeOutput,
                        vout: FUNDING_VOUT_BASE + feeOutput.vout
                    })
                }
            }

            return {
                data:dataBuffer,
                compiledDataLength: compiledDataLength,
                rawData: rawData,
                source:source,
                destination:null,
                dispenseOutputs:dispenseOutputs,
                paymentOutputs:paymentOutputs,
                // Per-encoding §4 ceiling for the size guards at both call
                // sites: the envelope gets ENVELOPE_MAX_PAYLOAD, every legacy
                // lane keeps MAX_ACTION_DATA_LENGTH. Carried in the result so
                // the block and mempool guards cannot drift from what was
                // recognized here.
                payloadCeiling: envelopeCarrier ? ENVELOPE_MAX_PAYLOAD : MAX_ACTION_DATA_LENGTH,
                envelope: envelopeCarrier
            }
        } else {
            return null
        }
    }
    
    async verifyReorg(nodeTip){
        let thereAreDifferences = true
        let blocksDeleted = []
        let retryCount = 0

        // Restart-durable halt guard. The safe-depth ceiling below is a per-invocation
        // counter over durably-committed per-block deletes: once it fired the loud
        // abort mid-rollback, nothing persisted the abort, so a plain process restart
        // re-entered here with a zeroed counter and silently completed the over-deep
        // rollback past the dispenser purge window (permanent, money-bearing
        // dispenser-state divergence). Every abort path now persists a durable
        // REORG_HALT marker (markReorgHalted); on entry we refuse to proceed while it
        // is set, so a restart cannot resume an over-deep rollback. Recovery is the
        // full resync the abort message demands (rebuilding the schema clears it).
        // Feature-detected so the minimal-mock verifyReorg tests stay unaffected.
        if (typeof this.db.isReorgHalted === 'function' && await this.db.isReorgHalted()){
            // Mirror the durable marker into the in-memory health state so the health
            // surface agrees with the abort even before the next TTL probe.
            this.reorgHalted = true
            this.reorgHaltCheckedAt = Date.now()
            const msg = "verifyReorg: decoder is HALTED from a prior over-deep reorg abort. Refusing to "
                + "roll back further: a restart must not silently resume a rollback past the dispenser "
                + "safe-depth window (DISPENSER_EXPIRE_SAFE_DEPTH=" + DISPENSER_EXPIRE_SAFE_DEPTH + "), which "
                + "would permanently lose money-bearing dispenser state. Recovery: perform a full resync "
                + "from a known-good snapshot."
            console.error(msg)
            throw new Error(msg)
        }

        // Persist the durable halt marker before an abort throws (best-effort: swallow
        // write errors so a marker failure never masks the loud abort). Feature-detected.
        const haltReorg = async (reason) => {
            // Set the in-memory health state first: the durable write is best-effort,
            // but this decoder is halted either way and every health surface must say
            // so, including when the marker write itself fails.
            this.reorgHalted = true
            this.reorgHaltReason = reason
            this.reorgHaltAt = new Date().toISOString()
            this.reorgHaltCheckedAt = Date.now()
            if (typeof this.db.markReorgHalted !== 'function') return
            try {
                await this.db.markReorgHalted(reason)
            } catch (e) {
                console.error('verifyReorg: failed to persist REORG_HALT marker:', e)
            }
        }

        // Fail-closed reorg-depth ceiling, parity with xchain-utxo-tracker's
        // UNDO_BLOCKS guard (XChainUtxoTracker.js verifyReorg). Soft-expired
        // dispensers are hard-purged once DISPENSER_EXPIRE_SAFE_DEPTH blocks
        // deep (purgeExpiredDispensers), and deleteBlockByIndex can only
        // resurrect a dispenser whose expired_block_index row still exists, so
        // rolling back past that window would silently and permanently lose
        // money-bearing dispenser state vs a from-scratch sync. A loud abort is
        // strictly safer than a silently corrupt DB: stop and require an
        // operator-driven resync. Called BEFORE each delete attempt (outside
        // the per-block retry try/catch, so the throw is not retried away).
        const assertWithinSafeDepth = async (lastBlockIndex) => {
            if (blocksDeleted.length >= DISPENSER_EXPIRE_SAFE_DEPTH){
                const msg = "verifyReorg: reorg depth exceeds the dispenser safe-depth window "
                    + "(DISPENSER_EXPIRE_SAFE_DEPTH=" + DISPENSER_EXPIRE_SAFE_DEPTH + "). Already rolled back "
                    + blocksDeleted.length + " blocks; soft-expired dispenser rows for block height "
                    + lastBlockIndex + " and below have already been hard-purged, so continuing would "
                    + "silently lose money-bearing dispenser state. Aborting. Recovery: perform a full "
                    + "resync from a known-good snapshot."
                console.error(msg)
                await haltReorg(msg)
                throw new Error(msg)
            }
        }

        while (thereAreDifferences){
            let lastBlockIndex
            let lastBlock
            try {
                lastBlockIndex = await this.db.getLastBlockIndex()
                lastBlock = await this.db.getBlockByIndex(lastBlockIndex)
            } catch (err){
                // A FAILED read is not a walk terminator. Both helpers retry
                // internally and then throw; letting that throw reach the `!lastBlock`
                // guard below (as the old error-null did) ended the rollback early and
                // returned "reorg reconciled" with orphan blocks still above the fork
                // point, and letting it escape verifyReorg would stop the parse loop
                // outright. Sleep and re-walk instead, exactly like the getBlockHash
                // catch further down: a DB outage is infrastructure, and this walk must
                // not finish until it has actually reconciled. Deliberately NOT a
                // REORG_HALT: that marker blocks every later reorg until an operator
                // clears it, which is the wrong response to a transient read fault.
                console.error('reorg: failed to read the last stored block; retrying the walk...', err)
                await this.sleep(3000)
                continue
            }

            // Stop the backward walk once the table is exhausted (getLastBlockIndex
            // returns -1 on an empty table, so getBlockByIndex(-1) yields null) or once
            // we have retreated past the configured start height. Without this guard a
            // deep reorg that invalidates every processed block would dereference a null
            // lastBlock below and crash before the REORG event is written, leaving the
            // decoder in an inconsistent restart state.
            if (!lastBlock || lastBlockIndex < this.startBlockIndex){
                thereAreDifferences = false
                break
            }

            // Blocks stored ABOVE the node's current tip are orphans the node no
            // longer has (deep reorg, node rollback, or restart onto a shorter chain).
            // getBlockHash(lastBlockIndex) would throw "Block height out of range",
            // and the transient-error catch below would retry it forever instead of
            // deleting it. Detect this with a deterministic height compare against
            // the tip passed in (no brittle RPC-error-string matching). nodeTip is
            // undefined for legacy callers (e.g. existing verifyReorg-only tests);
            // guard with != null so their behaviour is unchanged. The live parse loop
            // always passes the freshly-refreshed tip.
            if (nodeTip != null && lastBlockIndex > nodeTip){
                await assertWithinSafeDepth(lastBlockIndex)
                try {
                    // Pass the block hash so the delete and its REORG audit marker commit
                    // atomically; see deleteBlockByIndex for the durability rationale.
                    await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete above-tip block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10){ await haltReorg('verifyReorg: deleteBlockByIndex failed after 10 attempts (above-tip branch)'); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
                    await this.sleep(3000)
                }
                continue
            }

            let blockHashFromNode
            try {
                blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
            } catch (err){
                console.log("There was a problem trying to get a block hash from the node. Trying again...", err)
                // The node's tip may have regressed below lastBlockIndex mid-walk (node
                // restart onto a shorter chain, or a second reorg). Against the frozen
                // call-time nodeTip that makes getBlockHash(lastBlockIndex) throw "Block
                // height out of range" on every retry, wedging this walk forever.
                // Best-effort re-read the tip so the above-tip delete branch can
                // classify and delete this now-orphaned height on the next pass. If the
                // node is fully unreachable this refresh also fails and we keep the
                // existing sleep-and-retry outage tolerance (retry-forever) unchanged.
                try {
                    const info = await this.connector.getBlockchainInfo()
                    // Apply the block loop's chain-identity gate here too. This is
                    // the SECOND path a node tip reaches nodeTip, and nodeTip is exactly what
                    // the above-tip branch deletes valid local blocks against, so a foreign
                    // endpoint answering this refresh reopens the data-loss path the loop-top
                    // gate closes. On a proven mismatch keep the call-time tip and fall through
                    // to the existing sleep-and-retry: refusing to move the tip is the
                    // recoverable direction, deleting against another chain's height is not.
                    const reorgChainMismatch = info ? chainTierMismatch(this.consensusNetwork, info["chain"]) : null
                    if (reorgChainMismatch){
                        this.logError('reorg: ignoring a tip refresh from a foreign endpoint: ' + reorgChainMismatch)
                    } else if (info && typeof info.blocks === 'number') {
                        nodeTip = info.blocks
                    }
                } catch (refreshErr) { /* node unreachable; retry with the existing tip */ }
                await this.sleep(3000)
                continue
            }

            if (lastBlock["block_hash"] != blockHashFromNode){
                await assertWithinSafeDepth(lastBlockIndex)
                try {
                    // Pass the block hash so the delete and its REORG audit marker commit
                    // atomically; see deleteBlockByIndex for the durability rationale.
                    await this.db.deleteBlockByIndex(lastBlockIndex, lastBlock["block_hash"])

                    // Per-block retry budget: reset after each successful delete so the
                    // 10-attempt limit applies per block, not cumulatively across the whole
                    // reorg run. Otherwise a multi-block reorg with one transient failure per
                    // block could exhaust the budget and abort, leaving orphan blocks behind.
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlock["block_hash"]})
                } catch (err){
                    console.error(`reorg: failed to delete block ${lastBlockIndex} (${lastBlock.block_hash}): `, err)
                    if (++retryCount >= 10){ await haltReorg('verifyReorg: deleteBlockByIndex failed after 10 attempts (hash-compare branch)'); throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting') }
                    await this.sleep(3000); continue
                }
            } else {
                thereAreDifferences = false
            }
        }
        
        if (blocksDeleted.length > 0){
            // Each rolled-back block already persisted its own REORG marker atomically with its
            // delete (deleteBlockByIndex), so there is no separate end-of-run event to write.
            // This is only an ops summary of the completed reorg.
            this.log(`reorg: rolled back ${blocksDeleted.length} block(s): ` + JSON.stringify(blocksDeleted.map(b => b.block_index)))
        }

        return true
    }

    // Fetch the (AuxPoW-free) raw block hex for the height the main loop is on.
    // Normal path: getBlock, or getBlockWithoutAuxPow on an AuxPoW chain. Once the
    // AuxPoW header strip has failed AUXPOW_REASSEMBLE_AFTER consecutive times at
    // this height, fall back to getBlockReassembled: a block whose AuxPoW section
    // cannot be traversed would otherwise wedge this decoder here forever.
    //
    // This reads _auxPowParseErrorCount, NOT the all-errors _fetchErrorCount.
    // Escalation must fire on a CONTENT fault only: the reassembly path issues one
    // getrawtransaction per tx in the block, so escalating on transport faults
    // pointed a per-tx fan-out at the node whose unavailability caused the failures
    // in the first place.
    async fetchBlockHex(blockHash, blockHeight){
        if (!this.auxPow) {
            return this.connector.getBlock(blockHash)
        }
        if (this._auxPowParseErrorCount >= AUXPOW_REASSEMBLE_AFTER) {
            console.error('AuxPoW header strip at height ' + blockHeight + ' failed ' + this._auxPowParseErrorCount +
                ' consecutive times; falling back to per-tx block reassembly (malformed-AuxPoW recovery).')
            return this.connector.getBlockReassembled(blockHash)
        }
        return this.connector.getBlockWithoutAuxPow(blockHash)
    }

    // Read the node's own block-0 hash and compare it against the registry pin for this
    // coin/network. Returns a mismatch reason when the endpoint is PROVEN to be a
    // different chain, else null, which covers three different situations on purpose:
    // nothing pinned, nothing readable, and agreement. Never throws; the caller
    // decides what a proven mismatch costs (start() halts, the block loop refuses and
    // re-polls). This is the check `chain` cannot make: block 0 is the only constant that
    // separates BTC-mainnet from DOGE-mainnet, or Bitcoin testnet3 from testnet4.
    async verifyChainGenesis(){
        if (chainGenesisUnpinned(this.chainGenesisHash)) return null
        // Optional-call guard, matching the probeTxIndex call in start(): tests stub
        // this.connector with plain objects carrying only the methods under test.
        if (typeof this.connector.getBlockHash !== 'function') return null

        let reported = null
        try {
            reported = await this.connector.getBlockHash(0)
        } catch (e){
            // Unreadable is not proof of a foreign chain. chainGenesisCheckedAt stays put
            // so the next refresh retries at once rather than waiting out the throttle.
            this.log('Could not read the node block-0 hash to verify chain identity (' +
                ((e && e.message) ? e.message : e) + '); the pin stays unverified for now.')
            return null
        }
        if (typeof reported !== 'string' || reported === ''){
            this.log('Node returned no usable block-0 hash, so chain identity stays unverified.')
            return null
        }

        const mismatch = chainGenesisMismatch(this.chainGenesisHash, reported)
        // Only an actual comparison counts as a check; a mismatch deliberately does NOT
        // refresh the timestamp, so the refusal is re-proved on every retry.
        if (!mismatch) this.chainGenesisCheckedAt = Date.now()
        return mismatch
    }

    async start(){
        // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN
        // before touching the DB or processing any block, mirroring the indexer.
        // A null pin (mainnet, pre-arm) skips; a mismatch on an armed network
        // throws and halts startup, so a partial/stale deploy cannot parse
        // on-chain bytes with divergent network params (fail-closed, deliberately
        // not wrapped in try/catch).
        require('./coins').verifyConsensusPin(this.consensusNetwork)

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
        // are lower. The patch is applied in-process (src/applyBufferutilsPatch.js, required
        // by XChainBlockDecoder), so this can only fire if that module regresses or a stray
        // bitcoinjs-lib copy shadows the patched one; keep the backstop so any such
        // regression is loud at startup rather than a mid-operation fleet halt.
        if (this.xchainBlockDecoder && this.xchainBlockDecoder.coin === 'dogecoin' && !bigIntBufferutilsActive()){
            console.error('CRITICAL: bitcoinjs-lib bufferutils BigInt-safe 64-bit reader is NOT active on a ' +
                'Dogecoin decoder. A DOGE output > 2^53-1 sat (~90.07M DOGE) will throw during block decode ' +
                'and wedge this decoder permanently. src/applyBufferutilsPatch.js should have applied it ' +
                'in-process; investigate before running on mainnet.')
        }

        let dbStatus   = await this.db.createDatabase();
        let dbVerified = await this.db.verifyDatabase();
        if(!dbVerified){
            // Throw a real Error (not a bare string) so `err.message` is populated for
            // the api.js start() catch and the health() error field.
            util.throwError(new Error("Database " + this.dbName + " doesn't exist!"));
        } else {
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
            console.error('WARNING: node does not appear to have txindex=1 (getrawtransaction on a ' +
                'confirmed tx returned nothing). The malformed-AuxPoW block recovery path ' +
                '(getBlockReassembled) requires txindex; without it a malformed-AuxPoW ' +
                'block will wedge this decoder permanently. Restart the node with txindex=1.')
        } else if (txIndexOk === null) {
            console.log('txindex probe inconclusive (empty chain or probe RPC failed); continuing.')
        }

        console.log("Parsing...")
        
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

        main_parsing:
        while (true){
            // Liveness heartbeat, first statement in the loop so every path back to the
            // top refreshes it, `continue main_parsing` and the outage retry included.
            // Unlike lastAdvanceAt this records that the loop RAN, not that the chain
            // moved, which is what lets /live tell a caught-up decoder from a dead one.
            this.lastPollAt = Date.now()

            if (this.stopFlag){
                if (this.mempoolInterval != null){
                    console.log("Mempool updates stopped!")
                    clearInterval(this.mempoolInterval)
                    this.mempoolInterval = null
                }   
                break
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
                        console.log("Malformed getblockchaininfo response (missing or non-numeric 'blocks'/'verificationprogress'). Trying again...")
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
                            console.log("The node is not synced. Waiting for it to synchronize...")
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
                    console.log(e)
                    console.log("Error trying to get network info from the node. Trying again...", e)
                    await this.sleep(3000)
                    continue
                }
                
                if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
                    if (lastProcessedBlockIndex == this.startBlockIndex - 1){
                        // Benign: we have processed nothing yet and the node simply
                        // hasn't reached our configured start height. Wait, don't reorg.
                        console.log("Last block from the node ("+this.blockchainInfoLastBlock+") is still behind the starting block ("+this.startBlockIndex+")")
                        await this.sleep(5000)
                        continue
                    }

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
                    this.log("The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the node ("+this.blockchainInfoLastBlock+"). Reconciling orphan blocks...")
                    await this.db.endTransaction()
                    await this.verifyReorg(this.blockchainInfoLastBlock)
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
                    console.log("Mempool parsing started!")
                    this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
                    this.mempoolInterval = setInterval(() => {
                        this.updateMempool().catch(err => console.error('[updateMempool] unhandled error:', err))
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
                        console.error('Error during equal-height tip-hash detection reads, skipping:', e)
                    }
                    if (needsReconcile){
                        // Run the reconcile OUTSIDE the try so a fail-closed verifyReorg abort
                        // (durable REORG_HALT, safe-depth ceiling, or delete-failure) propagates
                        // out of start() and halts loudly, matching the two sibling verifyReorg
                        // call sites. Swallowing it here left a partially rolled-back DB under a
                        // stale in-memory cursor while this.synced stayed true.
                        this.log("Equal-height tip replacement detected at height " + lastProcessedBlockIndex + ". Reconciling...")
                        await this.db.endTransaction()
                        await this.verifyReorg(this.blockchainInfoLastBlock)
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
                        console.log("Mempool updates stopped!")
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
                    console.error('Error fetching block at height ' + nextBlockHeight + ' (attempt ' + this._fetchErrorCount + '):', e)
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
                    console.error(`Failed to decode block ${nextBlockHeight} (${nextBlockHash}), retrying:`, e)
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
                        console.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`, err)
                        await this.sleep(3000)
                        continue
                    }

                    // A null now means the row is genuinely absent (never a DB error). That
                    // still previously dereferenced straight into `previousBlock.block_hash`
                    // (TypeError), escaped start(), and permanently stopped the parse loop.
                    // Treat it as transient and retry this height, matching the block-fetch
                    // error path above.
                    if (!previousBlock){
                        console.error(`Could not load previous block ${nextBlockHeight - 1} for reorg check, retrying...`)
                        await this.sleep(3000)
                        continue
                    }

                    //previousBlockHash is not the same, it must be a reorg
                    if (previousBlockHash != previousBlock.block_hash){
                        await this.db.endTransaction()
                        console.log("A reorg has been detected at block " + nextBlockHeight + ". Cleaning blocks...")
                        const preReorgBlock = lastProcessedBlockIndex
                        await this.verifyReorg(this.blockchainInfoLastBlock)
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
                    console.log("Error trying to insert a Block to the database")
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
                    console.error(`deleteOpenDispensers failed at block ${nextBlockHeight}; block rolled back, retrying`)
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
                let openDispenserAddresses = await this.db.getAllOpenDispenserAddresses()
                if (openDispenserAddresses == null){
                    console.error(`Could not load open dispenser addresses for block ${nextBlockHeight}; retrying block`)
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
                            console.error(`RPC lookup failed in block ${nextBlockHeight} (tx position ${txIndex}), retrying block:`, e)
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
                            console.error(`parseTransaction failed in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${txParseRetryCount}/${TX_PARSE_MAX_RETRIES}), retrying block:`, e)
                            await this.db.endTransaction()
                            await resetAfterRollback()
                            continue main_parsing
                        }

                        // The transaction keeps throwing after whole-block retries: treat it
                        // as a poison transaction and quarantine it (skip + audit event) so
                        // one undecodable tx cannot wedge the pipeline at this height forever.
                        this.parseErrors++
                        console.error(`Quarantining undecodable tx in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries:`, e)
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
                        
                        if (//the transaction must have a data and a source or at least some possible dispenses
                            (
                                (parseResult["data"].length > 0) 
                                && 
                                (parseResult["source"] != null)
                            )
                            || dispenseOutputs.length > 0
                        ){
                            lastProcessedTxIndex = lastProcessedTxIndex + 1
                            validTransactionsCount = validTransactionsCount + 1

                            let decodedData = ""
                            if (parseResult["data"].length > 0) {
                                // A tx can carry BOTH an XChain OP_RETURN and money-bearing
                                // dispense/payment outputs. When the ACTION is oversized or names
                                // an unknown action, do NOT drop those outputs: treat the bad
                                // action as no-action (empty data, null raw_data) and fall through
                                // so the dispense/payment outputs are still recorded. Only skip the
                                // whole tx when there is nothing else to record. The no-output skip
                                // path still consumes a tx_index and continues: changing tx_index
                                // assignment for invalid-action txs would diverge from
                                // already-decoded history.
                                let hasOutputs = (dispenseOutputs.length > 0 || parseResult["paymentOutputs"].length > 0)
                                // Per-encoding ceiling (envelope spec §4): the envelope's
                                // payloadCeiling is ENVELOPE_MAX_PAYLOAD, legacy lanes
                                // report MAX_ACTION_DATA_LENGTH (the || covers results
                                // from stubs/older shapes without the field).
                                let payloadCeiling = parseResult["payloadCeiling"] || MAX_ACTION_DATA_LENGTH
                                if (parseResult["compiledDataLength"] > payloadCeiling) {
                                    this.parseErrors++
                                    console.error(`Skipping ACTION for tx ${nextTransactionHash}: ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${payloadCeiling})`)
                                    if (!hasOutputs) continue
                                    decodedData = ""
                                    parseResult["rawData"] = null
                                } else {
                                    // Canonicalize (tokenize + alias-expand) at the byte
                                    // level via the shared helper BEFORE string-decoding, so the
                                    // canonical name (always plain ASCII) rides through the same
                                    // strict/lenient decode as everything else and the DB ends up
                                    // alias-free regardless of which spelling was used on-chain.
                                    // canonical.buffer equals parseResult["data"] unchanged whenever
                                    // no rewrite is needed (including the unknown-name case), so this
                                    // decode is byte-for-byte identical to decoding the raw data.
                                    const canonical = canonicalizeActionPayload(parseResult["data"])
                                    try {
                                        decodedData = strictTextDecoder.decode(canonical.buffer)
                                    } catch (e) {
                                        this.parseErrors++
                                        decodedData = lenientTextDecoder.decode(canonical.buffer)
                                        console.error(`Tx ${nextTransactionHash}: ACTION data contains invalid UTF-8, decoded with replacement characters`, e)
                                    }

                                    if (!canonical.isKnown) {
                                        this.parseErrors++
                                        console.error(`Skipping ACTION for tx ${nextTransactionHash}: unknown ACTION name '${canonical.rawActionName.substring(0, 32)}'`)
                                        if (!hasOutputs) continue
                                        decodedData = ""
                                        parseResult["rawData"] = null
                                    }
                                }
                            }
                            
                            let insertResult = await this.db.insertTransaction({
                                index: lastProcessedTxIndex,
                                hash: nextTransactionHash,
                                block_index: nextBlockHeight,
                                source: parseResult["source"],
                                destination: parseResult["destination"],
                                amount: parseResult["amount"],
                                fee: 0,
                                data: decodedData,
                                raw_data: parseResult["rawData"] || null

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
                                    console.error(`Quarantining tx with deterministic INSERT failure in block ${nextBlockHeight} (tx position ${txIndex}, hash ${nextTransactionHash}) after ${TX_PARSE_MAX_RETRIES} block retries`)
                                } else {
                                    console.error(`insertTransaction deterministic failure in block ${nextBlockHeight} (tx position ${txIndex}, attempt ${insertQuarantineCount}/${TX_PARSE_MAX_RETRIES}), retrying block`)
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
                                        console.error(`insertTransactionOutput (dispense) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                        await resetAfterRollback()
                                        continue main_parsing
                                    }
                                    if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                        console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
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
                                let isCoinpay = decodedData.startsWith("COINPAY|")
                                let oracleFeeAddresses = await this.resolveOracleFeeAddresses(decodedData, parseResult["source"], block.timestamp, nextTransactionHash)
                                if (oracleFeeAddresses === false){
                                    // Deterministic DB fault while resolving a refill's oracle
                                    // address. Capturing nothing here would drop an output a
                                    // healthy node captures, so retry the block instead.
                                    console.error(`resolveOracleFeeAddresses failed at block ${nextBlockHeight}; block rolled back, retrying`)
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
                                            console.error(`insertTransactionOutput (payment) failed at block ${nextBlockHeight}; block rolled back, retrying`)
                                            await resetAfterRollback()
                                            continue main_parsing
                                        }
                                        if (insertResult === this.db.DUPLICATED_TRANSACTION){
                                            console.warn(`Duplicate transaction_output on insert (block_index=${nextBlockHeight}, tx_index=${lastProcessedTxIndex}, vout=${nextOutput.vout}); possible stale pre-reorg row not cleaned up by deleteBlockByIndex`)
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
                                if (decodedData.startsWith("DISPENSER")){
                                    let decodedDataSplit = decodedData.split("|")
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
                                    // xchain-indexer/src/dispenserDivergenceMetrics.js.
                                    let commandVersion = decodedDataSplit[1]
                                    let dispenserFormat = parseInt(commandVersion, 10)

                                    // Everything after GET_AMOUNT is optional on v0, so the
                                    // length gate ends the required run there rather than at
                                    // ORACLE_ADDRESS; see hasRequiredDispenserCreateFields for
                                    // the field map and for what the old >= 14 gate cost.
                                    if (dispenserFormat === 0 && this.hasRequiredDispenserCreateFields(decodedDataSplit)){
                                        let giveCoin = decodedDataSplit[2]
                                        let getCoin = decodedDataSplit[7]
                                        let getAddress = decodedDataSplit[10]

                                        // Treat a missing token OR an empty-string token as an
                                        // omitted EXPIRATION and substitute the same default the
                                        // indexer uses; only a present, non-empty value is validated.
                                        let expirationToken = decodedDataSplit[14]
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
                                        // Number.isInteger already excludes NaN and Infinity, so it
                                        // subsumes the isNaN test it replaces; the default expiration is
                                        // integral by construction (block timestamp + whole days).
                                        if (!Number.isInteger(expiration) || expiration < 0 || expiration > 4294967295) {
                                            this.parseErrors++
                                            console.error(`Skipping dispenser in tx ${nextTransactionHash}: invalid expiration value '${decodedDataSplit[14]}'`)
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
                                                console.error(`Skipping dispenser in tx ${nextTransactionHash} (txIndex ${lastProcessedTxIndex}): unresolved compacted GET_ADDRESS reference '${getAddress}' - the decoder cannot resolve ^<id> address references, so this delegated dispenser was NOT registered`)
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
                                                if (!(await this.db.insertDispenser({
                                                    txIndex: lastProcessedTxIndex,
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
                                                }))){
                                                    // insertDispenser's error path already rolled the block back.
                                                    await resetAfterRollback()
                                                    continue main_parsing
                                                }
                                                // Keep the in-memory open-dispenser set current so a
                                                // later transaction in this same block that pays this
                                                // freshly-opened dispenser is still recognized as a
                                                // dispense (mirrors the old per-output DB lookup).
                                                if (operatingAddress)
                                                    openDispenserAddresses.add(operatingAddress)
                                            }
                                        }
                                    } else if (dispenserFormat === 1){
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
                                        const editExpirationToken = decodedDataSplit[4]
                                        if (editSource && editSource.length > 0 &&
                                            editExpirationToken !== undefined && editExpirationToken !== ""){
                                            const newExpiration = Number(editExpirationToken)
                                            // Same integer contract as the create guard above: the edit
                                            // path writes through extendOpenDispenserExpirationBySource
                                            // into the same BIGINT UNSIGNED column, and the indexer
                                            // rejects a fractional edit EXPIRATION with the identical
                                            // isInteger test.
                                            if (Number.isInteger(newExpiration) && newExpiration >= 0 &&
                                                newExpiration <= 4294967295 && newExpiration > block.timestamp){
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
                            if ((parseResult["data"].length > 0) && (parseResult["source"] == null)){
                                console.error(`Skipping tx ${nextTransactionHash}: XChain data found but source address could not be resolved`)
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
                    console.error(`deleteOpenDispensers failed at end of block ${nextBlockHeight}; block rolled back, retrying`)
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
                        console.error(`Commit failed at block ${nextBlockHeight}; resetting to last committed block and retrying`)
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
                        console.log("Last block time ("+msPerBlockFormatted+"). ETA: "+msLeftFormatted)
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
    
    async updateMempool(){
        if (!this.mempoolBusy) {
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()

                // Dedup + single O(n log n) sort. The old per-txid binary-insert
                // (bs + splice) was O(n^2) in mempool size every poll cycle, a CPU
                // hazard under a mempool flood. ORDER CONTRACT: descending
                // lexicographic, i.e. exactly what the inverted bs comparator
                // `needle.localeCompare(element)` produced; db.js
                // deleteAndCompareTxsNotInList binary-searches this array with
                // that same comparator and silently breaks on any other order.
                rawMempool = Array.from(new Set(rawMempoolUnordered))
                    .sort((a, b) => b.localeCompare(a))

            } catch (error) {
                console.log(error)
                console.log("There were problems getting the mempool, trying again later.", error)
                this.mempoolBusy = false
                return
            }

            let validTransactionsCount = 0

            try {
            // All mempool DB work runs on this.mempoolDb, never this.db, so it stays outside the
            // block loop's open transaction. Deletes txs no longer in the node mempool and
            // drops txs already stored, leaving rawMempool holding only the new arrivals.
            let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool)

            let deletedTransactionsCount = deletedInfo.transactionsDeleted
            
            let i = 0
            while (i < rawMempool.length) {
                let nextRawMempoolChunk = rawMempool.slice(i, i + MEMPOOL_BATCH_SIZE)

                let nextTxsHex = []
                try {
                    nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)

                } catch (err) {
                    console.error(`mempool: failed to fetch raw transactions for batch starting at index ${i}: `, err)
                    console.error("Skipping batch and continuing...", err)
                    i = i + MEMPOOL_BATCH_SIZE
                    await this.sleep(1000)
                    continue
                }

                for (let nextTxHexIndex = 0; nextTxHexIndex < nextTxsHex.length; nextTxHexIndex++) {
                    let nextTxHex = nextTxsHex[nextTxHexIndex]

                    if (nextTxHex == null) {
                        continue
                    }

                    let nextTx
                    try {
                        nextTx = this.xchainBlockDecoder.transactionFromHex(nextTxHex)
                    } catch (err) {
                        this.parseErrors++
                        console.error(`Mempool: failed to parse tx hex (batch index ${nextTxHexIndex}): `, err)
                        continue
                    }

                    if (nextTx.ins.length === 0) {
                        // HogEx / MWEB-only transactions have no inputs and carry no XChain data
                        continue
                    }

                    let nextTransactionHash = nextTx.getId()

                    let parseResult = null
                    try {
                        // Pass mempoolDb so the pubkey-capture writes inside parseTransaction also
                        // stay off the block transaction. The envelope
                        // recognition height is gated on this decoder's own
                        // next block (lastProcessedBlockIndex + 1): a pending
                        // tx confirms at the earliest into that block, and the
                        // mempool view is per-instance and non-consensus, so a
                        // briefly-lagging instance near the flag boundary is
                        // acceptable where a forked BLOCK parse would not be.
                        parseResult = await this.parseTransaction(nextTx, undefined, this.mempoolDb, this.lastProcessedBlockIndex + 1)
                    } catch (err) {
                        // The surrounding try has no catch (only a finally for the busy
                        // flag), so a single undecodable mempool tx would abort the whole
                        // mempool update cycle. Skip just the tx; it is retried on the
                        // next cycle anyway since it never reaches the database.
                        this.parseErrors++
                        console.error(`Mempool: parseTransaction failed for tx ${nextTransactionHash}, skipping:`, err)
                        continue
                    }

                    if (parseResult == null) {
                        continue
                    }

                    let mempoolData = parseResult["data"]
                    if (mempoolData != null && mempoolData.length > 0) {
                        // Mirror the confirmed-block path: apply the same two guards so a
                        // pending tx never shows one thing and then silently vanishes on confirm.
                        // A tx can carry BOTH an invalid/oversized ACTION and money-bearing
                        // dispense/payment outputs; when it does, do NOT drop the whole tx.
                        // Treat the bad action as no-action (null data) and still record the
                        // pending tx, exactly as the block path does at confirmation. Only skip
                        // the whole tx when there is nothing else to record.
                        let hasOutputs = ((parseResult["dispenseOutputs"]?.length > 0) || (parseResult["paymentOutputs"]?.length > 0))

                        // Guard 1: oversized payloads, against the per-encoding
                        // ceiling the parse reported (envelope spec §4: enforced
                        // identically in the block and mempool paths).
                        let mempoolPayloadCeiling = parseResult["payloadCeiling"] || MAX_ACTION_DATA_LENGTH
                        if (parseResult["compiledDataLength"] > mempoolPayloadCeiling) {
                            this.parseErrors++
                            console.error(`Mempool: tx ${nextTransactionHash}: ACTION data exceeds maximum length (${parseResult["compiledDataLength"]} > ${mempoolPayloadCeiling})`)
                            if (!hasOutputs) continue
                            // Empty buffer (not null) so this decodes to the SAME ''
                            // sentinel the confirmed-block path stores for a rejected
                            // ACTION on a money-bearing tx; a null would persist as SQL
                            // NULL and break pending/confirmed content-correlation.
                            mempoolData = new Uint8Array(0)
                            // Drop the raw payload with the action it belonged to, exactly as
                            // the confirmed-block path does; a rejected ACTION must not leave
                            // a stale raw_data on the pending row.
                            parseResult["rawData"] = null
                        } else {
                            // Guard 2: unknown ACTION names (expand aliases first so an
                            // alias-named tx doesn't show as pending and then silently vanish).
                            // Shared with the confirmed-block path via
                            // canonicalizeActionPayload so the two gates cannot drift again.
                            const canonical = canonicalizeActionPayload(mempoolData)
                            if (!canonical.isKnown) {
                                this.parseErrors++
                                console.error(`Mempool: tx ${nextTransactionHash}: unknown ACTION name '${canonical.rawActionName.substring(0, 32)}'`)
                                if (!hasOutputs) continue
                                // Empty buffer (not null): decodes to '' matching the
                                // confirmed-block path, not SQL NULL. See guard 1 above.
                                mempoolData = new Uint8Array(0)
                                // Same parity as guard 1: no action stored means no raw payload.
                                parseResult["rawData"] = null
                            } else {
                                mempoolData = canonical.buffer
                            }
                        }
                    }

                    // Store the canonical payload as the SAME UTF-8 string the
                    // confirmed-block path writes (strictTextDecoder over
                    // canonical.buffer, lenient fallback on invalid UTF-8), not
                    // hex. Otherwise mempool_transactions.data ("434f..." hex)
                    // and transactions.data ("COINPAY|..." text) hold the same
                    // on-wire ACTION in two encodings, so any content-correlation
                    // between a pending row and its confirmed twin silently
                    // mismatches (uuid:26220713). mempoolData here is
                    // canonical.buffer (a Uint8Array) for a known ACTION.
                    let mempoolDataString = null
                    if (mempoolData != null) {
                        try {
                            mempoolDataString = strictTextDecoder.decode(mempoolData)
                        } catch (e) {
                            this.parseErrors++
                            mempoolDataString = lenientTextDecoder.decode(mempoolData)
                            console.error(`Mempool: tx ${nextTransactionHash}: ACTION data contains invalid UTF-8, decoded with replacement characters`, e)
                        }
                    }

                    if (!(await this.mempoolDb.insertMempoolTransaction({
                        hash: nextTransactionHash,
                        source: parseResult["source"],
                        destination: parseResult["destination"],
                        amount: parseResult["amount"],
                        fee: 0,
                        data: mempoolDataString,
                        raw_data: parseResult["rawData"] || null

                    }))) {
                        await this.sleep(3000)
                        continue
                    } else {
                        if ((parseResult["data"] != null) && (parseResult["data"].length > 0)) {
                            validTransactionsCount = validTransactionsCount + 1
                        }
                    }
                }

                i = i + MEMPOOL_BATCH_SIZE
            }

            let mempoolEndTime = Date.now()
            let timeString = this.millisecondsToTimeString(mempoolEndTime - mempoolStartTime)

            console.log("Mempool updated!"
                + " Transactions (" + rawMempool.length + " in mempool, " + validTransactionsCount + " valid, " + deletedTransactionsCount + " less) [" + timeString + "]")
            } finally {
                // Always clear the busy flag, even if a DB or parse operation above threw.
                // Otherwise a single transient failure would leave mempool tracking frozen
                // for the rest of the process lifetime.
                this.mempoolBusy = false
            }
        } else {
            console.log("Mempool is still busy")
        }
    }
    
}

module.exports = XChainDecoder
// Exported for the cross-service regression suite, which asserts this equals the
// encoder's compiled-push guard and the canonical protocol constant.
module.exports.MAX_ACTION_DATA_LENGTH = MAX_ACTION_DATA_LENGTH
// Exported for the compiled-push-size conformance test, which pins this formula
// against bitcoin.script.compile and the encoder's identical helper.
module.exports.compiledPushSize = compiledPushSize
// Exported so the same conformance test can pin the OP_PUSHDATA2 overhead by NAME
// against the canonical protocol constant.
module.exports.OP_RETURN_PUSH_OVERHEAD = OP_RETURN_PUSH_OVERHEAD
// Exported so a regression test can pin it >= the deepest per-chain reorg window.
module.exports.DISPENSER_EXPIRE_SAFE_DEPTH = DISPENSER_EXPIRE_SAFE_DEPTH
// Exported so the funding-fee-output collision regression test can assert attributed
// funding outputs are stored at vout + FUNDING_VOUT_BASE (never colliding with real vouts).
module.exports.FUNDING_VOUT_BASE = FUNDING_VOUT_BASE
// Exported for the DOGE large-output bufferutils-patch self-check regression test.
module.exports.bigIntBufferutilsActive = bigIntBufferutilsActive
// Exported for the malformed-AuxPoW fallback regression test.
module.exports.AUXPOW_REASSEMBLE_AFTER = AUXPOW_REASSEMBLE_AFTER
// Exported for the alias-canonicalization tests and so the
// ActionManifestConformance test can pin VALID_ACTION_NAMES/ACTION_ALIASES.
module.exports.canonicalizeActionPayload = canonicalizeActionPayload
module.exports.VALID_ACTION_NAMES = VALID_ACTION_NAMES
module.exports.ACTION_ALIASES = ACTION_ALIASES
// Taproot envelope: the per-encoding payload ceiling and the per-chain
// recognition-height map, exported for the cross-service conformance suites
// (encoder/docs copies must stay byte-equal).
module.exports.ENVELOPE_MAX_PAYLOAD = ENVELOPE_MAX_PAYLOAD
module.exports.ENVELOPE_RECOGNITION_ACTIVATION = ENVELOPE_RECOGNITION_ACTIVATION