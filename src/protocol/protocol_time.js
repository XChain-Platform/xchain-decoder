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
 *
 * XChain Decoder - protocol time
 *
 * Vendored from xchain-indexer/src/consensus/protocol_time.js (operator ruling
 * 2026-08-25): every time-keyed decoder gate currently keys on a block's RAW
 * timestamp, which testnet4's continuous minimum-difficulty spacing can stamp
 * hours ahead of wall clock. The fix is Bitcoin's own BIP113 remedy: read the
 * MEDIAN of the previous MEDIAN_TIME_SPAN block timestamps instead, which is
 * derived from the chain (every node computes it identically), monotonically
 * non-decreasing, and never runs ahead of a single miner's clock. Switched per
 * NETWORK, not per height (no flag day - testnet was re-genesised 2026-08-24
 * and carries no history that depends on the old reads); mainnet is left alone
 * because its stamps track wall clock and nothing there is broken.
 *
 * createBlockTimeContext is decoder's own seam, not part of the vendored
 * surface: block_ingest.js calls it once per block and mutates the decoded
 * block's `timestamp` to the resolved protocolBlockTime before any downstream
 * site reads it, so every existing consumer of `block.timestamp` (dispenser
 * registration, batch/oracle capture, cancel-grace, expiry-realign) picks up
 * protocol time for free while `blocks.block_time` still stores the raw stamp.
 *
 ********************************************************************/

'use strict';

// How many preceding blocks the median is taken over. Bitcoin's value; changing
// it moves the instant every block reads at, so it is a consensus constant.
const MEDIAN_TIME_SPAN = 11

// Networks whose protocol time is resolved from MTP rather than the raw stamp.
// Mirrors xchain-indexer/src/consensus/protocol_time.js exactly: testnet is
// switched (it is the chain that stamps into the future), mainnet and regtest
// read the raw stamp unchanged.
const PROTOCOL_TIME_MTP_NETWORKS = {
    mainnet: false,
    testnet: true,
    regtest: false,
}

// Whether `network` resolves protocol time from MTP. An unknown network reads
// false, so an unrecognized caller keeps the raw-stamp behaviour rather than
// silently switching which instant consensus reads at.
function isProtocolTimeMtpActive(network){
    return PROTOCOL_TIME_MTP_NETWORKS[network] === true
}

// The median of the previous MEDIAN_TIME_SPAN block timestamps, Bitcoin-style.
//
// `previousBlockTimes` is the timestamps of the blocks BELOW the one being
// resolved, in any order; only the newest MEDIAN_TIME_SPAN of them are used, so
// callers may hand over a longer window. Genesis and the blocks just above it
// have fewer than a full span available: Bitcoin medians whatever exists rather
// than failing, and so does this.
//
// Returns null when nothing usable is supplied, so callers fail closed onto the
// raw stamp rather than medianing to NaN.
function medianTimePast(previousBlockTimes){
    if (!Array.isArray(previousBlockTimes)) return null
    const times = previousBlockTimes
        .map(Number)
        .filter((time) => Number.isFinite(time) && time > 0)

    if (times.length === 0) return null
    // Newest MEDIAN_TIME_SPAN first, then median by value. Sorting by value
    // alone would median the wrong set once a caller passes a longer window.
    times.sort((a, b) => b - a)
    const span = times.slice(0, MEDIAN_TIME_SPAN).sort((a, b) => a - b)
    return span[Math.floor(span.length / 2)]
}

// The instant a block's time-keyed decoder gates should read.
//
// On an unswitched network, or whenever MTP cannot be computed (genesis, a
// missing window, an unreadable stamp), this is the block's raw timestamp.
// Otherwise it is MTP, EXCEPT that MTP is never allowed to exceed the raw
// stamp: a chain that jumps backwards could otherwise invert them, which would
// reintroduce exactly the future-dated read this exists to remove.
//
// Preserves the caller's `false`/null/undefined sentinel for an unresolvable
// rawBlockTime rather than coercing it.
function protocolTime(network, rawBlockTime, previousBlockTimes){
    if (rawBlockTime === false || rawBlockTime === null || rawBlockTime === undefined)
        return rawBlockTime

    const raw = Number(rawBlockTime)
    if (!Number.isFinite(raw)) return rawBlockTime
    if (!isProtocolTimeMtpActive(network)) return raw

    const mtp = medianTimePast(previousBlockTimes)
    return mtp === null ? raw : Math.min(mtp, raw)
}

// Resolves both clocks for one block: the raw stamp `blocks.block_time` must
// keep storing, and the protocol-adjusted instant every time-keyed gate below
// block_ingest.js should read instead. Frozen so a downstream site cannot
// silently rewrite one half out from under the other.
function createBlockTimeContext(network, rawBlockTime, previousBlockTimes){
    const raw = Number(rawBlockTime)
    return Object.freeze({
        rawBlockTime: raw,
        protocolBlockTime: protocolTime(network, raw, previousBlockTimes),
    })
}

module.exports = {
    MEDIAN_TIME_SPAN,
    PROTOCOL_TIME_MTP_NETWORKS,
    isProtocolTimeMtpActive,
    medianTimePast,
    protocolTime,
    createBlockTimeContext,
}
