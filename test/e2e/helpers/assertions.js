/**
 * Assertion helpers for E2E tests.
 *
 * Extends the integration assertion helpers with dispenser lifecycle,
 * mempool, reorg event, and normalization integrity checks.
 */

const assert = require('assert')

/**
 * Run the exact JOIN query the indexer's getDecoderBlockData() uses.
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
        assert.strictEqual(row.block_index, expected.block_index, 'block_index mismatch')
    if (expected.block_time_gt !== undefined)
        assert.ok(row.block_time > expected.block_time_gt, 'block_time should be > ' + expected.block_time_gt)
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
 * Assert a dispenser record exists for the given address.
 */
async function assertDispenserExists(db, address) {
    const dispensers = await getDispensersForAddress(db, address)
    assert.ok(dispensers.length > 0, `Dispenser should exist for address ${address}`)
    return dispensers
}

/**
 * Assert NO dispenser record exists for the given address.
 */
async function assertDispenserNotExists(db, address) {
    const dispensers = await getDispensersForAddress(db, address)
    assert.strictEqual(dispensers.length, 0, `No dispenser should exist for address ${address}`)
}

/**
 * Query the transaction_outputs table for a given tx_index.
 */
async function getTransactionOutputs(db, txHash) {
    const connection = await db.pool.getConnection()
    try {
        const query = `
            SELECT tout.*, ia.address AS destination_address
            FROM transaction_outputs tout
            INNER JOIN transactions t ON t.tx_index = tout.tx_index
            INNER JOIN index_transactions it ON it.id = t.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tout.destination_id
            WHERE it.hash = ?
        `
        return await connection.query(query, [txHash])
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

/**
 * Assert a REORG event exists in the events table.
 */
async function assertReorgEvent(db) {
    const events = await getReorgEvents(db)
    assert.ok(events.length > 0, 'At least one REORG event should exist')
    return events[0]
}

/**
 * Query the mempool_transactions table for a specific tx.
 */
async function getMempoolTransaction(db, txHash) {
    const connection = await db.pool.getConnection()
    try {
        const rows = await connection.query(
            `SELECT mpt.*, it.hash AS tx_hash, ia.address AS source
             FROM mempool_transactions mpt
             LEFT JOIN index_transactions it ON it.id = mpt.tx_hash_id
             LEFT JOIN index_addresses ia ON ia.id = mpt.source_id
             WHERE it.hash = ?`,
            [txHash]
        )
        return rows.length > 0 ? rows[0] : null
    } finally {
        await connection.release()
    }
}

/**
 * Assert a mempool transaction exists.
 */
async function assertMempoolTransaction(db, txHash) {
    const tx = await getMempoolTransaction(db, txHash)
    assert.ok(tx, `Mempool transaction ${txHash} should exist`)
    return tx
}

/**
 * Assert a mempool transaction does NOT exist.
 */
async function assertNoMempoolTransaction(db, txHash) {
    const tx = await getMempoolTransaction(db, txHash)
    assert.strictEqual(tx, null, `Mempool transaction ${txHash} should NOT exist`)
}

/**
 * Verify normalization table integrity:
 * - Every source_id in transactions has a matching index_addresses row
 * - Every tx_hash_id in transactions has a matching index_transactions row
 */
async function assertNormalizationIntegrity(db) {
    const connection = await db.pool.getConnection()
    try {
        // Check for orphaned source_ids
        const orphanedSources = await connection.query(`
            SELECT t.tx_index, t.source_id
            FROM transactions t
            LEFT JOIN index_addresses ia ON ia.id = t.source_id
            WHERE t.source_id > 1 AND ia.id IS NULL
        `)
        assert.strictEqual(
            orphanedSources.length, 0,
            `Found ${orphanedSources.length} transactions with orphaned source_id`
        )

        // Check for orphaned tx_hash_ids
        const orphanedTxHashes = await connection.query(`
            SELECT t.tx_index, t.tx_hash_id
            FROM transactions t
            LEFT JOIN index_transactions it ON it.id = t.tx_hash_id
            WHERE t.tx_hash_id > 1 AND it.id IS NULL
        `)
        assert.strictEqual(
            orphanedTxHashes.length, 0,
            `Found ${orphanedTxHashes.length} transactions with orphaned tx_hash_id`
        )

        // Check for orphaned block_hash_ids in blocks table
        const orphanedBlockHashes = await connection.query(`
            SELECT b.block_index, b.block_hash_id
            FROM blocks b
            LEFT JOIN index_transactions it ON it.id = b.block_hash_id
            WHERE b.block_hash_id > 1 AND it.id IS NULL
        `)
        assert.strictEqual(
            orphanedBlockHashes.length, 0,
            `Found ${orphanedBlockHashes.length} blocks with orphaned block_hash_id`
        )
    } finally {
        await connection.release()
    }
}

/**
 * Assert a block exists in the blocks table at the given index.
 */
async function assertBlockExists(db, blockIndex) {
    const block = await db.getBlockByIndex(blockIndex)
    assert.ok(block, `Block ${blockIndex} should exist in blocks table`)
    return block
}

/**
 * Assert a block does NOT exist in the blocks table.
 */
async function assertBlockNotExists(db, blockIndex) {
    const block = await db.getBlockByIndex(blockIndex)
    assert.strictEqual(block, null, `Block ${blockIndex} should NOT exist in blocks table`)
}

module.exports = {
    getDecoderBlockData,
    assertTransaction,
    assertNoTransaction,
    assertRowFields,
    assertBlockDataCount,
    getDispensersForAddress,
    assertDispenserExists,
    assertDispenserNotExists,
    getTransactionOutputs,
    getReorgEvents,
    assertReorgEvent,
    getMempoolTransaction,
    assertMempoolTransaction,
    assertNoMempoolTransaction,
    assertNormalizationIntegrity,
    assertBlockExists,
    assertBlockNotExists
}
