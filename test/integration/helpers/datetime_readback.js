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

const fixturePorts = require('../../../bin/fixture-ports.js')

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_]+$/
const ZONE_PATTERN = /^[+-][0-9]{2}:[0-9]{2}$/
const AGED_TIMESTAMP_DEF = 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
const COLUMN_SHAPE_SQL =
    'SELECT DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA ' +
    'FROM information_schema.columns ' +
    'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'

function identifier(value) {
    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
        throw new Error('invalid SQL identifier')
    }
    return '`' + value + '`'
}

function dbTarget(env = process.env) {
    return {
        host: env.XCHAIN_TEST_DB_HOST || '127.0.0.1',
        port: Number(fixturePorts.port('XCHAIN_TEST_DB_PORT', env)),
        user: env.XCHAIN_TEST_DB_USER || 'root',
        password: env.XCHAIN_TEST_DB_PASS || 'itfixture'
    }
}

function agedModifySql(table, column) {
    return 'ALTER TABLE ' + identifier(table) + ' MODIFY ' + identifier(column) +
        ' ' + AGED_TIMESTAMP_DEF
}

function zoneReadSql(table, column) {
    return 'SELECT DATE_FORMAT(' + identifier(column) +
        ", '%Y-%m-%d %H:%i:%s') AS v FROM " + identifier(table)
}

async function readAtZone(conn, zone, sql, params) {
    if (typeof zone !== 'string' || !ZONE_PATTERN.test(zone)) {
        throw new Error('invalid time zone offset')
    }
    await conn.query('SET time_zone = ?', [zone])
    const rows = await conn.query(sql, params)
    return rows[0].v
}

async function snapshotColumnShape(query, dbName, table, column) {
    const rows = await query(COLUMN_SHAPE_SQL, [dbName, table, column])
    if (!rows[0]) throw new Error('column not found')
    const { DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA } = rows[0]
    return { DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA }
}

module.exports = {
    dbTarget,
    AGED_TIMESTAMP_DEF,
    agedModifySql,
    zoneReadSql,
    readAtZone,
    COLUMN_SHAPE_SQL,
    snapshotColumnShape
}
