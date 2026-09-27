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
 ********************************************************************/

'use strict'

const assert = require('assert')
const sinon = require('sinon')
const axios = require('axios')
const BlockchainConnector = require('../../src/chain/blockchain_connector')
const { logger } = require('../../src/chain/blockchain_connector/constants.js')

describe('BlockchainConnector HTTP-200 transaction error logging', () => {
    let connector
    let axiosStub
    let warnStub
    let errorStub
    let infoStub

    beforeEach(() => {
        connector = new BlockchainConnector('127.0.0.1', 8332, 'user', 'pass')
        axiosStub = sinon.stub(axios, 'post')
        warnStub = sinon.stub(logger, 'warn')
        errorStub = sinon.stub(logger, 'error')
        infoStub = sinon.stub(logger, 'info')
    })

    afterEach(() => sinon.restore())

    it('warns once and resolves null for a body error with code -5', async () => {
        const txid = 'evicted-txid'
        axiosStub.resolves({
            status: 200,
            data: {
                result: null,
                error: { code: -5, message: 'No such mempool or blockchain transaction' },
            },
        })

        assert.strictEqual(await connector.getRawTransaction(txid), null)
        assert.strictEqual(axiosStub.callCount, 1)
        sinon.assert.calledOnceWithExactly(
            warnStub,
            `getRawTransaction: node error for txid ${txid}: code -5 No such mempool or blockchain transaction`,
        )
        sinon.assert.notCalled(errorStub)
        sinon.assert.notCalled(infoStub)
    })

    it('keeps a code-less body error at error and resolves null', async () => {
        const txid = 'code-less-txid'
        axiosStub.resolves({
            status: 200,
            data: { result: null, error: { message: 'x' } },
        })

        assert.strictEqual(await connector.getRawTransaction(txid), null)
        assert.strictEqual(axiosStub.callCount, 1)
        sinon.assert.notCalled(warnStub)
        sinon.assert.calledOnceWithExactly(
            errorStub,
            `getRawTransaction: node error for txid ${txid}: code undefined x`,
        )
        sinon.assert.notCalled(infoStub)
    })
})
