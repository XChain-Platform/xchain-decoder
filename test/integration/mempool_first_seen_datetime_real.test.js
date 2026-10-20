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

const assert = require('assert')
const mariadb = require('mariadb')
const Database = require('../../src/db.js')
const {
    agedModifySql,
    dbTarget,
    readAtZone,
    snapshotColumnShape,
    zoneReadSql
} = require('./helpers/datetime_readback.js')

const MIGRATION = '2026-09-27-mempool-first-seen-datetime.sql'
const OBSERVED_AT = '2026-01-15 12:34:56'
// A prefix keeps a shared venue's databases apart; CI's own fixture needs none.
const PREFIX = process.env.XCHAIN_TEST_DB_NAME_PREFIX || ''
const AGED_DB = PREFIX + 'xchain_decoder_first_seen_datetime_aged'
const FRESH_DB = PREFIX + 'xchain_decoder_first_seen_datetime_fresh'
const SEEDED_DB = PREFIX + 'xchain_decoder_first_seen_datetime_seeded'
const target = dbTarget()
// Both stored times read back six hours early in a -06:00 session, and as observed once retyped
const SHIFTED_SIX_HOURS = { firstSeen: '2026-01-15 06:34:56', appliedAt: '2026-01-15 06:34:56' }
const AS_OBSERVED = { firstSeen: OBSERVED_AT, appliedAt: OBSERVED_AT }

function makeDatabase(name) {
    return new Database(target.host, target.port, name, target.user, target.password)
}

async function withPoolConnection(db, action) {
    const conn = await db.getConnection()
    try {
        return await action(conn)
    } finally {
        await conn.release()
    }
}

async function withRawConnection(name, action) {
    const conn = await mariadb.createConnection({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: name
    })
    try {
        return await action(conn)
    } finally {
        await conn.end()
    }
}

async function readColumnShape(db, table, column) {
    return withPoolConnection(db, conn => snapshotColumnShape(
        conn.query.bind(conn), db.dbName, table, column
    ))
}

async function readMigrationShapes(db) {
    return {
        firstSeen: await readColumnShape(db, 'mempool_transactions', 'first_seen'),
        appliedAt: await readColumnShape(db, 'schema_migrations', 'applied_at')
    }
}

async function readStoredTimes(name, zone) {
    return withRawConnection(name, async conn => ({
        firstSeen: await readAtZone(
            conn, zone, zoneReadSql('mempool_transactions', 'first_seen')
        ),
        appliedAt: await readAtZone(
            conn, zone, zoneReadSql('schema_migrations', 'applied_at')
        )
    }))
}

// Build the tables the way a release without the fresh-install ledger seed did: no ledger rows.
async function buildWithoutSeed(db) {
    db.recordFreshSchemaMigrations = async () => {}
    await db.verifyTables()
}

async function prepareAgedDatabase(db) {
    await db.createDatabase()
    await buildWithoutSeed(db)
    await withPoolConnection(db, async conn => {
        await conn.query(agedModifySql('mempool_transactions', 'first_seen'))
        await db.ensureMigrationsLedger(conn)
        await conn.query(agedModifySql('schema_migrations', 'applied_at'))
        await conn.query(
            'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, ?)',
            ['2026-01-01-earlier-rehearsal.sql', '0'.repeat(64), 'manual', OBSERVED_AT]
        )
    })
    await withRawConnection(db.dbName, async conn => {
        await conn.query("SET time_zone = '+00:00'")
        await conn.query(
            'INSERT INTO mempool_transactions (tx_hash, first_seen) VALUES (?, ?)',
            ['datetime-rehearsal', OBSERVED_AT]
        )
    })
}

// The ledger names recorded for MIGRATION
async function recordedMigrationNames(db) {
    const rows = await withPoolConnection(db, conn => conn.query(
        'SELECT name FROM schema_migrations WHERE name = ?', [MIGRATION]
    ))
    return rows.map(row => row.name)
}

// Run MIGRATION alone and read the first_seen definition on either side of it
async function targetedFirstSeenRun(db) {
    const beforeShape = await readColumnShape(db, 'mempool_transactions', 'first_seen')
    const result = await db.runMigrations({ includeManual: true, only: [MIGRATION] })
    const afterShape = await readColumnShape(db, 'mempool_transactions', 'first_seen')
    return { result, beforeShape, afterShape }
}

async function dropDatabases(databases) {
    for (const db of databases) {
        if (db) await db.close()
    }
    const conn = await mariadb.createConnection({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password
    })
    try {
        await conn.query('DROP DATABASE IF EXISTS `' + AGED_DB + '`')
        await conn.query('DROP DATABASE IF EXISTS `' + FRESH_DB + '`')
        await conn.query('DROP DATABASE IF EXISTS `' + SEEDED_DB + '`')
    } finally {
        await conn.end()
    }
}

describe('mempool first_seen DATETIME migration on MariaDB', function () {
    this.timeout(180000)
    let agedDb
    let freshDb
    let seededDb
    let migratedShapes
    before(async function () {
        agedDb = makeDatabase(AGED_DB)
        await prepareAgedDatabase(agedDb)
    })
    after(async function () {
        await dropDatabases([agedDb, freshDb, seededDb])
    })
    it('reproduces session-dependent reads on the aged TIMESTAMP columns', async function () {
        assert.deepStrictEqual(await readStoredTimes(AGED_DB, '-06:00'), SHIFTED_SIX_HOURS)
    })
    it('retypes the observation and ledger columns without shifting their values', async function () {
        const result = await agedDb.runMigrations({ includeManual: true, only: [MIGRATION] })
        assert.ok(result.applied.includes(MIGRATION))
        migratedShapes = await readMigrationShapes(agedDb)
        assert.strictEqual(migratedShapes.firstSeen.DATA_TYPE, 'datetime')
        assert.strictEqual(migratedShapes.appliedAt.DATA_TYPE, 'datetime')
        assert.deepStrictEqual(await readStoredTimes(AGED_DB, '-06:00'), AS_OBSERVED)
    })
    it('leaves both migrated column definitions unchanged on a targeted rerun', async function () {
        const beforeShapes = await readMigrationShapes(agedDb)
        const result = await agedDb.runMigrations({ includeManual: true, only: [MIGRATION] })
        const afterShapes = await readMigrationShapes(agedDb)
        assert.ok(!result.applied.includes(MIGRATION))
        assert.deepStrictEqual(afterShapes, beforeShapes)
    })
    // A schema an earlier release built from src/sql carries no ledger row, so the precondition baselines it.
    it('baselines a fresh schema and preserves its matching first_seen definition', async function () {
        freshDb = makeDatabase(FRESH_DB)
        await freshDb.createDatabase()
        await buildWithoutSeed(freshDb)
        const { result, beforeShape, afterShape } = await targetedFirstSeenRun(freshDb)
        const recorded = await recordedMigrationNames(freshDb)
        assert.ok(result.baselined.includes(MIGRATION))
        assert.deepStrictEqual(recorded, [MIGRATION])
        assert.deepStrictEqual(afterShape, beforeShape)
        assert.deepStrictEqual(afterShape, migratedShapes.firstSeen)
    })
    // This release records every committed migration while building from empty, so nothing is left to run.
    it('records the migration when it builds the schema from empty, with first_seen already at its migrated definition', async function () {
        seededDb = makeDatabase(SEEDED_DB)
        await seededDb.createDatabase()
        await seededDb.verifyTables()
        assert.deepStrictEqual(await recordedMigrationNames(seededDb), [MIGRATION])
        const { result, beforeShape, afterShape } = await targetedFirstSeenRun(seededDb)
        assert.ok(!result.applied.includes(MIGRATION))
        assert.ok(!result.baselined.includes(MIGRATION))
        assert.deepStrictEqual(afterShape, beforeShape)
        assert.deepStrictEqual(afterShape, migratedShapes.firstSeen)
    })
})
