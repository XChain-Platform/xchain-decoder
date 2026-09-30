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

const config = require('../config')

// Allow one hour per migration statement unless MIGRATE_QUERY_TIMEOUT says otherwise.
const DEFAULT_MIGRATE_QUERY_TIMEOUT_MS = 3600000

// Read MIGRATE_QUERY_TIMEOUT in ms; 0 means no limit, and blank, non-numeric or negative
// keeps the default (mirrors xchain-indexer/src/db/database/migration_runner.js).
function migrationQueryTimeoutMs(){
    const raw = config.MIGRATE_QUERY_TIMEOUT
    if(raw == null || String(raw).trim() === '') return DEFAULT_MIGRATE_QUERY_TIMEOUT_MS
    const ms = Number(raw)
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_MIGRATE_QUERY_TIMEOUT_MS
}

// Override the pool's session max_statement_time, which the driver sets from queryTimeout.
async function setSessionStatementTime(conn, ms){
    await conn.query('SET SESSION max_statement_time = ?', [ms / 1000])
}

async function releaseMigrationLock(conn, lockName){
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]) } catch(_){}
}

// Restore the pool's limit before RELEASE_LOCK; destroy the connection when the restore
// fails so a raised limit never returns to the pool. Returns whether it is poolable.
async function restoreRuntimeTimeoutAndReleaseLock(conn, lockName, runtimeTimeoutMs){
    let restored = true
    try { await setSessionStatementTime(conn, runtimeTimeoutMs) }
    catch(_){ restored = false }
    await releaseMigrationLock(conn, lockName)
    if(!restored && typeof conn.destroy === 'function'){
        try { await conn.destroy() } catch(_){}
    }
    return restored
}

// Raise the statement limit at most once per locked run, and on release restore it only
// when this run raised it. release() resolves true when the connection may be pooled.
function migrationSession(conn, lockName, runtimeTimeoutMs){
    let touched = false
    return {
        async activate(){
            if(touched) return
            touched = true
            await setSessionStatementTime(conn, migrationQueryTimeoutMs())
        },
        async release(){
            if(touched) return restoreRuntimeTimeoutAndReleaseLock(conn, lockName, runtimeTimeoutMs)
            await releaseMigrationLock(conn, lockName)
            return true
        },
    }
}

module.exports = {
    DEFAULT_MIGRATE_QUERY_TIMEOUT_MS,
    migrationQueryTimeoutMs,
    migrationSession,
}
