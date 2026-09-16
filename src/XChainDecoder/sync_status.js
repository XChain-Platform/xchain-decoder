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

const { logger, BLOCKCHAIN_INFO_REFRESH_MS, STALL_ALERT_MS, STALL_FETCH_ATTEMPTS, POLL_SILENT_MS } = require('./constants.js')

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Default EXPIRATION for a v0 dispenser open that omits the field: block time
    // plus the configured default window in seconds. Keep in sync with
    // xchain-indexer/src/utility.js getDefaultExpiration so both views agree on
    // whether an EXPIRATION-less dispenser is open.
    getDefaultExpiration(blockTime){
        return Number(blockTime) + (this.expirationFeeDefaultDays * 86400)
    },

    markTime(timeName){
        this.debugTime[timeName] = Date.now()
    },

    logTime(timeName){
        let endTime = Date.now()
        let msTime = (endTime - this.debugTime[timeName])

        logger.info("Time('"+timeName+"'): "+(msTime)+"ms")
    },

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
    },

    // True when the cached node tip is frozen: we have polled at least once and the
    // last successful getBlockchainInfo() was more than 2x the refresh interval ago,
    // i.e. at least two consecutive polls failed. A single definition shared by
    // isSynced(), isStalled() and getSyncStatus() prevents threshold drift.
    //
    // Never-polled (blockchainInfoLastRefreshAt 0) is NOT stale: a booting decoder
    // has no frozen tip, it has no tip.
    isNodeHeightStale(){
        return this.blockchainInfoLastRefreshAt > 0
            && (Date.now() - this.blockchainInfoLastRefreshAt) > 2 * BLOCKCHAIN_INFO_REFRESH_MS
    },

    // Age (seconds) of the last successful tip poll, or null before the first one.
    // Exported as a Prometheus gauge so an alert can fire on tip age directly rather
    // than on the boolean's 2x-interval threshold.
    nodeTipAgeSeconds(){
        if (!(this.blockchainInfoLastRefreshAt > 0)) return null
        return (Date.now() - this.blockchainInfoLastRefreshAt) / 1000
    },

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
    },

    // Wire the observability log shim in after construction (api.js owns the handle).
    setObservabilityLogger(logger){
        this.obsLogger = logger || null
    },

    isSynced(){
        // A frozen tip during a node outage must not read as synced: the chain may
        // have advanced far past the last cached tip, so synced:true would be false-healthy.
        if (this.isNodeHeightStale()) return false
        return this.synced
    },

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
        // A process that has never advanced has nothing to be behind on yet.
        if (!this.lastAdvanceAt) return false
        // Parked on a REORG_HALT: not advancing is the POINT, and it is the same
        // "restarting fixes nothing" class as the stale-tip gate below. The decoder
        // healthcheck carries autoheal, so reporting stalled here would recycle the
        // container every couple of minutes for a marker only an operator clear can
        // release, which is the crash loop parking exists to end. The halt itself is
        // reported on its own field by every health surface.
        if (this.reorgHaltParked) return false
        // Neither height is known, so there is no gap to measure.
        if (this.blockchainInfoLastBlock < 0 || this.lastProcessedBlockIndex < 0) return false
        // The chain is not waiting on us: a decoder at or one block behind the tip
        // is caught up, and a caught-up decoder advances only when a block arrives.
        if ((this.blockchainInfoLastBlock - this.lastProcessedBlockIndex) <= 1) return false
        // The tip reading is stale, so the gap above is measured against a frozen
        // number. During a node outage both sides stop, and a restart fixes nothing.
        if (this.isNodeHeightStale()) return false
        // Repeated failures fetching the SAME block is the fast verdict: the
        // counter resets on any success, so reaching the threshold means stuck.
        if (this._fetchErrorCount >= STALL_FETCH_ATTEMPTS) return true
        return (Date.now() - this.lastAdvanceAt) > STALL_ALERT_MS
    },

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
        // The loop has not completed a single pass yet, which a long initial sync
        // does legitimately, so there is no silence to report.
        if (!this.lastPollAt) return false
        return (Date.now() - this.lastPollAt) > POLL_SILENT_MS
    },

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
            lag: this.blockchainInfoLastBlock - this.lastProcessedBlockIndex,
            // Reorg churn, additive: an operator polling /status sees how often this
            // decoder has rolled back and how deep the last one went, without joining
            // against the indexer. Absent from the nothing-processed-yet shape above,
            // which deliberately reports unknowns rather than zeros.
            reorg_count: this.reorgCount,
            last_reorg_depth: this.lastReorgDepth
        }
        if (nodeHeightStale) status.node_height_stale = true
        return status
    },

    stop(){
        this.stopFlag = true
    }
}
