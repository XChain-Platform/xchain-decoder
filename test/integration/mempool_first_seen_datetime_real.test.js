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
const AGED_DB = 'xchain_decoder_first_seen_datetime_aged'
const FRESH_DB = 'xchain_decoder_first_seen_datetime_fresh'
const target = dbTarget()

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

async function prepareAgedDatabase(db) {
    await db.createDatabase()
    await db.verifyTables()
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
    } finally {
        await conn.end()
    }
}

describe('mempool first_seen DATETIME migration on MariaDB', function () {
    this.timeout(180000)

    let agedDb
    let freshDb
    let migratedShapes

    before(async function () {
        agedDb = makeDatabase(AGED_DB)
        await prepareAgedDatabase(agedDb)
    })

    after(async function () {
        await dropDatabases([agedDb, freshDb])
    })

    it('reproduces session-dependent reads on the aged TIMESTAMP columns', async function () {
        const values = await readStoredTimes(AGED_DB, '-06:00')
        assert.deepStrictEqual(values, {
            firstSeen: '2026-01-15 06:34:56',
            appliedAt: '2026-01-15 06:34:56'
        })
    })

    it('retypes the observation and ledger columns without shifting their values', async function () {
        const result = await agedDb.runMigrations({ includeManual: true, only: [MIGRATION] })
        assert.ok(result.applied.includes(MIGRATION))

        migratedShapes = await readMigrationShapes(agedDb)
        assert.strictEqual(migratedShapes.firstSeen.DATA_TYPE, 'datetime')
        assert.strictEqual(migratedShapes.appliedAt.DATA_TYPE, 'datetime')
        assert.deepStrictEqual(await readStoredTimes(AGED_DB, '-06:00'), {
            firstSeen: OBSERVED_AT,
            appliedAt: OBSERVED_AT
        })
    })

    it('leaves both migrated column definitions unchanged on a targeted rerun', async function () {
        const beforeShapes = await readMigrationShapes(agedDb)
        const result = await agedDb.runMigrations({ includeManual: true, only: [MIGRATION] })
        const afterShapes = await readMigrationShapes(agedDb)

        assert.ok(!result.applied.includes(MIGRATION))
        assert.deepStrictEqual(afterShapes, beforeShapes)
    })

    it('baselines a fresh schema and preserves its matching first_seen definition', async function () {
        freshDb = makeDatabase(FRESH_DB)
        await freshDb.createDatabase()
        await freshDb.verifyTables()
        const beforeShape = await readColumnShape(freshDb, 'mempool_transactions', 'first_seen')

        const result = await freshDb.runMigrations({ includeManual: true, only: [MIGRATION] })
        const afterShape = await readColumnShape(freshDb, 'mempool_transactions', 'first_seen')
        const recorded = await withPoolConnection(freshDb, conn => conn.query(
            'SELECT name FROM schema_migrations WHERE name = ?', [MIGRATION]
        ))

        assert.ok(result.baselined.includes(MIGRATION))
        assert.deepStrictEqual(recorded.map(row => row.name), [MIGRATION])
        assert.deepStrictEqual(afterShape, beforeShape)
        assert.deepStrictEqual(afterShape, migratedShapes.firstSeen)
    })
})
