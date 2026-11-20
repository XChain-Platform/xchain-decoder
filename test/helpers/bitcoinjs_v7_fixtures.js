// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const bitcoin = require('bitcoinjs-lib')

function installBitcoinJsV7Fixtures(){
    const prototype = bitcoin.Transaction.prototype
    if (prototype.addOutputAcceptsFixtureNumbers) return
    const addOutput = prototype.addOutput
    prototype.addOutput = function addFixtureOutput(script, value){
        const amount = typeof value === 'bigint' ? value : BigInt(value)
        return addOutput.call(this, script, amount)
    }
    Object.defineProperty(prototype, 'addOutputAcceptsFixtureNumbers', { value: true })
}

module.exports = { installBitcoinJsV7Fixtures }
