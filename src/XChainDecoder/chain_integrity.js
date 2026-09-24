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
const { logger, REORG_HALT_PROBE_INTERVAL_MS, AUXPOW_REASSEMBLE_AFTER } = require('./constants.js')

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
                if (this.reorgHalted && !wasHalted){
                    logger.error('XChainDecoder: LATENT REORG_HALT MARKER PRESENT - this decoder carries a durable ' +
                        'REORG_HALT row from an aborted rollback. It will keep parsing forward and look healthy, but ' +
                        'the NEXT reorg will refuse to roll back and stop the decoder. This database is NOT a valid ' +
                        'bootstrap source. REQUIRED OPERATOR ACTION: a full resync from a known-good snapshot, or ' +
                        'once the rolled-back range is re-parsed and the database is verified intact, ' +
                        '`xchain-node clear-reorg-halt <coin> <network> --reason "..."`.' +
                        (this.reorgHaltReason ? ' Marker detail: ' + this.reorgHaltReason : ''))
                } else if (!this.reorgHalted && wasHalted){
                    logger.warn('XChainDecoder: REORG_HALT marker is gone; halt cleared.')
                }
                return this.getReorgHaltStatus()
            } catch (e){
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
    parkOnReorgHalt(reason, blockHeight){
        if (this.reorgHaltParked) return
        this.reorgHaltParked = true
        this.reorgHaltParkedAt = new Date().toISOString()
        this.reorgHaltParkedHeight = (typeof blockHeight === 'number' && blockHeight >= 0) ? blockHeight : null
        // A halt whose marker write failed has nothing an operator can clear, so the
        // park cannot end on its own and the line has to say so rather than promise a
        // resume that will never come.
        const recorded = this.reorgHaltMarkerPersisted !== false
        this.logError('PARKED on a REORG_HALT at block height '
            + (this.reorgHaltParkedHeight === null ? 'unknown' : this.reorgHaltParkedHeight)
            + '. The parse loop has stopped and this process stays up: the durable marker refuses every '
            + 'rollback and a restart cannot clear it. Clear it with `xchain-node clear-reorg-halt <chain> '
            + '<network> --reason "..."`, which verifies the rolled-back range has been re-parsed and records '
            + 'the clear as its own events row. This decoder re-reads the marker every '
            + Math.round(REORG_HALT_PROBE_INTERVAL_MS / 1000) + 's and resumes parsing on its own once it is '
            + 'gone, with no restart.'
            + (recorded ? '' : ' The marker could NOT be persisted, so nothing exists for a clear to supersede '
                + 'and this park will NOT end on its own: repair the database and restart.')
            + (reason ? ' Reason: ' + reason : ''))
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
    }
}
