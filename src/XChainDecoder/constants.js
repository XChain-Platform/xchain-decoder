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

const config = require('../config')
const { getLogger } = require('../observability')

const logger = getLogger();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true })
const lenientTextDecoder = new TextDecoder('utf-8')

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so reported lag stays accurate
const MEMPOOL_INTERVAL = 60000 //60 seconds between mempool checks
// How often a health surface may re-probe the durable REORG_HALT marker. The marker
// changes at most once in a decoder's life, so a slow TTL is ample; the point of the
// cache is that an unauthenticated health endpoint must not turn into one DB query
// per request.
const REORG_HALT_PROBE_INTERVAL_MS = 60000
// How long the parse loop sleeps between passes while it is PARKED on a REORG_HALT.
// Deliberately NOT the probe cadence above: the marker is re-read on that TTL (the
// parked pass calls checkReorgHalt un-forced, so every TTL expiry is a real re-read and
// the passes in between cost nothing), while this tick is what returns the loop to its
// stopFlag check. At a minute a SIGTERM arriving just after a pass would spend most of
// the shutdown budget waiting for a sleep to end.
const REORG_HALT_PARK_TICK_MS = 1000
// How long the block loop may make no forward progress, while the node tip is fresh and
// visibly ahead, before isStalled() calls the decoder wedged. The loop never skips a
// block on a fetch/parse fault (skipping would corrupt the index), so a deterministic
// fault at one height retries forever with the process alive and the DB reachable; this
// window is what makes that visible to a liveness probe. Deliberately generous: it must
// clear the slowest legitimate single-block commit and a deep reorg rollback on the
// slowest host, because the consumer of the signal restarts the container. Override per
// host with DECODER_STALL_ALERT_MS.
const STALL_ALERT_MS = Number(config.DECODER_STALL_ALERT_MS) || 900000
// How long the parse loop may go without completing an ITERATION before /live calls the
// decoder dead. Distinct from STALL_ALERT_MS, which measures chain PROGRESS: a caught-up
// decoder makes no progress for hours and is perfectly healthy, so only iteration count
// can tell "idle because there is nothing to do" from "the loop is gone". Deliberately
// twice the stall window, because the consumer restarts the container: every normal path
// through the loop, including the outage path (catch -> sleep(3000) -> continue) and the
// slowest single-block commit, returns to the loop top far inside it. Override per host
// with DECODER_POLL_SILENT_MS.
const POLL_SILENT_MS = Number(config.DECODER_POLL_SILENT_MS) || (2 * STALL_ALERT_MS)
// Consecutive failed fetch attempts at ONE height (3s apart) that count as wedged on
// their own. _fetchErrorCount resets to 0 on any successful fetch and on a height
// change, so unlike the elapsed-time window it cannot be tripped by slow-but-working
// block processing. 20 attempts is ~1 minute of retrying the same height.
const STALL_FETCH_ATTEMPTS = Number(config.DECODER_STALL_FETCH_ATTEMPTS) || 20
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
// money-bearing dispenser on the reorged node. Standard networks use 126 and
// Litecoin testnet uses 5006. Invariant: SAFE_DEPTH >= matching undo window +
// margin. The +6 margin means a small undo-window re-tune
// cannot land exactly at the purge threshold; dispenserSafeDepth.test.js
// enforces the invariant with a conformance read of undo-blocks.js.
// Purging deeper is the conservative direction (rows are merely retained longer
// before hard-purge; expiry semantics and action evaluation are unchanged).
const DISPENSER_EXPIRE_SAFE_DEPTH = 126 // 120 (deepest standard window) + 6 margin
const LTC_TESTNET_DISPENSER_EXPIRE_SAFE_DEPTH = 5006

function resolveDispenserExpireSafeDepth(coin, network){
    return String(coin).toUpperCase() === 'LTC' && String(network).toLowerCase() === 'testnet'
        ? LTC_TESTNET_DISPENSER_EXPIRE_SAFE_DEPTH
        : DISPENSER_EXPIRE_SAFE_DEPTH
}

// There is deliberately no DISPENSER_CLOSE_DELAY twin of the indexer's here: the decoder
// does not mirror dispenser cancels, so it never needs to close a row at the height the
// indexer's DISPENSER_CLOSE fires. Reintroducing a closing mirror would need that pinned
// cross-repo value back, and would first need the decoder to resolve cancel targets
// exactly rather than by SOURCE (see db.js above extendOpenDispenserExpirationBySource).
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

// BIP342 tapscript leaf version; also the control block's first byte masked of
// its output-key parity bit.
const TAPROOT_LEAF_VERSION = 0xc0
// BIP341 annex marker: when a witness stack of >= 2 items ends in an item
// whose first byte is 0x50, that item is an annex and sits outside the
// script-path elements. An annex-bearing reveal is never recognized (§3.8).
const TAPROOT_ANNEX_MARKER = 0x50

const VALID_ACTION_NAMES = new Set([
    'ADDRESS', 'AIRDROP', 'ANCHOR', 'ATTEST',
    'BATCH', 'BET', 'BROADCAST', 'CALLBACK', 'COINPAY', 'COLLECT',
    'DELEGATE', 'DEPLOY', 'DEPOSIT', 'DESTROY', 'DISPENSER',
    'DIVIDEND', 'EXECUTE', 'FILE', 'ISSUE', 'LINK', 'LIST', 'MESSAGE', 'MINT',
    'NODEPROOF', 'ORDER', 'PRICE', 'ROLLCALL', 'SEND', 'SLASH', 'SLEEP', 'STAKE',
    'SWAP',
    'SWEEP', 'UNSTAKE', 'VOTE', 'WITHDRAW',
    // Bridge lock/burn. Only the user-broadcast versions (0, 1, 3, 4) ever arrive as a
    // wire tx; the settle legs (2, 5) are mirror-injected by the indexer and are refused
    // outright when broadcast, so they need no decoder name of their own.
    'XBRIDGE'
])

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
module.exports = {
    logger,
    strictTextDecoder,
    lenientTextDecoder,
    CHECK_BLOCK_DELAY_MS,
    BLOCKCHAIN_INFO_REFRESH_MS,
    MEMPOOL_INTERVAL,
    REORG_HALT_PROBE_INTERVAL_MS,
    REORG_HALT_PARK_TICK_MS,
    STALL_ALERT_MS,
    POLL_SILENT_MS,
    STALL_FETCH_ATTEMPTS,
    MEMPOOL_BATCH_SIZE,
    MAGIC_WORD,
    MAGIC_WORD_BUFFER,
    P2SH_BUFFER,
    P2WSH_BUFFER,
    FUNDING_VOUT_BASE,
    SYNCED_THRESHOLD,
    DISPENSER_EXPIRE_SAFE_DEPTH,
    resolveDispenserExpireSafeDepth,
    MIN_VERIFICATION_PROGRESS_TO_PARSE,
    TAPROOT_LEAF_VERSION,
    TAPROOT_ANNEX_MARKER,
    VALID_ACTION_NAMES,
    DB_TRANSACTION_BLOCKS_QUANTITY,
    LOG_BLOCK_INTERVAL,
    TX_PARSE_MAX_RETRIES,
    AUXPOW_REASSEMBLE_AFTER,
}
