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
 ********************************************************************/

const { noteProbeFailure } = require('./probe_routes');

// Probe state for the JSON-RPC health method: the sync status, a live DB ping
// and the REORG_HALT marker. The payload is built from it in src/api.js.
async function getHealthProbeState(decoder) {
    const syncStatus = decoder.getSyncStatus();

    // Live DB reachability probe. decoder.db is null until start()
    // creates the Database instance, so a null db means we are still
    // before the DB-connect phase. db.ping() draws its own pooled
    // connection; probing via getConnection() would grab (and then
    // release!) the block loop's open transaction connection mid-block.
    let dbOk = false
    let dbPhase = 'starting'
    if(decoder.db){
        try {
            await decoder.db.ping()
            dbOk = true
            dbPhase = 'running'
        } catch(e) {
            dbPhase = 'db-unreachable'
            noteProbeFailure('db_ping', 'rpc:health', e)
        }
    }

    // Latent REORG_HALT marker. TTL-cached inside checkReorgHalt, so a
    // monitoring burst costs at most one DB query per minute. Deliberately does
    // NOT flip `status` to unhealthy: the decoder healthcheck carries autoheal,
    // and the marker survives every restart (only an audited clear releases it),
    // so reporting unhealthy would restart-loop the container while fixing
    // nothing, whether the decoder is still parsing forward on a latent marker or
    // parked on the halt. Report it as its own field instead, with
    // reorg_halt_parked separating the two, and let the operator/watchdog act.
    let reorgHalt = { halted: false, reason: null, at: null, cleared_at: null, cleared_reason: null, checked_at: null }
    if (dbOk && typeof decoder.checkReorgHalt === 'function'){
        try { reorgHalt = await decoder.checkReorgHalt() } catch (e) { noteProbeFailure('reorg_halt', 'rpc:health', e) }
    }
    return { syncStatus, dbOk, dbPhase, reorgHalt }
}

module.exports = { getHealthProbeState }
