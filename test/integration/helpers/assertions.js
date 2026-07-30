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
 **********************************************************************
 * Assertion helpers for integration tests.
 *
 * Runs the exact SQL queries the indexer uses to read the decoder DB,
 * and provides assertion wrappers for common checks.
 */

const assert = require('assert')

/**
 * Run the exact JOIN query the indexer's getDecoderBlockData() uses.
 * Returns an array of row objects with: data, tx_hash, source, destination,
 * amount, block_index, block_time, vout, output_amount, output_destination.
 */
async function getDecoderBlockData(db, blockIndex) {
    const connection = await db.pool.getConnection()
    try {
        const query = `
            SELECT t1.data, t2.hash as tx_hash,
                   a1.address as source, a2.address as destination,
                   t1.amount, t1.block_index, b1.block_time,
                   t3.vout, t3.amount as output_amount,
                   a3.address as output_destination
            FROM transactions t1
            INNER JOIN blocks b1 ON (b1.block_index = t1.block_index)
            INNER JOIN index_transactions t2 ON (t2.id = t1.tx_hash_id)
            LEFT JOIN  transaction_outputs t3 ON (t3.tx_index = t1.tx_index)
            LEFT JOIN  index_addresses a1 ON (a1.id = t1.source_id)
            LEFT JOIN  index_addresses a2 ON (a2.id = t1.destination_id)
            LEFT JOIN  index_addresses a3 ON (a3.id = t3.destination_id)
            WHERE t1.block_index = ?
        `
        return await connection.query(query, [blockIndex])
    } finally {
        await connection.release()
    }
}

/**
 * Assert that a transaction exists in the decoder DB with expected fields.
 */
async function assertTransaction(db, txHash, expected) {
    const tx = await db.getTransaction(txHash)
    assert.ok(tx, `Transaction ${txHash} should exist in decoder DB`)

    if (expected.source !== undefined) {
        assert.strictEqual(tx.source, expected.source, `source mismatch for tx ${txHash}`)
    }
    if (expected.data !== undefined) {
        assert.strictEqual(tx.data, expected.data, `data mismatch for tx ${txHash}`)
    }
    if (expected.dataStartsWith !== undefined) {
        assert.ok(
            tx.data && tx.data.startsWith(expected.dataStartsWith),
            `Expected data to start with "${expected.dataStartsWith}", got "${tx.data && tx.data.substring(0, 40)}..."`
        )
    }
    return tx
}

/**
 * Assert that a transaction does NOT exist in the decoder DB.
 */
async function assertNoTransaction(db, txHash) {
    const tx = await db.getTransaction(txHash)
    assert.strictEqual(tx, null, `Transaction ${txHash} should NOT exist in decoder DB`)
}

/**
 * Assert the indexer contract query returns the expected number of rows for a block.
 */
async function assertBlockDataCount(db, blockIndex, expectedCount) {
    const rows = await getDecoderBlockData(db, blockIndex)
    assert.strictEqual(
        rows.length, expectedCount,
        `Expected ${expectedCount} rows from getDecoderBlockData(${blockIndex}), got ${rows.length}`
    )
    return rows
}

/**
 * Assert a specific row from getDecoderBlockData matches expected fields.
 */
function assertRowFields(row, expected) {
    if (expected.data !== undefined)
        assert.strictEqual(row.data, expected.data, 'data mismatch')
    if (expected.dataStartsWith !== undefined)
        assert.ok(row.data && row.data.startsWith(expected.dataStartsWith), `data should start with "${expected.dataStartsWith}"`)
    if (expected.tx_hash !== undefined)
        assert.strictEqual(row.tx_hash, expected.tx_hash, 'tx_hash mismatch')
    if (expected.source !== undefined)
        assert.strictEqual(row.source, expected.source, 'source mismatch')
    if (expected.block_index !== undefined)
        // block_index is a BIGINT column and the mariadb driver hands those back as
        // BigInt, so compare the value rather than its JS representation.
        assert.strictEqual(Number(row.block_index), expected.block_index, 'block_index mismatch')
    if (expected.block_time_gt !== undefined)
        assert.ok(row.block_time > expected.block_time_gt, 'block_time should be > ' + expected.block_time_gt)
}

/**
 * Query the dispensers table for a given address.
 */
async function getDispensersForAddress(db, address) {
    const connection = await db.pool.getConnection()
    try {
        const query = `
            SELECT d.*, ia.address
            FROM dispensers d
            LEFT JOIN index_addresses ia ON ia.id = d.address_id
            WHERE ia.address = ?
        `
        return await connection.query(query, [address])
    } finally {
        await connection.release()
    }
}

/**
 * Query the events table for REORG events.
 */
async function getReorgEvents(db) {
    const connection = await db.pool.getConnection()
    try {
        const query = `SELECT * FROM events WHERE code = 'REORG' ORDER BY id DESC`
        return await connection.query(query)
    } finally {
        await connection.release()
    }
}

module.exports = {
    getDecoderBlockData,
    assertTransaction,
    assertNoTransaction,
    assertBlockDataCount,
    assertRowFields,
    getDispensersForAddress,
    getReorgEvents
}
