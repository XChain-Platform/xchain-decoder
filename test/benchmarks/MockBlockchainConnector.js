/**
 * Mock BlockchainConnector for benchmarks.
 *
 * Stores pre-generated blocks and transactions in memory and serves them
 * instantly (or with configurable artificial latency) when queried.
 */

class MockBlockchainConnector {
    constructor() {
        this.blockHashes = new Map()    // height -> hash
        this.blockData = new Map()      // hash -> hex
        this.transactions = new Map()   // txid -> hex
        this.mempoolTxIds = []
        this.totalBlocks = 0
        this.latencyMs = 0

        this.callCounts = {
            getBlockchainInfo: 0,
            getBlockHash: 0,
            getBlock: 0,
            getRawTransaction: 0,
            getRawMempool: 0,
            getRawTransactions: 0,
            getBlockHeader: 0,
            getBlockWithoutAuxPow: 0
        }
    }

    async _delay() {
        if (this.latencyMs > 0) {
            await new Promise(r => setTimeout(r, this.latencyMs))
        }
    }

    loadBlocks(blocks) {
        for (const block of blocks) {
            this.blockHashes.set(block.height, block.blockHash)
            this.blockData.set(block.blockHash, block.blockHex)
            for (const [txid, hex] of block.fundingTxStore) {
                this.transactions.set(txid, hex)
            }
        }
        this.totalBlocks = Math.max(this.totalBlocks, ...blocks.map(b => b.height))
    }

    loadMempoolTxs(txEntries) {
        for (const entry of txEntries) {
            this.mempoolTxIds.push(entry.txId)
            this.transactions.set(entry.txId, entry.txHex)
            if (entry.fundingTxId && entry.fundingTxHex) {
                this.transactions.set(entry.fundingTxId, entry.fundingTxHex)
            }
        }
        this.mempoolTxIds.sort()
    }

    async getBlockchainInfo() {
        this.callCounts.getBlockchainInfo++
        await this._delay()
        return { blocks: this.totalBlocks, verificationprogress: 1.0 }
    }

    async getBlockHash(blockIndex) {
        this.callCounts.getBlockHash++
        await this._delay()
        const hash = this.blockHashes.get(blockIndex)
        if (!hash) throw new Error(`Mock: no block at height ${blockIndex}`)
        return hash
    }

    async getBlock(blockhash) {
        this.callCounts.getBlock++
        await this._delay()
        const hex = this.blockData.get(blockhash)
        if (!hex) throw new Error(`Mock: no block with hash ${blockhash}`)
        return hex
    }

    async getBlockHeader(blockhash) {
        this.callCounts.getBlockHeader++
        await this._delay()
        const hex = this.blockData.get(blockhash)
        if (!hex) throw new Error(`Mock: no block with hash ${blockhash}`)
        return hex.substring(0, 160)
    }

    async getBlockWithoutAuxPow(blockhash) {
        this.callCounts.getBlockWithoutAuxPow++
        return this.getBlock(blockhash)
    }

    async getRawTransaction(txid) {
        this.callCounts.getRawTransaction++
        await this._delay()
        const hex = this.transactions.get(txid)
        if (!hex) throw new Error(`Mock: no transaction ${txid}`)
        return hex
    }

    async getRawTransactions(txIdArray) {
        this.callCounts.getRawTransactions++
        return Promise.all(txIdArray.map(id => this.getRawTransaction(id)))
    }

    async getRawMempool() {
        this.callCounts.getRawMempool++
        await this._delay()
        return [...this.mempoolTxIds]
    }

    async getNetworkInfo() {
        return { version: 250000, subversion: '/MockNode:0.1/', protocolversion: 70016 }
    }

    resetCounts() {
        for (const key of Object.keys(this.callCounts)) {
            this.callCounts[key] = 0
        }
    }
}

module.exports = MockBlockchainConnector
