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
 **********************************************************************/

module.exports = {
    // Durable reorg-halt flag. verifyReorg's fail-closed safe-depth
    // ceiling is a per-invocation counter: on a reorg deeper than
    // DISPENSER_EXPIRE_SAFE_DEPTH it aborts mid-rollback, but nothing persisted
    // the abort, so a plain process restart re-entered verifyReorg with a zeroed
    // counter and silently completed the over-deep rollback past the dispenser
    // purge window (permanent money-bearing dispenser-state divergence). The halt
    // is persisted as a REORG_HALT row in the events table (an existing durable
    // store); a full resync from a known-good snapshot rebuilds the schema and so
    // clears it, matching the recovery the abort message already demands.
    //
    // An operator can CLEAR a halt through clearReorgHalt (src/clear_reorg_halt.js,
    // `xchain-node clear-reorg-halt`): that writes a REORG_HALT_CLEARED row carrying
    // the reason and the checks that passed, and the NEWEST of the two codes decides.
    // The halt row is never deleted, so the audit trail survives, and a later halt
    // writes a newer REORG_HALT row that is live again.
    async isReorgHalted(){
        return (await this.readReorgHaltState()).halted
    },

    // The newest REORG_HALT / REORG_HALT_CLEARED row, ordered on the (code, id)
    // index. Returns { halted, id, at, reason, cleared_at, cleared_reason }.
    // Fail-closed: a halt row whose id or payload cannot be read still counts as
    // live, because "we could not tell" must never reach a caller as "not halted".
    async readReorgHaltState(){
        const query = `SELECT id, time, code, data FROM events WHERE code IN ('REORG_HALT', 'REORG_HALT_CLEARED') ORDER BY id DESC LIMIT 1;`
        const none = { halted: false, id: null, at: null, reason: null, cleared_at: null, cleared_reason: null }
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows) || rows.length === 0) return none
            const row = rows[0]
            let payload = null
            try {
                payload = (typeof row.data === 'string') ? JSON.parse(row.data) : row.data
            } catch (_) {
                payload = null
            }
            const at = (payload && payload.at) ? payload.at : (row.time != null ? String(row.time) : null)
            const reason = (payload && payload.reason) ? payload.reason : null
            if (row.code === 'REORG_HALT_CLEARED'){
                return { ...none, cleared_at: at, cleared_reason: reason }
            }
            // events.id is a BIGINT column, and the pool below sets insertIdAsNumber
            // but not bigIntAsNumber, so the driver hands row.id back as a JS BigInt.
            // An events id never approaches Number.MAX_SAFE_INTEGER, so normalise to a
            // plain number here: every caller that compares it or puts it in a JSON
            // audit payload (clearReorgHalt's cleared_halt_id) gets a safe value
            // instead of a BigInt that JSON.stringify throws on.
            const id = (row.id != null) ? Number(row.id) : null
            // Any other shape (the expected REORG_HALT, or a row whose code could not
            // be read) is a live halt.
            return { halted: true, id: id, at: at, reason: reason, cleared_at: null, cleared_reason: null }
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    // Audited operator clear of a live REORG_HALT marker. Writes a
    // REORG_HALT_CLEARED row carrying the reason, the check results and the halt it
    // supersedes, then confirms by read-back exactly as markReorgHalted does.
    // Returns { cleared, alreadyClear }. Never deletes the halt row.
    //
    // `expectedHaltId` pins the identity the caller's preconditions were measured
    // against. The decoder keeps running while the operator command does, so a
    // verifyReorg abort can raise a NEW halt inside that window; clearing on liveness
    // alone would write a clear that supersedes a halt nobody audited, carrying checks
    // taken before it existed. A mismatch refuses with { superseded: true } and the
    // live id, so the operator re-runs the checks. An unreadable live id refuses too:
    // "we could not tell" must never clear, the same fail-closed rule
    // readReorgHaltState states.
    async clearReorgHalt({ reason, checks = {}, forced = false, expectedHaltId = null } = {}){
        if (typeof reason !== 'string' || reason.trim().length < 8)
            throw new Error('clearReorgHalt: a reason of at least 8 characters is required; it is recorded with the clear')
        const state = await this.readReorgHaltState()
        if (!state.halted) return { cleared: false, alreadyClear: true }
        if (expectedHaltId != null && (state.id == null || String(state.id) !== String(expectedHaltId)))
            return { cleared: false, alreadyClear: false, superseded: true, liveHaltId: (state.id != null ? state.id : null) }
        const written = await this.insertEvent('REORG_HALT_CLEARED', {
            reason: reason.trim(),
            at: new Date().toISOString(),
            forced: !!forced,
            checks: checks,
            cleared_halt_id: state.id,
            cleared_halt_at: state.at,
            cleared_halt_reason: state.reason
        })
        if (written !== true) return { cleared: false, alreadyClear: false }
        const after = await this.readReorgHaltState()
        return { cleared: after.halted === false, alreadyClear: false }
    },

    // How many distinct block heights above the current tip have already been
    // rolled back and not yet re-synced.
    //
    // This is the restart-durable half of the safe-depth ceiling. The REORG_HALT
    // marker above is best-effort by construction: markReorgHalted runs on the
    // abort path, so a DB fault at exactly that moment leaves the halt recorded
    // nowhere, and a restarted decoder re-entered verifyReorg with a zeroed depth
    // counter and finished the over-deep rollback. The evidence this method reads
    // cannot be lost that way, because deleteBlockByIndex commits the REORG marker
    // INSIDE the same transaction as the block delete: a deleted block and its
    // marker are atomic, so the marker rows above the tip ARE the rollback depth.
    //
    // Distinct heights, not a row count: a height deleted, re-synced and deleted
    // again writes two markers and is one block of depth. Bounded scan: the ceiling
    // is 126, so the newest few thousand REORG rows cover every reachable depth, and
    // (code, id) is indexed (src/sql/events.sql). THROWS on an unreadable or
    // unparseable result - "we could not tell" must never reach the caller as "no
    // prior rollback", which is the exact collapse this whole guard exists to stop.
    async countReorgDeletesAboveTip(scanLimit = 5000){
        // Throws (after its own retries) rather than returning a sentinel, so an
        // unknown tip cannot silently become "everything is above it" or "nothing is".
        const tip = await this.getLastBlockIndex()
        // Interpolated, not bound: LIMIT placeholders are not used anywhere else in
        // this file, so the bound is range-checked here instead and the SQL stays the
        // plain shape the rest of the module uses. The value is internal, never
        // operator input, and the guard is what makes that literal safe.
        const limit = Number(scanLimit)
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000000)
            throw new Error('countReorgDeletesAboveTip: refusing an out-of-range scan limit: ' + scanLimit)
        const query = `SELECT id, data FROM events WHERE code = 'REORG' ORDER BY id DESC LIMIT ${limit};`
        let connection = await this.getConnection()
        const ownLease = (this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows))
                throw new Error('countReorgDeletesAboveTip: the REORG marker scan returned no readable rows')
            const heightsAboveTip = new Set()
            for (const row of rows){
                let payload
                try {
                    payload = (typeof row.data === 'string') ? JSON.parse(row.data) : row.data
                } catch (err){
                    throw new Error('countReorgDeletesAboveTip: REORG marker id ' + row.id
                        + ' has an unreadable payload, so the rollback depth cannot be bounded: ' + err.message)
                }
                // Both marker shapes are arrays of {block_index, block_hash} (one entry
                // per row since M-12, several on older rows); anything else means this
                // is not the marker whose depth we are counting.
                if (!Array.isArray(payload))
                    throw new Error('countReorgDeletesAboveTip: REORG marker id ' + row.id
                        + ' is not the expected array payload, so the rollback depth cannot be bounded')
                for (const entry of payload){
                    const height = Number(entry && entry.block_index)
                    if (!Number.isFinite(height))
                        throw new Error('countReorgDeletesAboveTip: REORG marker id ' + row.id
                            + ' carries a non-numeric block_index, so the rollback depth cannot be bounded')
                    if (height > tip) heightsAboveTip.add(height)
                }
            }
            return heightsAboveTip.size
        } finally {
            if (ownLease){
                await connection.release()
            }
        }
    },

    // Read the durable halt marker WITH its detail. isReorgHalted() above
    // answers the one question verifyReorg asks (may I roll back?) and deliberately
    // stays a bare existence probe on the hot reorg path. Operator-facing surfaces
    // (health, GET /status, the bootstrap publisher's source gate) need to say WHEN
    // the decoder halted and WHY, because a latent marker is otherwise invisible
    // until a reorg trips it days later. Returns { halted, at, reason }; `at`/`reason`
    // are null when the row exists but its payload is unreadable (an older marker, or
    // JSON written by a different revision), which must never turn a real halt into a
    // reported non-halt.
    //
    // `id` is the events row id of the live halt (null when not halted, or when the
    // id could not be read). It is the identity clear-reorg-halt pins its
    // preconditions to, so a halt raised while that command runs cannot be cleared by
    // checks that never ran against it.
    //
    // Honours an operator clear: after clearReorgHalt the marker reads as not
    // halted and carries `cleared_at` / `cleared_reason` instead, so the health
    // surface can show that a halt WAS here and who cleared it.
    async getReorgHaltMarker(){
        const state = await this.readReorgHaltState()
        return {
            halted:         state.halted,
            id:             state.id,
            at:             state.at,
            reason:         state.reason,
            cleared_at:     state.cleared_at,
            cleared_reason: state.cleared_reason
        }
    },

    // Persist the durable reorg-halt marker (idempotent: no-op if already halted).
    // Called on every verifyReorg abort path BEFORE the throw, so a restart cannot
    // resume the over-deep rollback. Best-effort by design; the caller swallows any
    // error so a marker-write failure never masks the original loud abort.
    //
    // Returns TRUE only when a REORG_HALT row is readable afterwards, never merely
    // "the INSERT reported no error". insertEvent swallows every write error and
    // returns false, so the boolean it hands back is the only failure signal that
    // exists here, and a caller that trusts it without a read-back is trusting a
    // driver's ack for a row nobody has seen. That distinction is the whole point:
    // this marker is the only thing standing between a restarted decoder and a
    // silently resumed over-deep rollback, and every consumer of it (the entry
    // guard, the health surfaces, the bootstrap gate) reads the ROW, not the ack.
    async markReorgHalted(reason){
        if (await this.isReorgHalted()) return true
        const written = await this.insertEvent('REORG_HALT', { reason: reason, at: new Date().toISOString() })
        // Anything other than a clean insert is a failure. DUPLICATED_TRANSACTION
        // is truthy and would otherwise read as success, so the read-back below
        // decides that case on the row rather than on the errno.
        if (written === false) return false
        try {
            return await this.isReorgHalted()
        } catch (_) {
            // The write may well have landed, but nothing here can say so, and an
            // unconfirmed marker must never report as a confirmed one.
            return false
        }
    },
}
