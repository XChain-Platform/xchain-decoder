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

/*********************************************************************
 * Kaspa store projection (pure SQL text — offline testable)
 *
 * Input : the rows() produced by kaspa_ingest.js
 * Output: INSERT / DELETE statements against the platform's decoder tables
 *
 * Why this is its own layer: the SQL text is pure, so it can be asserted
 * offline; the driver (mariadb) is only needed when a database actually
 * exists, so nothing here requires a driver.
 *
 * Two behaviours taken from the platform rather than invented:
 *   · Lookup tables (index_transactions / index_addresses) are written with
 *     INSERT ... ON DUPLICATE KEY UPDATE — ids are append-only and a replayed
 *     slice re-inserts the same ids.
 *   · Block-scoped tables are deleted for real on rollback; the replay that
 *     follows re-inserts them. Nothing is tombstoned.
 ********************************************************************/
'use strict';

const SCHEMA = {
    index_transactions: ['id', 'hash'],
    index_addresses: ['id', 'address'],
    blocks: ['block_index', 'block_time', 'block_hash_id', 'previous_block_hash_id'],
    transactions: ['tx_index', 'tx_hash_id', 'block_index', 'source_id', 'destination_id', 'amount', 'fee', 'data', 'raw_data'],
    transaction_outputs: ['tx_index', 'vout', 'destination_id', 'amount'],
    pubkeys: ['address_id', 'pubkey'],
    dispensers: ['tx_index', 'address_id', 'expiration', 'oracle_address_id', 'source_address_id', 'expired_block_index'],
    events: ['time', 'code', 'data'],
    mempool_transactions: ['tx_hash', 'source', 'destination', 'amount', 'fee', 'data', 'raw_data'],
};

const q = (ident) => '`' + String(ident).replace(/`/g, '``') + '`';

function insertSql(table, row, { upsert = false } = {}) {
    const columns = SCHEMA[table];
    if (!columns) throw new Error('unknown table: ' + table);
    const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
    let sql = 'INSERT INTO ' + q(table) + ' (' + columns.map(q).join(', ') + ') VALUES ('
        + columns.map(() => '?').join(', ') + ')';
    if (upsert) {
        // Lookup tables: a repeated id overwrites; every other column is untouched
        // by the ON DUPLICATE arm only when the id matches, which is what makes
        // replay idempotent.
        const updates = columns.filter((c) => c !== 'id')
            .map((c) => q(c) + ' = VALUES(' + q(c) + ')').join(', ');
        sql += ' ON DUPLICATE KEY UPDATE ' + updates;
    }
    return { sql, values };
}

// rows() -> ordered statements. Order is the foreign-key order: index_* first
// (other tables reference their ids), then blocks, then transactions, then the
// children. `events` is passed explicitly (see the cursor in kaspa_service.js):
// rows.events accumulates, so writing all of it every tick would duplicate.
function buildWritePlan(rows, { sinceBlockIndex = 0, events = [] } = {}) {
    const plan = [];

    // Events are INDEPENDENT of the block delta and must be emitted even when nothing new
    // arrived: a reorg can come back as removals with no additions, and the indexer's
    // witness (`WHERE id=? AND code='REORG'`) still has to see it. An earlier version
    // returned [] right here, so the service advanced its flush cursor over events that
    // were never written, and they were lost for good.
    for (const r of events) plan.push(insertSql('events', r));

    const newBlocks = (rows.blocks || []).filter((b) => Number(b.block_index) > Number(sinceBlockIndex));
    if (!newBlocks.length) return plan;

    const newTx = new Set((rows.transactions || [])
        .filter((t) => Number(t.block_index) > Number(sinceBlockIndex))
        .map((t) => t.tx_index));

    for (const r of rows.index_transactions || []) plan.push(insertSql('index_transactions', r, { upsert: true }));
    for (const r of rows.index_addresses || []) plan.push(insertSql('index_addresses', r, { upsert: true }));
    // These three carry the block's own data and were the only statements without an upsert.
    // The real-database integration test caught what that costs: re-writing a slice that is
    // already in the table - a lost checkpoint, a manual re-run, a reorg that re-adds an index -
    // died on a duplicate primary key, and that error is not in the recoverable class, so the
    // reader stopped. Idempotent here means the same slice can always be written again.
    for (const r of newBlocks) plan.push(insertSql('blocks', r, { upsert: true }));
    for (const r of rows.transactions || []) if (newTx.has(r.tx_index)) plan.push(insertSql('transactions', r, { upsert: true }));
    for (const r of rows.transaction_outputs || []) if (newTx.has(r.tx_index)) plan.push(insertSql('transaction_outputs', r, { upsert: true }));
    for (const r of rows.pubkeys || []) plan.push(insertSql('pubkeys', r, { upsert: true }));
    for (const r of rows.dispensers || []) if (newTx.has(r.tx_index)) plan.push(insertSql('dispensers', r, { upsert: true }));
    return plan;
}

// Rollback deletes every block-scoped row at or above `since`. Lookup tables are
// left alone (append-only). Order is the reverse of insertion: children first.
function buildRollbackPlan(since) {
    const b = Number(since);
    if (!Number.isFinite(b) || b < 0) throw new Error('since must be a non-negative integer');
    return [
        // transaction_outputs has no block_index of its own; join through the parent.
        { sql: 'DELETE o FROM `transaction_outputs` o JOIN `transactions` t ON t.tx_index = o.tx_index WHERE t.block_index >= ?', values: [b] },
        // Same join for the dispenser registrations. Events are append-only: never deleted.
        { sql: 'DELETE d FROM `dispensers` d JOIN `transactions` t ON t.tx_index = d.tx_index WHERE t.block_index >= ?', values: [b] },
        { sql: 'DELETE FROM `transactions` WHERE block_index >= ?', values: [b] },
        { sql: 'DELETE FROM `blocks` WHERE block_index >= ?', values: [b] },
        // pubkeys / index_* are deliberately absent: in the platform DDL pubkeys is
        // keyed by address_id with no block_index column, i.e. lookup data. The
        // replay rewrites it, and ON DUPLICATE KEY keeps that idempotent.
    ];
}

// Execution is injected: conn must expose query(sql, values).
async function applyPlan(conn, plan) {
    const done = [];
    for (const statement of plan) {
        await conn.query(statement.sql, statement.values);
        done.push(statement.sql.split(' ').slice(0, 3).join(' '));
    }
    return done;
}

// One tick's delete+write must be atomic: a half-written block is worse than a
// failed tick. Connections without transactions (dry runs, fakes) pass through.
async function withTransaction(conn, fn) {
    const hasTransaction = typeof conn.beginTransaction === 'function' && typeof conn.commit === 'function';
    if (!hasTransaction) return await fn();
    await conn.beginTransaction();
    try {
        const out = await fn();
        await conn.commit();
        return out;
    } catch (error) {
        try { await conn.rollback(); }
        catch (rollbackError) {
            // Never mask the original failure: attach the rollback failure and rethrow.
            error.rollbackError = String(rollbackError && rollbackError.message ? rollbackError.message : rollbackError);
        }
        throw error;
    }
}

// Schema scripts in this repo are per-table DROP+CREATE (src/sql/*.sql), i.e. meant
// for a fresh database. Running one wholesale on every start would empty the DB, so
// the default path rewrites DROP away and adds IF NOT EXISTS; duplicate-index and
// duplicate-seed-row errors are then expected and ignored by the caller.
// `--reset-schema` is the explicit destructive path.
function toIdempotent(sql) {
    if (/^DROP TABLE/i.test(sql)) return null;
    return sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ');
}

// Mempool mirror. mempool_transactions is an append-style snapshot table (the
// platform refreshes it on an interval), deduped by its UNIQUE tx_hash.
// entries: [{ tx_hash, source, destination, amount, fee, data, raw_data }]
function buildMempoolWritePlan(entries) {
    const plan = [];
    for (const entry of entries || []) {
        if (!entry || !entry.tx_hash) continue;      // no hash -> no half row
        plan.push(insertSql('mempool_transactions', {
            tx_hash: String(entry.tx_hash),
            source: entry.source || null,
            destination: entry.destination || null,
            // Strings, not Number(): these are sompi amounts, and Number() silently rounds past
            // 2^53-1. The platform writes transaction_outputs.amount as a string for the same reason.
            amount: entry.amount === null || entry.amount === undefined ? null : String(entry.amount),
            fee: entry.fee === null || entry.fee === undefined ? '0' : String(entry.fee),
            data: entry.data === null || entry.data === undefined ? null : String(entry.data),
            raw_data: entry.raw_data || null,
        }, { upsert: true }));
    }
    return plan;
}

module.exports = {
    SCHEMA,
    insertSql,
    buildWritePlan,
    buildRollbackPlan,
    applyPlan,
    withTransaction,
    toIdempotent,
    buildMempoolWritePlan,
};
