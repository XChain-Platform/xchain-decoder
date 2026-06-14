/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * In-memory Database mock for benchmarks.
 *
 * Implements the same interface as src/db.js but stores everything in memory.
 * Tracks call counts for performance analysis.
 */

class MockDatabase {
    constructor() {
        this.blocks = new Map()
        this.lastBlockIndex = -1
        this.lastTxIndex = -1
        this._indexTxId = 1
        this._indexAddrId = 1
        this._txHashCache = new Map()
        this._addrCache = new Map()
        this._dispenserAddresses = new Set()
        this._mempoolTxHashes = new Map()

        this.callCounts = {
            insertBlock: 0,
            insertTransaction: 0,
            insertMempoolTransaction: 0,
            insertDispenser: 0,
            insertTransactionOutput: 0,
            beginTransaction: 0,
            commitTransaction: 0,
            endTransaction: 0,
            createTransaction: 0,
            createAddress: 0,
            isThereADispenserForAddress: 0,
            getAllOpenDispenserAddresses: 0,
            deleteOpenDispensers: 0,
            deleteAndCompareTxsNotInList: 0,
            getLastBlockIndex: 0,
            getLastTxIndex: 0,
            getBlockByIndex: 0
        }
    }

    _track(method) {
        this.callCounts[method] = (this.callCounts[method] || 0) + 1
    }

    async createDatabase() { return true }
    async verifyDatabase() { return true }
    async verifyTables() { return true }

    async getLastBlockIndex() {
        this._track('getLastBlockIndex')
        return this.lastBlockIndex
    }

    async getLastTxIndex() {
        this._track('getLastTxIndex')
        return this.lastTxIndex
    }

    async getBlockByIndex(blockIndex) {
        this._track('getBlockByIndex')
        return this.blocks.get(blockIndex) || null
    }

    async beginTransaction() {
        this._track('beginTransaction')
    }

    async commitTransaction() {
        this._track('commitTransaction')
        return true
    }

    async endTransaction() {
        this._track('endTransaction')
    }

    async insertBlock(block) {
        this._track('insertBlock')
        this.lastBlockIndex = block.block_index
        this.blocks.set(block.block_index, {
            block_index: block.block_index,
            block_hash: block.block_hash,
            block_time: block.block_time,
            previous_block_hash: block.previous_block_hash
        })
        return true
    }

    async insertTransaction(tx) {
        this._track('insertTransaction')
        this.lastTxIndex = tx.index
        return true
    }

    async insertMempoolTransaction(tx) {
        this._track('insertMempoolTransaction')
        return true
    }

    async insertDispenser(dispenser) {
        this._track('insertDispenser')
        return true
    }

    async insertTransactionOutput(output) {
        this._track('insertTransactionOutput')
        return true
    }

    async deleteOpenDispensers(minExpiration) {
        this._track('deleteOpenDispensers')
        return true
    }

    async isThereADispenserForAddress(address) {
        this._track('isThereADispenserForAddress')
        return this._dispenserAddresses.has(address)
    }

    async getAllOpenDispenserAddresses() {
        this._track('getAllOpenDispenserAddresses')
        return new Set(this._dispenserAddresses)
    }

    async createTransaction(hash) {
        this._track('createTransaction')
        if (hash == null || hash === '') return 1
        let id = this._txHashCache.get(hash)
        if (id == null) {
            id = ++this._indexTxId
            this._txHashCache.set(hash, id)
        }
        return id
    }

    async createAddress(address) {
        this._track('createAddress')
        if (address == null || address === '') return 1
        let id = this._addrCache.get(address)
        if (id == null) {
            id = ++this._indexAddrId
            this._addrCache.set(address, id)
        }
        return id
    }

    async getTransactionId(hash) {
        return this._txHashCache.get(hash) || null
    }

    async getAddressId(address) {
        return this._addrCache.get(address) || null
    }

    async insertEvent(code, data) {
        return true
    }

    async deleteBlockByIndex(blockIndex) {
        this.blocks.delete(blockIndex)
        if (blockIndex === this.lastBlockIndex) {
            this.lastBlockIndex = blockIndex - 1
        }
        return true
    }

    async deleteAndCompareTxsNotInList(txidList) {
        this._track('deleteAndCompareTxsNotInList')
        txidList.length = 0
        return { transactionsDeleted: 0 }
    }

    async getTransaction(txid) {
        return null
    }

    async dropDatabase() {}

    async getConnection() {
        return {
            query: async () => [],
            release: async () => {}
        }
    }

    async releaseConnection() {}

    resetCounts() {
        for (const key of Object.keys(this.callCounts)) {
            this.callCounts[key] = 0
        }
    }

    getTotalCalls() {
        let total = 0
        for (const v of Object.values(this.callCounts)) total += v
        return total
    }
}

module.exports = MockDatabase
