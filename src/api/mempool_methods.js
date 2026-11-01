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

const config = require('../config');

async function readMempoolSnapshot(state, db, now, reportReadFailure){
    try {
        const rows  = await db.getMempoolTransactions(500);
        const total = await db.getMempoolTransactionCount();
        state.cache = { t: now, rows, total, read_ok_at: Date.now() };
        state.failedAt = 0;
        return true;
    } catch (err) {
        reportReadFailure(err);
        state.failedAt = Date.now();
        return false;
    }
}

async function refreshMempoolSnapshot(state, db, now, ttl, reportReadFailure){
    if (!db) {
        state.cache = { t: now, rows: [], total: 0, read_ok_at: null };
        return false;
    }
    const backoff = Math.min(1000, ttl);
    if (state.failedAt && now - state.failedAt < backoff) return true;
    if (!state.refresh) {
        state.refresh = readMempoolSnapshot(state, db, now, reportReadFailure)
            .finally(() => { state.refresh = null; });
    }
    return !(await state.refresh);
}

// getmempool's shared snapshot cache (see the method's comment). Held here so
// every request, whatever its limit, slices one cached 500-row window.
function createMempoolMethods(decoder, reportReadFailure){
    const state = { cache: null, failedAt: 0, refresh: null };
    return {
        // Current mempool snapshot for remote explorers. mempool_transactions is
        // deliberately excluded from xchain-sync replication (node-local,
        // non-deterministic observation), so an explorer serving from synced
        // replicas has no DB path to pending actions; this method is that path.
        // Returns the node's TOTAL mempool tx count (XChain or not, from the
        // last updateMempool poll; -1 until one has run), the count of
        // XChain-carrying rows, and a bounded row window (same 500-row cap and
        // tx_hash ordering as the explorer's colocated-DB read). Rows are
        // PRE-VALIDATION: the indexer can still reject them at confirmation.
        //
        // TTL-cached (default 5s, GETMEMPOOL_CACHE_MS) because this method, unlike
        // its trivial siblings above, reads the DB: without the cache an
        // unauthenticated request burst would amplify into pooled-connection
        // contention against the block loop (the same hazard the batch guard
        // below exists for). The full 500-row window is cached once and sliced
        // per-request, so differing limits share one read. A poll-cycle-stale
        // snapshot is fine: updateMempool itself only rewrites every 60s.
        async getmempool(params) {
            const ttl = parseInt(config.GETMEMPOOL_CACHE_MS, 10) || 5000;
            const now = Date.now();
            const db  = decoder.mempoolDb || decoder.db;
            let stale = false;
            let snapshot = state.cache;
            if (!state.cache || (now - state.cache.t) >= ttl) {
                stale = await refreshMempoolSnapshot(state, db, now, ttl, reportReadFailure);
                snapshot = state.cache || { rows: [], total: 0, read_ok_at: null };
            }
            const limit = Math.max(1, Math.min(parseInt(params && params.limit, 10) || 500, 500));
            return {
                node_tx_count: decoder.nodeMempoolTxCount,
                node_updated_at: decoder.nodeMempoolUpdatedAt,
                stale,
                read_ok_at: snapshot.read_ok_at,
                total: snapshot.total,
                rows: snapshot.rows.slice(0, limit).map(r => ({
                    tx_hash: r.tx_hash,
                    source: r.source,
                    data: Buffer.isBuffer(r.data) ? r.data.toString('utf8') : r.data,
                    first_seen: Number.isFinite(r.first_seen) ? r.first_seen : null
                }))
            };
        }
    }
}

module.exports = { createMempoolMethods }
