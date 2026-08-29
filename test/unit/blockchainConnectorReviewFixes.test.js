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
 * Regression coverage for BlockchainConnector error accounting and reporting:
 *   - getRawTransaction must not inflate rpcErrors when the fetch succeeds
 *     (or resolves null) on the final attempt (the counter-vs-settled guard).
 *   - getRawTransaction must fail loud on deterministic non-timeout errors:
 *     carry the sanitized cause into the final rejection message.
 *   - sanitizeRpcError must surface the node's JSON-RPC {code,message} that
 *     arrives on the HTTP-500 error body, not just the bare status line.
 */

'use strict'

const assert = require('assert')
const sinon  = require('sinon')
const axios  = require('axios')
const BlockchainConnector = require('../../src/BlockchainConnector')

describe('BlockchainConnector RPC error accounting and reporting', () => {
    let connector
    let axiosStub

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
        connector.sleep = async () => {} // no real backoff delays
        axiosStub = sinon.stub(axios, 'post')
    })

    afterEach(() => {
        sinon.restore()
    })

    describe('#getRawTransaction() final-attempt accounting', () => {
        it('does NOT increment rpcErrors when the fetch succeeds on the 10th attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            for (let i = 0; i < 9; i++) axiosStub.onCall(i).rejects(timeoutErr)
            axiosStub.onCall(9).resolves({ data: { result: 'txhex' } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, 'txhex')
            assert.strictEqual(axiosStub.callCount, 10)
            assert.strictEqual(connector.rpcErrors, 0,
                'a recovered fetch on the last attempt must not report an RPC error')
        }).timeout(5000)

        it('does NOT increment rpcErrors when the tx resolves null on the 10th attempt', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            for (let i = 0; i < 9; i++) axiosStub.onCall(i).rejects(timeoutErr)
            axiosStub.onCall(9).resolves({ data: { result: null } })

            const result = await connector.getRawTransaction('txid')
            assert.strictEqual(result, null)
            assert.strictEqual(connector.rpcErrors, 0)
        }).timeout(5000)

        it('DOES increment rpcErrors exactly once when all 10 attempts fail', async () => {
            const timeoutErr = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' })
            axiosStub.rejects(timeoutErr)

            await assert.rejects(() => connector.getRawTransaction('txid'))
            assert.strictEqual(connector.rpcErrors, 1)
        }).timeout(5000)
    })

    describe('#getRawTransaction() fail-loud on deterministic errors', () => {
        it('carries the node cause into the final rejection instead of a bare message', async () => {
            // Core delivers most RPC errors as HTTP 500 + JSON body. A code that is
            // neither -5 (eviction) nor -429 (queue full) is a deterministic fault.
            // Each attempt throws a fresh error object, as axios does in production
            // (sanitizeRpcError scrubs error.response in place, so a shared object
            // would only carry the JSON body on the first read).
            const makeDetErr = () => Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -8, message: 'Block height out of range' } } }
            })
            axiosStub.callsFake(async () => { throw makeDetErr() })

            await assert.rejects(
                () => connector.getRawTransaction('txid'),
                (err) => {
                    assert.ok(/failed after 10 attempts/.test(err.message), 'keeps the attempt-count context')
                    assert.ok(/RPC error -8/.test(err.message), 'surfaces the node RPC code -8')
                    assert.ok(/Block height out of range/.test(err.message), 'surfaces the node message')
                    return true
                }
            )
            assert.strictEqual(connector.rpcErrors, 1)
        }).timeout(5000)
    })

    describe('#getRawTransaction() classifies an HTTP-200 JSON-RPC error body', () => {
        // A node honouring the jsonrpc:"2.0" request field (Bitcoin Core >= v28)
        // returns RPC errors with HTTP 200, so axios never throws and the retry /
        // backoff / accounting classifier below the success path is never reached.
        it('retries a -429 queue-full error with the 5s backoff and counts it once', async () => {
            const delays = []
            connector.sleep = async (ms) => { delays.push(ms) }
            axiosStub.resolves({ status: 200, data: { result: null, error: { code: -429, message: 'Work queue depth exceeded' } } })

            await assert.rejects(
                () => connector.getRawTransaction('txid'),
                (err) => /failed after 10 attempts/.test(err.message) && /-429/.test(err.message)
            )
            assert.strictEqual(axiosStub.callCount, 10, 'the 10-attempt loop must run')
            assert.strictEqual(connector.rpcErrors, 1, 'rpc_errors_total must see the failure')
            assert.deepStrictEqual([...new Set(delays)], [5000], 'every backoff is the queue-full 5s one')
        }).timeout(5000)

        it('retries a transient -28 and resolves the tx once the node is ready', async () => {
            axiosStub.onCall(0).resolves({ status: 200, data: { result: null, error: { code: -28, message: 'Loading block index' } } })
            axiosStub.onCall(1).resolves({ status: 200, data: { result: 'deadbeef' } })

            assert.strictEqual(await connector.getRawTransaction('txid'), 'deadbeef')
            assert.strictEqual(axiosStub.callCount, 2)
            assert.strictEqual(connector.rpcErrors, 0)
        }).timeout(5000)

        it('still resolves null on the first attempt for a -5 eviction', async () => {
            axiosStub.resolves({ status: 200, data: { result: null, error: { code: -5, message: 'No such mempool or blockchain transaction' } } })

            assert.strictEqual(await connector.getRawTransaction('txid'), null)
            assert.strictEqual(axiosStub.callCount, 1, 'eviction tolerance must not burn retries')
            assert.strictEqual(connector.rpcErrors, 0)
        }).timeout(5000)
    })

    describe('block-path methods surface the HTTP-500 JSON-RPC error code', () => {
        it('getBlockHash rethrows an error carrying the node rpcCode/rpcMessage', async () => {
            const rpcErr = Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -8, message: 'Block height out of range' } } }
            })
            axiosStub.rejects(rpcErr)

            await assert.rejects(
                () => connector.getBlockHash(999999999),
                (err) => {
                    assert.strictEqual(err.rpcCode, -8, 'node RPC code is attached to the rethrown error')
                    assert.strictEqual(err.rpcMessage, 'Block height out of range')
                    return true
                }
            )
        }).timeout(5000)
    })

    describe('the shared result extractor reads PRESENCE, not truthiness', () => {
        // JSON-RPC 2.0: a success carries a `result` member, which may legitimately
        // be 0, false or "". Only undefined/null mean the node sent no result. No
        // method routed through the extractor today can answer falsy, so these pin
        // the contract for the next one rather than a behaviour change.
        it('returns a falsy-but-present result instead of throwing', async () => {
            axiosStub.resolves({ data: { result: '' } })
            assert.strictEqual(await connector.getBlockHash(0), '')

            axiosStub.resolves({ data: { result: 0 } })
            assert.strictEqual(await connector.getBlockHash(0), 0)

            axiosStub.resolves({ data: { result: false } })
            assert.strictEqual(await connector.getBlockHash(0), false)

            assert.strictEqual(connector.rpcErrors, 0, 'a valid falsy result is not an RPC failure')
        }).timeout(5000)

        it('still throws the per-method label when the result is absent', async () => {
            axiosStub.resolves({ data: { result: null } })
            await assert.rejects(() => connector.getBlockHash(0), /Error getting block hash/)

            axiosStub.resolves({ data: {} })
            await assert.rejects(() => connector.getBlockHash(0), /Error getting block hash/)
        }).timeout(5000)

        it('still prefers the node error object over the result member', async () => {
            axiosStub.resolves({ data: { result: 0, error: { code: -8, message: 'Block height out of range' } } })
            await assert.rejects(() => connector.getBlockHash(0), /RPC error -8: Block height out of range/)
        }).timeout(5000)
    })

    describe('envInt() falls back on values that used to parse to NaN', () => {
        // NODE_RPC_TIMEOUT feeds axios.defaults.timeout, which axios gates on
        // `if (config.timeout)`. A NaN there installs NO timeout, so a node that
        // accepts the connection and never answers hangs forever and the whole
        // ECONNABORTED retry / endpoint-failover ladder is unreachable.
        const { envInt } = BlockchainConnector
        let warnStub

        beforeEach(() => { warnStub = sinon.stub(console, 'warn') })

        it('uses the default when the variable is unset', () => {
            assert.strictEqual(envInt(undefined, 30000, 'NODE_RPC_TIMEOUT'), 30000)
            assert.strictEqual(warnStub.callCount, 0, 'an unset variable is normal, not a misconfiguration')
        })

        it('uses the default (and warns) when the variable is present but empty', () => {
            assert.strictEqual(envInt('', 30000, 'NODE_RPC_TIMEOUT'), 30000)
            assert.strictEqual(envInt('   ', 30000, 'NODE_RPC_TIMEOUT'), 30000)
            assert.strictEqual(warnStub.callCount, 2)
        })

        it('rejects a unit-suffixed value instead of truncating it to 30ms', () => {
            assert.strictEqual(envInt('30s', 30000, 'NODE_RPC_TIMEOUT'), 30000)
            assert.strictEqual(envInt('1e4', 30000, 'NODE_RPC_TIMEOUT'), 30000)
        })

        it('rejects zero and negatives at the default minimum of 1', () => {
            assert.strictEqual(envInt('0', 30000, 'NODE_RPC_TIMEOUT'), 30000)
            assert.strictEqual(envInt('-5', 30000, 'NODE_RPC_TIMEOUT'), 30000)
        })

        it('keeps 0 usable where the call site documents it (the retry backoff)', () => {
            assert.strictEqual(envInt('0', 500, 'RPC_TIMEOUT_RETRY_DELAY_MS', 0), 0)
        })

        it('passes a valid value through unchanged and silently', () => {
            assert.strictEqual(envInt('45000', 30000, 'NODE_RPC_TIMEOUT'), 45000)
            assert.strictEqual(warnStub.callCount, 0)
        })
    })

    describe('the block-path RPC ladder is one implementation', () => {
        // Seven methods each carried a byte-identical retry-and-classify block while
        // getRawTransaction's classifier grew apart from them, so a correction to what
        // the node's failure modes ARE could land in one copy and miss six.
        const LADDER_METHODS = [
            ['getNetworkInfo',    [],     'getnetworkinfo'],
            ['getBlockchainInfo', [],     'getblockchaininfo'],
            ['getBlockHash',      [0],    'getblockhash'],
            ['getBlockHeader',    ['aa'], 'getblockheader'],
            ['getBlockVerbose',   ['aa'], 'getblock'],
            ['getRawMempool',     [],     'getrawmempool'],
            ['getBlock',          ['aa'], 'getblock'],
        ]

        it('routes every block-path method through the shared ladder', async () => {
            const seen = []
            connector.rpcCallWithTimeoutRetry = async (data) => { seen.push(data.method); return 'ok' }

            for (const [name, args] of LADDER_METHODS) {
                assert.strictEqual(await connector[name](...args), 'ok',
                    `${name} must go through the shared ladder, not a private copy`)
            }
            assert.deepStrictEqual(seen, LADDER_METHODS.map(([, , rpc]) => rpc))
        }).timeout(5000)

        it('counts an exhausted timeout ladder toward rpc_errors_total and keeps the cause', async () => {
            // A node that black-holes every request only ever raises ECONNABORTED, which
            // the copies retried ten times and then rethrew as a bare sentence: the
            // counter described as "Node RPC errors seen since process start" stayed 0
            // through a total outage, and the cause was discarded with it.
            axiosStub.callsFake(async () => {
                throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' })
            })

            await assert.rejects(
                () => connector.getBlockHash(0),
                (err) => {
                    assert.ok(/There were problems getting block hash\./.test(err.message),
                        'the per-method exhaustion message is unchanged')
                    assert.ok(/timeout of 30000ms exceeded/.test(err.message),
                        'the last sanitized cause survives the exhaustion throw')
                    return true
                }
            )
            assert.strictEqual(axiosStub.callCount, 10, 'the 10-attempt timeout ladder is unchanged')
            assert.strictEqual(connector.rpcErrors, 1, 'a black-holing node must move rpc_errors_total')
        }).timeout(5000)

        it('keeps the block path failing FAST on a queue-full answer', async () => {
            // Deliberately NOT getRawTransaction's 5s x10 queue-full ladder. The wedge
            // signal counts consecutive fetch failures at one height
            // (XChainDecoder._fetchErrorCount vs STALL_FETCH_ATTEMPTS) and reaches its
            // verdict in about a minute at the block loop's 3s sleep; at ~50s per
            // in-call ladder the same twenty attempts take a quarter of an hour.
            axiosStub.rejects(Object.assign(new Error('Request failed with status code 500'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 500, data: { error: { code: -429, message: 'Work queue depth exceeded' } } }
            }))

            await assert.rejects(() => connector.getBlockHash(0), (err) => {
                assert.strictEqual(err.rpcCode, -429, 'the node code reaches the caller intact')
                return true
            })
            assert.strictEqual(axiosStub.callCount, 1, 'no in-call retry for a non-timeout error')
            assert.strictEqual(connector.rpcErrors, 1)
        }).timeout(5000)
    })

    describe('every RPC knob in the file goes through envInt', () => {
        // The two remaining env reads used bare parseInt behind a `|| default` guard,
        // which absorbs NaN but not magnitude: NODE_FAILOVER_THRESHOLD=5m became 5 and
        // DECODER_RPC_CONCURRENCY=100x became 100 sockets at the operator's node, both
        // silently. They are knobs on the same seam as NODE_RPC_TIMEOUT and must
        // validate and report identically.
        let warnStub

        beforeEach(() => {
            warnStub = sinon.stub(console, 'warn')
            delete process.env.NODE_FAILOVER_THRESHOLD
            delete process.env.DECODER_RPC_CONCURRENCY
        })

        afterEach(() => {
            delete process.env.NODE_FAILOVER_THRESHOLD
            delete process.env.DECODER_RPC_CONCURRENCY
        })

        it('NODE_FAILOVER_THRESHOLD=5m warns and keeps the default, not 5', () => {
            process.env.NODE_FAILOVER_THRESHOLD = '5m'
            const c = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
            assert.strictEqual(c.failoverThreshold, 3)
            assert.strictEqual(warnStub.callCount, 1, 'a mis-set knob must be visible in logs')
        })

        it('NODE_FAILOVER_THRESHOLD passes a valid value through silently', () => {
            process.env.NODE_FAILOVER_THRESHOLD = '7'
            const c = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
            assert.strictEqual(c.failoverThreshold, 7)
            assert.strictEqual(warnStub.callCount, 0)
        })

        it('DECODER_RPC_CONCURRENCY=100x warns and keeps the default, not 100 sockets', async () => {
            process.env.DECODER_RPC_CONCURRENCY = '100x'
            const c = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')

            let inFlight = 0
            let peak = 0
            c.getRawTransaction = async () => {
                inFlight++
                peak = Math.max(peak, inFlight)
                await new Promise((r) => setImmediate(r))
                inFlight--
                return 'hex'
            }

            const ids = Array.from({ length: 60 }, (_, i) => 'tx' + i)
            assert.strictEqual((await c.getRawTransactions(ids)).length, 60)
            assert.ok(peak <= 50, `sub-batch must stay at the default 50, saw ${peak}`)
            assert.ok(warnStub.callCount >= 1, 'a mis-set knob must be visible in logs')
        }).timeout(5000)
    })
})
