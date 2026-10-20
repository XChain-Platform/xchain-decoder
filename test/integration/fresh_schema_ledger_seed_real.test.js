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
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const mariadb = require('mariadb')
const Database = require('../../src/db.js')
const { dbTarget } = require('./helpers/datetime_readback.js')

const MIGRATIONS_DIR = path.join(__dirname, '../../src/sql/migrations')
// A prefix keeps a shared venue's databases apart; CI's own fixture needs none.
const PREFIX = process.env.XCHAIN_TEST_DB_NAME_PREFIX || ''
const FRESH_DB = PREFIX + 'xchain_decoder_ledger_seed_fresh'
const AGED_DB = PREFIX + 'xchain_decoder_ledger_seed_aged'
const target = dbTarget()

function committedMigrations() {
    return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort().map(name => {
        const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8')
        return { name, checksum: crypto.createHash('sha256').update(raw).digest('hex'), mode: Database.prototype.migrationMode(raw) }
    })
}

async function withRaw(action) {
    const conn = await mariadb.createConnection({
        host: target.host, port: target.port, user: target.user, password: target.password
    })
    try {
        return await action(conn)
    } finally {
        await conn.end()
    }
}

async function ledger(name) {
    return withRaw(async conn => {
        const present = await conn.query(
            "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'schema_migrations'", [name])
        if (Number(present[0].n) === 0) return null
        const rows = await conn.query('SELECT name, checksum, mode, applied_at FROM `' + name + '`.schema_migrations ORDER BY name')
        return rows.map(r => ({ name: r.name, checksum: r.checksum, mode: r.mode, appliedAt: String(r.applied_at) }))
    })
}

// The live schema minus the ledger. Foreign keys compare by what they bind, not by name:
// MariaDB 12 names an inline key `1` where 10.11 names it pubkeys_ibfk_1.
async function schemaShape(name) {
    return withRaw(async conn => {
        const tables = await conn.query(
            "SELECT TABLE_NAME AS t, ENGINE AS e, TABLE_COLLATION AS co FROM information_schema.TABLES " +
            "WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY 1", [name])
        const columns = await conn.query(
            'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, ORDINAL_POSITION AS o, COLUMN_TYPE AS ty, IS_NULLABLE AS n, ' +
            'COLUMN_DEFAULT AS d, EXTRA AS x, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS co FROM information_schema.COLUMNS ' +
            "WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY 1, 3", [name])
        const indexes = await conn.query(
            'SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS u, SEQ_IN_INDEX AS s, COLUMN_NAME AS c, SUB_PART AS p ' +
            "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations' ORDER BY 1, 2, 4", [name])
        const keys = await conn.query(
            'SELECT DISTINCT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS r, REFERENCED_COLUMN_NAME AS rc ' +
            'FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY 1, 2', [name])
        return JSON.parse(JSON.stringify({ tables, columns, indexes, keys }, (k, v) => (typeof v === 'bigint' ? String(v) : v)))
    })
}

async function boot(db) {
    await db.createDatabase()
    assert.strictEqual(await db.verifyTables(), true)
    return db.runMigrations()
}

describe('fresh decoder database records its migrations before creating tables', function () {
    this.timeout(180000)
    let fresh
    let aged

    before(async function () {
        await withRaw(async conn => {
            await conn.query('DROP DATABASE IF EXISTS `' + FRESH_DB + '`')
            await conn.query('DROP DATABASE IF EXISTS `' + AGED_DB + '`')
        })
        fresh = new Database(target.host, target.port, FRESH_DB, target.user, target.password)
        aged = new Database(target.host, target.port, AGED_DB, target.user, target.password)
    })

    after(async function () {
        for (const db of [fresh, aged]) if (db) await db.close()
        await withRaw(async conn => {
            await conn.query('DROP DATABASE IF EXISTS `' + FRESH_DB + '`')
            await conn.query('DROP DATABASE IF EXISTS `' + AGED_DB + '`')
        })
    })

    it('records every committed migration with the runner checksum and mode, and replays none', async function () {
        const result = await boot(fresh)
        const rows = await ledger(FRESH_DB)
        assert.deepStrictEqual(rows.map(({ name, checksum, mode }) => ({ name, checksum, mode })), committedMigrations())
        assert.deepStrictEqual(result.applied, [])
        assert.deepStrictEqual(result.pending, [])
        assert.deepStrictEqual(result.baselined, [])
    })

    it('leaves the ledger exactly as it was across a second boot', async function () {
        const before = await ledger(FRESH_DB)
        const result = await boot(fresh)
        assert.deepStrictEqual(await ledger(FRESH_DB), before)
        assert.deepStrictEqual([result.applied, result.pending, result.baselined], [[], [], []])
    })

    it('seeds nothing on a database that already holds a declared table', async function () {
        await aged.createDatabase()
        await aged.createTable('events.sql')
        assert.strictEqual(await aged.verifyTables(), true)
        assert.strictEqual(await ledger(AGED_DB), null)
    })

    // What makes the seed true: every committed migration, run for real on the unseeded
    // database, leaves the schema a fresh build already has.
    it('matches the schema a full migration run produces on an unseeded build', async function () {
        await aged.runMigrations({ includeManual: true })
        assert.deepStrictEqual(await schemaShape(AGED_DB), await schemaShape(FRESH_DB))
    })
})
