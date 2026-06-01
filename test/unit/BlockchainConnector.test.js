const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const BlockchainConnector = require('../../src/BlockchainConnector')

describe('BlockchainConnector', () => {
    let connector
    let axiosStub

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'testuser', 'testpass')
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('constructor', () => {
        it('should construct the URL from host and port', () => {
            assert.strictEqual(connector.url, 'http://127.0.0.1:8332')
        })

        it('should store rpc credentials', () => {
            assert.strictEqual(connector.rpcUser, 'testuser')
            assert.strictEqual(connector.rpcPassword, 'testpass')
        })
    })

    describe('#getBlockchainInfo()', () => {
        it('[REGRESSION P2] R-RPC-001: should return the result on success', async () => {
            const mockResult = { blocks: 100, verificationprogress: 1.0 }
            axiosStub.resolves({ data: { result: mockResult } })

            const result = await connector.getBlockchainInfo()
            assert.deepStrictEqual(result, mockResult)
        })

        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })

            await assert.rejects(
                () => connector.getBlockchainInfo(),
                { message: 'Error getting blockchain info' }
            )
        })

        it('should send correct JSON-RPC method', async () => {
            axiosStub.resolves({ data: { result: {} } })
            await connector.getBlockchainInfo()

            const callData = axiosStub.firstCall.args[1]
            assert.strictEqual(callData.method, 'getblockchaininfo')
            assert.strictEqual(callData.jsonrpc, '2.0')
        })

        it('should use auth credentials', async () => {
            axiosStub.resolves({ data: { result: {} } })
            await connector.getBlockchainInfo()

            const callConfig = axiosStub.firstCall.args[2]
            assert.strictEqual(callConfig.auth.username, 'testuser')
            assert.strictEqual(callConfig.auth.password, 'testpass')
        })
    })

    describe('#getNetworkInfo()', () => {
        it('should return the result on success', async () => {
            const mockResult = { version: 210000 }
            axiosStub.resolves({ data: { result: mockResult } })

            const result = await connector.getNetworkInfo()
            assert.deepStrictEqual(result, mockResult)
        })

        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })

            await assert.rejects(
                () => connector.getNetworkInfo(),
                { message: 'Error getting network info' }
            )
        })
    })

    describe('#getBlockHash()', () => {
        it('should return the block hash on success', async () => {
            axiosStub.resolves({ data: { result: 'abcdef1234' } })

            const result = await connector.getBlockHash(100)
            assert.strictEqual(result, 'abcdef1234')
        })

        it('should pass the block index as params', async () => {
            axiosStub.resolves({ data: { result: 'hash' } })
            await connector.getBlockHash(42)

            const callData = axiosStub.firstCall.args[1]
            assert.deepStrictEqual(callData.params, [42])
        })

        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })

            await assert.rejects(() => connector.getBlockHash(0))
        })

        it('should propagate network errors', async () => {
            axiosStub.rejects(new Error('ECONNREFUSED'))

            await assert.rejects(
                () => connector.getBlockHash(0),
                { message: 'ECONNREFUSED' }
            )
        })
    })

    describe('#getBlock()', () => {
        it('should return block hex on success', async () => {
            axiosStub.resolves({ data: { result: 'deadbeef' } })

            const result = await connector.getBlock('somehash')
            assert.strictEqual(result, 'deadbeef')
        })

        it('should request raw hex format by default (hexFormat=true means verbose=false)', async () => {
            axiosStub.resolves({ data: { result: 'hex' } })
            await connector.getBlock('hash', true)

            const callData = axiosStub.firstCall.args[1]
            // hexFormat=true means we pass !hexFormat=false as the verbose param
            assert.deepStrictEqual(callData.params, ['hash', false])
        })

        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })
            await assert.rejects(() => connector.getBlock('hash'))
        })
    })

    describe('#getBlockHeader()', () => {
        it('should return block header on success', async () => {
            axiosStub.resolves({ data: { result: 'headerdata' } })

            const result = await connector.getBlockHeader('blockhash')
            assert.strictEqual(result, 'headerdata')
        })

        it('[REGRESSION P2] R-RPC-001: should retry on timeout (ECONNABORTED)', async () => {
            const timeoutError = new Error('timeout')
            timeoutError.code = 'ECONNABORTED'

            // Fail 2 times, succeed on 3rd
            axiosStub.onCall(0).rejects(timeoutError)
            axiosStub.onCall(1).rejects(timeoutError)
            axiosStub.onCall(2).resolves({ data: { result: 'headerdata' } })

            const result = await connector.getBlockHeader('hash')
            assert.strictEqual(result, 'headerdata')
            assert.strictEqual(axiosStub.callCount, 3)
        })

        it('should throw immediately on non-timeout errors', async () => {
            const otherError = new Error('auth failed')
            otherError.code = 'ERR_BAD_REQUEST'

            axiosStub.rejects(otherError)

            await assert.rejects(
                () => connector.getBlockHeader('hash'),
                { message: 'auth failed' }
            )
            assert.strictEqual(axiosStub.callCount, 1)
        })

        it('[REGRESSION P2] R-RPC-001: should throw after exhausting all 10 timeout retries', async () => {
            const timeoutError = new Error('timeout')
            timeoutError.code = 'ECONNABORTED'
            axiosStub.rejects(timeoutError)

            await assert.rejects(
                () => connector.getBlockHeader('hash'),
                { message: /problems getting a block hex/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        })
    })

    describe('#getRawMempool()', () => {
        it('should return mempool txids on success', async () => {
            const txids = ['tx1', 'tx2', 'tx3']
            axiosStub.resolves({ data: { result: txids } })

            const result = await connector.getRawMempool()
            assert.deepStrictEqual(result, txids)
        })

        it('should throw when response has no result', async () => {
            axiosStub.resolves({ data: { result: null } })
            await assert.rejects(() => connector.getRawMempool())
        })
    })

    describe('#getRawTransaction()', () => {
        it('should return raw tx hex on success', async () => {
            axiosStub.resolves({ data: { result: 'rawtxhex' } })

            const result = await connector.getRawTransaction('txid123')
            assert.strictEqual(result, 'rawtxhex')
        })

        it('should resolve null when response has no result (tx mined/evicted)', async () => {
            // A mempool tx can be mined or evicted between getRawMempool and this fetch.
            // Resolving null (rather than rejecting) lets the caller filter out the one
            // missing tx instead of failing the whole Promise.all batch.
            axiosStub.resolves({ data: { result: null, error: { message: 'tx not found' } } })

            const result = await connector.getRawTransaction('txid123')
            assert.strictEqual(result, null)
        })

        it('should retry on network failure up to 10 times', async () => {
            axiosStub.rejects(new Error('network error'))

            await assert.rejects(
                () => connector.getRawTransaction('txid123'),
                { message: /failed after 10 attempts/ }
            )
            assert.strictEqual(axiosStub.callCount, 10)
        }).timeout(10000) // retries include 500ms sleeps

        it('should resolve on success after retries', async () => {
            axiosStub.onCall(0).rejects(new Error('fail'))
            axiosStub.onCall(1).rejects(new Error('fail'))
            axiosStub.onCall(2).resolves({ data: { result: 'txhex' } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, 'txhex')
        }).timeout(5000)

        it('[REGRESSION P2] R-RPC-002: should back off longer on -429 work queue depth exceeded', async () => {
            const queueError = new Error('queue full')
            // Bitcoin/Litecoin Core signal work-queue exhaustion with HTTP 500 +
            // a JSON body whose error.code === -429 (NOT an actual HTTP 429 response).
            queueError.response = { data: { error: { code: -429, message: 'Work queue depth exceeded' } } }
            axiosStub.onCall(0).rejects(queueError)
            axiosStub.onCall(1).resolves({ data: { result: 'txhex' } })

            const start = Date.now()
            const result = await connector.getRawTransaction('txid')
            const elapsed = Date.now() - start

            assert.strictEqual(result, 'txhex')
            // -429 backoff is 5000ms vs normal 500ms
            assert.ok(elapsed >= 4000, `Expected >= 4000ms backoff, got ${elapsed}ms`)
        }).timeout(10000)
    })

    describe('#getRawTransactions()', () => {
        it('should batch multiple getRawTransaction calls', async () => {
            axiosStub.resolves({ data: { result: 'txhex' } })

            const results = await connector.getRawTransactions(['tx1', 'tx2', 'tx3'])
            assert.strictEqual(results.length, 3)
            assert.strictEqual(results[0], 'txhex')
        })

        it('should return empty array for empty input', async () => {
            const results = await connector.getRawTransactions([])
            assert.deepStrictEqual(results, [])
        })

        it('should not fail the whole batch when one tx is mined/evicted (resolves null)', async () => {
            // tx2 was evicted between getRawMempool and the fetch: empty RPC result.
            // The batch must still return the other txs with a null hole for the missing one,
            // rather than rejecting and dropping every txid in the batch.
            axiosStub.onCall(0).resolves({ data: { result: 'txhex1' } })
            axiosStub.onCall(1).resolves({ data: { result: null, error: { message: 'tx not found' } } })
            axiosStub.onCall(2).resolves({ data: { result: 'txhex3' } })

            const results = await connector.getRawTransactions(['tx1', 'tx2', 'tx3'])
            assert.deepStrictEqual(results, ['txhex1', null, 'txhex3'])
        })
    })

    describe('#getBlockWithoutAuxPow()', () => {
        it('[REGRESSION P2] R-NET-003: should strip AuxPoW data from block hex', async () => {
            // Header = 200 hex chars (100 bytes, includes 20 bytes of AuxPoW)
            // Standard bitcoin header = 160 hex chars (80 bytes)
            // So dataToRemove = 200 - 160 = 40 hex chars
            const auxPowHeader = 'a'.repeat(200)
            const blockBody = 'b'.repeat(100)
            const fullBlockHex = auxPowHeader.substring(0, 160) + 'x'.repeat(40) + blockBody

            // getBlockHeader returns the full header including AuxPoW
            axiosStub.onCall(0).resolves({ data: { result: auxPowHeader } }) // getBlockHeader
            axiosStub.onCall(1).resolves({ data: { result: fullBlockHex } })  // getBlock

            const result = await connector.getBlockWithoutAuxPow('hash')

            // Result should be first 160 chars + body (without the 40 AuxPoW chars)
            assert.strictEqual(result.length, 160 + blockBody.length)
            assert.strictEqual(result.substring(0, 160), fullBlockHex.substring(0, 160))
        })

        it('should not strip anything when header is exactly 160 hex chars (80 bytes)', async () => {
            const standardHeader = 'a'.repeat(160)
            const blockHex = standardHeader + 'bbbb'

            axiosStub.onCall(0).resolves({ data: { result: standardHeader } })
            axiosStub.onCall(1).resolves({ data: { result: blockHex } })

            const result = await connector.getBlockWithoutAuxPow('hash')
            assert.strictEqual(result, blockHex)
        })

        it('should throw on errors', async () => {
            axiosStub.rejects(new Error('network'))

            await assert.rejects(
                () => connector.getBlockWithoutAuxPow('hash'),
                { message: /problems getting a block hex without auxpow/ }
            )
        })
    })
})
