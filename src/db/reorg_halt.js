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

const crypto = require('node:crypto')

// Reason reported for a clear row that lifts nothing (see readReorgHaltState).
const UNAUDITED_CLEAR_REASON = 'unreadable or unaudited REORG_HALT_CLEARED row, treated as a live halt'
const HALT_SCAN_LIMIT = 1000

// Check a clear row's payload carries the reason bar clearReorgHalt enforces.
function isAuditedClear(payload){
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false
    return typeof payload.reason === 'string' && payload.reason.trim().length >= 8
}

function rowDetail(row){
    let payload = null
    try {
        payload = (typeof row.data === 'string') ? JSON.parse(row.data) : row.data
    } catch (_) {}
    return {
        row, payload,
        id: row.id != null ? Number(row.id) : null,
        at: payload && payload.at ? payload.at : (row.time != null ? String(row.time) : null),
        reason: payload && payload.reason ? payload.reason : null
    }
}

function clearedState(detail, none){
    return { ...none, cleared_at: detail.at, cleared_reason: detail.reason }
}

function haltedState(detail, reason = detail.reason, extra = {}){
    return { halted: true, id: detail.id, at: detail.at, reason,
        cleared_at: null, cleared_reason: null, ...extra }
}

function foldHaltRows(rows, none){
    let state = none
    for (const row of [...rows].reverse()){
        const detail = rowDetail(row)
        if (row.code === 'REORG_HALT'){
            state = haltedState(detail)
            continue
        }
        if (!isAuditedClear(detail.payload)){
            state = haltedState(detail, UNAUDITED_CLEAR_REASON, { unaudited_clear: true })
            continue
        }
        if (!state.halted){
            state = clearedState(detail, none)
            continue
        }
        const hasTarget = Object.prototype.hasOwnProperty.call(detail.payload, 'cleared_halt_id')
        const target = Number(detail.payload.cleared_halt_id)
        if (!hasTarget || (Number.isSafeInteger(target) && target === state.id)){
            state = clearedState(detail, none)
        } else {
            state = { ...state, stale_clear: true }
        }
    }
    return state
}

function rollbackLockName(dbName){
    const plain = 'xchain_reorg_' + dbName
    if (plain.length <= 64) return plain
    return 'xchain_reorg_' + crypto.createHash('sha256').update(dbName).digest('hex').slice(0, 51)
}

module.exports = {
    // Session-owned exclusion shared by verifyReorg and clear-reorg-halt. The lock
    // session is drawn straight from the pool, never through getConnection(), which
    // hands back the shared transaction connection while one is open.
    async acquireReorgRollbackLock(waitSeconds = 0){
        const wait = Number(waitSeconds)
        if (!Number.isInteger(wait) || wait < 0 || wait > 60)
            throw new Error('acquireReorgRollbackLock: invalid wait')
        const connection = await this.pool.getConnection()
        const name = rollbackLockName(this.dbName)
        try {
            const rows = await connection.query('SELECT GET_LOCK(?, ?) AS l', [name, wait])
            if (rows && rows[0] && String(rows[0].l) === '1') return { connection, name }
            await connection.release()
            return null
        } catch (err){
            try { await connection.release() } catch (_) {}
            throw err
        }
    },

    async ownsReorgRollbackLock(lock){
        if (!lock || !lock.connection || !lock.name) return false
        const rows = await lock.connection.query(
            'SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [lock.name])
        return !!(rows && rows[0] && String(rows[0].owned) === '1')
    },

    // Run fn with every read and write this Database makes on the lock's own session,
    // through the slot getConnection() already honours. clear-reorg-halt uses it so
    // its count, pin, append and read-back all run while its session holds the lock;
    // a session lost midway fails the clear instead of finishing it unexcluded.
    async runOnReorgRollbackSession(lock, fn){
        if (!lock || !lock.connection) throw new Error('runOnReorgRollbackSession: a held rollback lock is required')
        if (this.transactionConnection != null) throw new Error('runOnReorgRollbackSession: another transaction holds the connection slot')
        this.transactionConnection = lock.connection
        try { return await fn() } finally { this.transactionConnection = null }
    },

    async releaseReorgRollbackLock(lock){
        if (!lock || !lock.connection) return
        try { await lock.connection.query('SELECT RELEASE_LOCK(?)', [lock.name]) } finally {
            await lock.connection.release()
        }
    },

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
    // the reason and the checks that passed. A clear lifts only the halt whose id
    // it names, so a delayed clear cannot hide a later halt. The rows stay append-only.
    async isReorgHalted(){
        return (await this.readReorgHaltState()).halted
    },

    // The newest REORG_HALT / REORG_HALT_CLEARED row, ordered on the (code, id)
    // index. Returns { halted, id, at, reason, cleared_at, cleared_reason }.
    // Fail-closed: a halt row whose id or payload cannot be read still counts as
    // live, because "we could not tell" must never reach a caller as "not halted".
    // The same holds for a clear row: one without the audited shape clearReorgHalt
    // writes reads as a live halt flagged unaudited_clear, not as a clear.
    async readReorgHaltState(existingConnection){
        const query = `SELECT id, time, code, data FROM events WHERE code IN ('REORG_HALT', 'REORG_HALT_CLEARED') ORDER BY id DESC LIMIT 1;`
        const none = { halted: false, id: null, at: null, reason: null, cleared_at: null, cleared_reason: null }
        const connection = existingConnection || await this.getConnection()
        const ownLease = (existingConnection == null && this.transactionConnection == null)
        try {
            const rows = await connection.query(query)
            if (!Array.isArray(rows) || rows.length === 0) return none
            const row = rows[0]
            const detail = rowDetail(row)
            if (row.code === 'REORG_HALT_CLEARED'){
                if (isAuditedClear(detail.payload)){
                    const historyQuery = `SELECT id, time, code, data FROM events WHERE code IN ('REORG_HALT', 'REORG_HALT_CLEARED') ORDER BY id DESC LIMIT ${HALT_SCAN_LIMIT + 1};`
                    const history = await connection.query(historyQuery)
                    if (!Array.isArray(history)) return haltedState(detail, UNAUDITED_CLEAR_REASON)
                    if (history.length > HALT_SCAN_LIMIT){
                        const newestHalt = history.find((entry) => entry.code === 'REORG_HALT')
                        return haltedState(rowDetail(newestHalt || row), 'REORG_HALT history exceeded the safe scan bound')
                    }
                    return foldHaltRows(history, none)
                }
                // Live under the clear row's own id, so clear-reorg-halt can pin it.
                return haltedState(detail, UNAUDITED_CLEAR_REASON, { unaudited_clear: true })
            }
            // Any other shape (the expected REORG_HALT, or a row whose code could not
            // be read) is a live halt.
            return haltedState(detail)
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
    // live id, so the operator re-runs the checks. An unreadable live id refuses too,
    // pinned or not (a null id is also what an unpinnable caller would pass): "we
    // could not tell" must never clear, the same fail-closed rule readReorgHaltState states.
    async clearReorgHalt({ reason, checks = {}, forced = false, expectedHaltId = null } = {}){
        if (typeof reason !== 'string' || reason.trim().length < 8)
            throw new Error('clearReorgHalt: a reason of at least 8 characters is required; it is recorded with the clear')
        let connection = this.transactionConnection
        let ownLease = false
        let sessionDirty = false
        try {
            if (connection == null){
                connection = await this.getConnection()
                ownLease = true
            }
            try {
                await this.assertStrictSqlMode(connection)
            } catch (err){
                sessionDirty = true
                return { cleared: false, alreadyClear: false, laxSession: true, error: (err && err.message) || String(err) }
            }
            const state = await this.readReorgHaltState(connection)
            if (!state.halted) return { cleared: false, alreadyClear: true }
            if (state.id == null || (expectedHaltId != null && String(state.id) !== String(expectedHaltId)))
                return { cleared: false, alreadyClear: false, superseded: true, liveHaltId: (state.id != null ? state.id : null) }
            const written = await this.insertEvent('REORG_HALT_CLEARED', {
                reason: reason.trim(),
                at: new Date().toISOString(),
                forced: !!forced,
                checks: checks,
                cleared_halt_id: state.id,
                cleared_halt_at: state.at,
                cleared_halt_reason: state.reason
            }, undefined, connection)
            if (written !== true) return { cleared: false, alreadyClear: false }
            const after = await this.readReorgHaltState(connection)
            if (after.halted && after.id != null && String(after.id) !== String(state.id)){
                return { cleared: false, alreadyClear: false, superseded: true, liveHaltId: after.id }
            }
            return { cleared: after.halted === false, alreadyClear: false }
        } finally {
            if (ownLease && connection){
                if (sessionDirty && typeof connection.destroy === 'function'){
                    try { await connection.destroy() } catch (_) {}
                } else {
                    try { await connection.release() } catch (_) {}
                }
            }
        }
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
    // again writes two markers and is one block of depth. Bounded scan: the largest
    // configured ceiling is 5006, so the newest 10000 REORG rows cover every reachable depth, and
    // (code, id) is indexed (src/sql/events.sql). THROWS on an unreadable or
    // unparseable result - "we could not tell" must never reach the caller as "no
    // prior rollback", which is the exact collapse this whole guard exists to stop.
    async countReorgDeletesAboveTip(scanLimit = 10000){
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
        const connection = await this.getConnection()
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
                    // Accept integers and legacy digit strings only. Other values
                    // must fail closed instead of coercing to height zero.
                    const raw = entry && typeof entry === 'object' && !Array.isArray(entry)
                        ? entry.block_index : undefined
                    const readable = typeof raw === 'number'
                        || (typeof raw === 'string' && /^\d+$/.test(raw))
                    const height = readable ? Number(raw) : NaN
                    if (!Number.isSafeInteger(height) || height < 0)
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

    // Read the durable halt marker WITH its detail. isReorgHalted() above is the
    // boolean view of the same readReorgHaltState() read. An audited clear resolves
    // only the halt id it names, so a bare `code = 'REORG_HALT'` existence check is
    // insufficient. Operator-facing surfaces (health,
    // GET /status, the bootstrap publisher's source gate) need to say WHEN the decoder
    // halted and WHY, because a latent marker is otherwise invisible until a reorg
    // trips it days later. Returns readReorgHaltState() without its unaudited_clear
    // flag: { halted, id, at, reason, cleared_at, cleared_reason }. A halt row with an
    // unreadable payload still reads as halted, with `reason` null and `at` falling
    // back to the row time; an unaudited clear reads as halted with the
    // unaudited-clear reason.
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
    // Called on every verifyReorg abort path BEFORE the throw, so a restarted decoder
    // refuses every later rollback until an audited clear. Best-effort by design; the
    // caller swallows any error so a marker-write failure never masks the loud abort.
    //
    // Returns TRUE only when a REORG_HALT row is readable afterwards, never merely
    // "the INSERT reported no error". insertEvent swallows every write error and
    // returns false, so the boolean it hands back is the only failure signal that
    // exists here, and a caller that trusts it without a read-back is trusting a
    // driver's ack for a row nobody has seen. That distinction is the whole point:
    // this marker is the only durable record of the halt (the depth ceiling across a
    // restart rests separately on countReorgDeletesAboveTip), and every consumer of it
    // (the entry guard, the health surfaces, the bootstrap gate) reads the ROW, not the ack.
    async markReorgHalted(reason){
        // An unaudited clear row reads as halted but is no REORG_HALT row, and older
        // bootstrap gates count only those rows, so that halt still gets one written.
        const live = await this.readReorgHaltState()
        if (live.halted && !live.unaudited_clear) return true
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
