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

const { chainGenesisMismatch, chainGenesisUnpinned } = require('../protocol/chain_identity')
const { logger, REORG_HALT_PROBE_INTERVAL_MS, AUXPOW_REASSEMBLE_AFTER, TIP_SETTLE_DELAY_MS, TIP_SETTLE_MAX_READS } = require('./constants.js')
const { RESET_RECOVERY, readRolledBackAboveTip } = require('./reorg_halt.js')

// Read the durable REORG_HALT marker through whichever probe the db exposes, or
// null when it exposes none (or there is no db) and the cached state must stand.
// A probe that exists but answers with nothing throws instead, so checkReorgHalt
// logs the fault and keeps the cached state: an empty answer is never a clear.
async function readReorgHaltMarker(db){
    if (!db) return null
    if (typeof db.getReorgHaltMarker === 'function'){
        const marker = await db.getReorgHaltMarker()
        if (!marker || typeof marker !== 'object') throw new Error('getReorgHaltMarker returned no marker')
        return marker
    }
    if (typeof db.isReorgHalted === 'function'){
        // Older/minimal db shapes (and the mocks in the verifyReorg suites)
        // expose only the boolean probe.
        const halted = await db.isReorgHalted()
        if (halted == null) throw new Error('isReorgHalted returned no answer')
        return { halted: !!(halted && halted.halted !== undefined ? halted.halted : halted), at: null, reason: null }
    }
    return null
}

// How often a park taken on an unreadable marker re-reads it. Shorter than the
// halt park's TTL, because a boot-time read fault is usually transient and this park
// ends as soon as the marker reads.
const UNREAD_PARK_REPROBE_MS = 5000

// The park height as a log line names it: the stored tip, said plainly when no block
// is stored yet (an emptied or never-filled table), or unknown when no tip was read.
function describeParkHeight(height, startBlockIndex){
    if (typeof height !== 'number' || !Number.isFinite(height)) return 'unknown'
    if (Number.isInteger(startBlockIndex) && height < startBlockIndex){
        return height + ' (no block is stored, so parsing would resume at the start height ' + startBlockIndex + ')'
    }
    return String(height)
}

// Say a halt-state transition the probe just read, once per transition. A first
// sighting of a halt by any probe (a health route's included) also has the parse
// loop re-run the boot park check before its next block.
function noteReorgHaltTransition(decoder, wasHalted){
    if (decoder.reorgHalted && !wasHalted){
        decoder.reorgHaltParkCheckDue = true
        logger.error('XChainDecoder: LATENT REORG_HALT MARKER PRESENT - this decoder carries a durable ' +
            'REORG_HALT row from an aborted rollback, and health, /status and /live report reorg_halted=true ' +
            'while it stands. A halt that left rolled-back blocks above the stored tip parks the parse loop ' +
            'at boot; any other halt parses forward only while the node\'s chain extends the stored tip, and ' +
            'the next reorg parks the parse loop (the process stays up and parses nothing). This database is ' +
            'NOT a valid bootstrap source. REQUIRED OPERATOR ACTION: ' + RESET_RECOVERY + ', or, once no ' +
            'rolled-back block remains above the tip and the database is verified intact, ' +
            '`xchain-node clear-reorg-halt <chain> <network> --reason "..."`.' +
            (decoder.reorgHaltReason ? ' Marker detail: ' + decoder.reorgHaltReason : ''))
    } else if (!decoder.reorgHalted && wasHalted){
        logger.warn('XChainDecoder: REORG_HALT marker is gone; halt cleared.')
    }
}

module.exports = {
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
                const marker = await readReorgHaltMarker(this.db)
                if (marker === null) return this.getReorgHaltStatus()
                // A real read: the boot park and its release (parkOnRolledBackHalt,
                // resumeFromReorgHaltPark) fail closed while this is true.
                this.reorgHaltProbeFailed = false
                // Keep a halt this process raised but could not record. A failed marker
                // write leaves no row, so a no-halt read here is that absence, not a
                // clear; adopting it would publish reorg_halted=false until restart.
                if (this.reorgHalted && this.reorgHaltMarkerPersisted === false && !marker.halted){
                    this.reorgHaltCheckedAt = now
                    return this.getReorgHaltStatus()
                }
                const wasHalted = this.reorgHalted
                this.reorgHalted        = !!(marker && marker.halted)
                this.reorgHaltReason    = (marker && marker.reason) || null
                this.reorgHaltAt        = (marker && marker.at) || null
                // An operator clear (db.clearReorgHalt) supersedes the halt; surface
                // when and why so a cleared database still tells its history.
                this.reorgHaltClearedAt     = (marker && marker.cleared_at) || null
                this.reorgHaltClearedReason = (marker && marker.cleared_reason) || null
                this.reorgHaltCheckedAt = now
                // A marker this probe just READ is durable by observation, whatever the
                // write that produced it reported. Raised here and never cleared here:
                // finding no row is exactly the state an unconfirmed in-process halt
                // leaves behind, so clearing on absence would erase the one signal.
                if (this.reorgHalted) this.reorgHaltMarkerPersisted = true
                noteReorgHaltTransition(this, wasHalted)
                return this.getReorgHaltStatus()
            } catch (e){
                this.reorgHaltProbeFailed = true
                logger.warn('XChainDecoder: REORG_HALT probe failed (non-fatal), keeping last known state (' +
                    this.reorgHalted + '): ' + (e && e.message))
                return this.getReorgHaltStatus()
            } finally {
                this._reorgHaltProbeInFlight = null
            }
        })()
        return this._reorgHaltProbeInFlight
    },

    // Cached view of the halt marker for health surfaces. `checked_at` is null until
    // the first successful probe, so a consumer can tell "not halted" apart from
    // "never looked". `marker_persisted` splits the halt from its evidence: null when
    // no halt has been raised or seen, false when this process halted and could not
    // confirm the durable row, true when a row is known readable.
    getReorgHaltStatus(){
        return {
            halted:     !!this.reorgHalted,
            reason:     this.reorgHaltReason || null,
            at:         this.reorgHaltAt || null,
            // Whether the PARSE LOOP has stopped on this halt, as distinct from
            // carrying one. A latent marker leaves the decoder parsing forward and
            // healthy; parked means nothing is being parsed until the marker clears,
            // and only this field separates the two on an operator's surfaces.
            parked:     !!this.reorgHaltParked,
            parked_at:  this.reorgHaltParkedAt || null,
            parked_height: (this.reorgHaltParkedHeight === null || this.reorgHaltParkedHeight === undefined)
                ? null : this.reorgHaltParkedHeight,
            cleared_at:     this.reorgHaltClearedAt || null,
            cleared_reason: this.reorgHaltClearedReason || null,
            checked_at: this.reorgHaltCheckedAt || null,
            marker_persisted: (this.reorgHaltMarkerPersisted === null || this.reorgHaltMarkerPersisted === undefined)
                ? null : !!this.reorgHaltMarkerPersisted
        }
    },

    // Stop parsing on a REORG_HALT refusal and keep this process up.
    //
    // Only a refusal belongs here, never an ordinary fault: the durable marker blocks
    // every rollback until an operator clears it, so a restart lands back in the same
    // refusal a few seconds later, forever. Idempotent, because the loop can reach a
    // refusal from three call sites and only the first one is news.
    //
    // resetOnly marks a halt that rolled back blocks above the stored tip: a parked
    // decoder never re-parses them, so clear-reorg-halt's re-parse check can never pass
    // and the line names the reset instead of promising a resume.
    //
    // unread marks a park taken because the marker itself could not be read: it says
    // so, and resumeFromReorgHaltPark ends it only on a real read.
    parkOnReorgHalt(reason, blockHeight, { resetOnly = false, unread = false } = {}){
        if (this.reorgHaltParked) return
        this.reorgHaltParked = true
        this.reorgHaltParkedAt = new Date().toISOString()
        this.reorgHaltParkedHeight = (typeof blockHeight === 'number' && blockHeight >= 0) ? blockHeight : null
        this.reorgHaltParkUnread = unread
        const height = describeParkHeight(blockHeight, this.startBlockIndex)
        if (unread){
            this.logError('PARKED at block height ' + height + ' before parsing: the REORG_HALT marker could not be '
                + 'read, so this decoder cannot tell whether its database carries a halt that condemns it to a '
                + 'reset. Nothing is fetched, deleted or inserted until the marker reads. It is re-read every '
                + Math.round(UNREAD_PARK_REPROBE_MS / 1000) + 's, and parsing resumes on its own, with no restart, '
                + 'once it reads with no halt or with a halt that left no rolled-back block above the stored tip.'
                + (reason ? ' Reason: ' + reason : ''))
            return
        }
        // A halt whose marker write failed has nothing an operator can clear, so the
        // park cannot end on its own and the line has to say so rather than promise a
        // resume that will never come.
        const recorded = this.reorgHaltMarkerPersisted !== false
        this.logError('PARKED on a REORG_HALT at block height ' + height
            + '. The parse loop has stopped and this process stays up: the durable marker refuses every '
            + 'rollback and a restart cannot clear it. '
            + (resetOnly
                ? 'This halt rolled back blocks above the stored tip and a parked decoder never re-parses them, '
                    + 'so clear-reorg-halt refuses it: recover with ' + RESET_RECOVERY + ', which re-decodes '
                    + 'this decoder and its indexer from the start height.'
                : 'Clear it with `xchain-node clear-reorg-halt <chain> '
                    + '<network> --reason "..."`, which verifies the rolled-back range has been re-parsed and records '
                    + 'the clear as its own events row. This decoder re-reads the marker every '
                    + Math.round(REORG_HALT_PROBE_INTERVAL_MS / 1000) + 's and resumes parsing on its own once it is '
                    + 'gone, with no restart.')
            + (recorded ? '' : ' The marker could NOT be persisted, so nothing exists for a clear to supersede '
                + 'and this park will NOT end on its own: repair the database and restart.')
            + (reason ? ' Reason: ' + reason : ''))
    },

    // Park before the first block when a live halt left rolled-back blocks above the
    // stored tip. Such a halt may already have finished its rollback down to the fork
    // point (reorg_verification/halted_walk.js), so the stored tip sits on the node's
    // chain and no reorg would reach verifyReorg's entry guard: parsing forward would
    // extend a database whose dispenser state may not match a fresh sync.
    //
    // Fails closed three times over: a halt probe that failed (it threw, or answered
    // with nothing) parks, since an unread marker may be exactly such a halt; a count
    // that cannot be read parks; and a db with no count at all parks, since nothing
    // then says the halt left no rolled-back block above the tip. A db with no probe
    // at all keeps the cached state, as checkReorgHalt does. Runs at boot and again
    // when a probe first sees a halt. Never throws. Returns true when it parked.
    async parkOnRolledBackHalt(){
        if (this.reorgHaltParked) return false
        if (this.reorgHaltProbeFailed === true){
            this.parkOnReorgHalt('the REORG_HALT probe failed; see the probe warning above.',
                this.lastProcessedBlockIndex, { unread: true })
            return true
        }
        if (!this.reorgHalted) return false
        const rolledBack = await readRolledBackAboveTip(this.db)
        if (rolledBack === 0) return false
        const count = (rolledBack === undefined)
            ? 'an uncounted number of (this database has no countReorgDeletesAboveTip)'
            : (rolledBack === null ? 'an unreadable number of' : rolledBack)
        this.parkOnReorgHalt('the live REORG_HALT left ' + count + ' rolled-back block(s) above the stored tip.'
            + (this.reorgHaltReason ? ' Marker detail: ' + this.reorgHaltReason : ''),
            this.lastProcessedBlockIndex, { resetOnly: true })
        return true
    },

    // Ask whether a park may end, and end it when it may. True once the loop may parse
    // again; false while it must stay parked.
    //
    // The probe is deliberately un-forced: checkReorgHalt's own TTL
    // (REORG_HALT_PROBE_INTERVAL_MS) is the re-read cadence, so a loop ticking every
    // second costs one query a minute and every expiry is a real re-read of the events
    // table rather than the cached answer. A halt whose marker never persisted is never
    // resumed from: the probe would find no row, read that as cleared, and resume
    // straight back into the same refusal once per tick.
    async resumeFromReorgHaltPark(){
        if (!this.reorgHaltParked) return true
        if (this.reorgHaltParkUnread) return this.resumeFromUnreadPark()
        if (this.reorgHaltMarkerPersisted === false) return false
        const status = await this.checkReorgHalt()
        if (status.halted) return false
        const height = this.reorgHaltParkedHeight
        this.reorgHaltParked = false
        this.reorgHaltParkedAt = null
        this.reorgHaltParkedHeight = null
        this.log('REORG_HALT cleared; resuming the parse loop'
            + (height === null ? '' : ' from block height ' + height) + ' without a restart.')
        return true
    },

    // End a park taken on an unreadable marker, but only on a real read: a probe that
    // fails again answers the cached state, which is no evidence of anything. A read
    // that finds a halt goes through the boot park check, so a halt with rolled-back
    // blocks above the stored tip stays parked for a reset and one with none parses
    // forward as it would have from boot.
    async resumeFromUnreadPark(){
        const now = Date.now()
        if (this.unreadParkProbeAt > 0 && (now - this.unreadParkProbeAt) < UNREAD_PARK_REPROBE_MS) return false
        this.unreadParkProbeAt = now
        const status = await this.checkReorgHalt({ force: true, now })
        if (this.reorgHaltProbeFailed !== false) return false
        this.unreadParkProbeAt = 0
        this.reorgHaltParked = false
        this.reorgHaltParkedAt = null
        this.reorgHaltParkedHeight = null
        this.reorgHaltParkUnread = false
        if (status.halted && await this.parkOnRolledBackHalt()) return false
        this.log('REORG_HALT marker read ' + (status.halted ? 'as a halt with no rolled-back block above the stored tip' : 'with no halt')
            + '; resuming the parse loop without a restart.')
        return true
    },

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
            logger.error('AuxPoW header strip at height ' + blockHeight + ' failed ' + this._auxPowParseErrorCount +
                ' consecutive times; falling back to per-tx block reassembly (malformed-AuxPoW recovery).')
            return this.connector.getBlockReassembled(blockHash)
        }
        return this.connector.getBlockWithoutAuxPow(blockHash)
    },

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
    },

    // Re-read with readOnce() until two readings TIP_SETTLE_DELAY_MS apart agree, starting
    // from `first`, the reading that raised the question. readOnce() returns null when the
    // node cannot be read or a gate refuses the reply. Returns the settled reading, or null
    // when a re-read fails or the reading is still moving after TIP_SETTLE_MAX_READS, so
    // the caller ends its pass with nothing deleted and the next pass reads afresh.
    async settleNodeReading(first, readOnce, what){
        let previous = first
        for (let read = 0; read < TIP_SETTLE_MAX_READS; read++){
            await this.sleep(TIP_SETTLE_DELAY_MS)
            const next = await readOnce()
            if (next === null) return null
            if (next === previous) return next
            previous = next
        }
        logger.warn('The ' + what + ' is still moving after ' + TIP_SETTLE_MAX_READS + ' readings (last ' + previous
            + '); not rolling back on a moving reading, re-checking next pass.')
        return null
    }
}
