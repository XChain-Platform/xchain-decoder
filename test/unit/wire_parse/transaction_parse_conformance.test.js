// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const XChainDecoder = require('../../../src/XChainDecoder')
const XChainBlockDecoder = require('../../../src/chain/XChainBlockDecoder')
const CryptoNetworks = require('../../../src/chain/crypto_networks')
const NEW_VECTORS = require('../../fixtures/decoder_parse_vectors.json')
const WIRE_VECTORS = require('../../fixtures/wire_parse_vectors.json')

bitcoin.initEccLib(ecc)

const P2PKH = Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex')
const P2SH = Buffer.from('a914' + '22'.repeat(20) + '87', 'hex')
const P2WPKH = Buffer.from('0014' + '33'.repeat(20), 'hex')
const P2WSH = Buffer.from('0020' + '44'.repeat(32), 'hex')
const P2TR = Buffer.from('5120' + '22'.repeat(32), 'hex')

describe('transaction wire parsing conformance', function () {
    it('matches node txids for legacy, segwit v0, taproot v1, LTC MWEB and DOGE coinbase forms', function () {
        const forms = [
            ['bitcoin-mainnet', NEW_VECTORS.bitcoinGenesisCoinbase],
            ['bitcoin-mainnet', WIRE_VECTORS.ltcPegin],
            ['bitcoin-mainnet', NEW_VECTORS.taprootWitnessSpend],
            ['litecoin-mainnet', WIRE_VECTORS.ltcHogEx3195200],
            ['dogecoin-mainnet', { hex: WIRE_VECTORS.doge4500000.txs[0], txid: WIRE_VECTORS.doge4500000.txids[0] }],
        ]

        for (const [network, vector] of forms) {
            assert.strictEqual(new XChainBlockDecoder(network).transactionFromHex(vector.hex).getId(), vector.txid)
        }
    })

    it('rejects truncated, non-hex and trailing bytes with a typed error', function () {
        const decoder = new XChainBlockDecoder('bitcoin-mainnet')
        const valid = NEW_VECTORS.taprootWitnessSpend.hex
        const malformed = [
            '',
            '0',
            'zz',
            valid.slice(0, -2),
            valid + '00',
        ]

        for (const hex of malformed) {
            assert.throws(
                () => decoder.transactionFromHex(hex),
                err => err instanceof XChainBlockDecoder.TransactionParseError && err.code === 'ERR_TRANSACTION_PARSE'
            )
        }
    })

    it('rejects an MWEB CompactSize above 2^53 before using it as a length', function () {
        // version 2, MWEB flag 0x08, then input-count CompactSize 2^53.
        const unsafeInputCount = '020000000008ff0000000000002000'
        assert.throws(
            () => new XChainBlockDecoder('litecoin-mainnet').transactionFromHex(unsafeInputCount),
            err => err instanceof XChainBlockDecoder.TransactionParseError &&
                /exceeds Number\.MAX_SAFE_INTEGER/.test(err.message)
        )
    })
})

describe('transaction wire parsing conformance', function () {
    it('bounds-checks every truncation of a fixed MWEB transaction', function () {
        const decoder = new XChainBlockDecoder('litecoin-mainnet')
        const valid = WIRE_VECTORS.ltcHogEx3195200.hex
        for (let end = 0; end < valid.length; end += 2) {
            assert.throws(
                () => decoder.transactionFromHex(valid.slice(0, end)),
                err => err instanceof XChainBlockDecoder.TransactionParseError
            )
        }
        assert.throws(
            () => decoder.transactionFromHex(valid + '00'),
            err => err instanceof XChainBlockDecoder.TransactionParseError && /trailing byte/.test(err.message)
        )
    })

    it('types a truncated transaction inside a block for the block-loop caller', function () {
        const block = Buffer.concat([
            Buffer.from(WIRE_VECTORS.doge4500000.header, 'hex'),
            Buffer.from([WIRE_VECTORS.doge4500000.txs.length]),
            ...WIRE_VECTORS.doge4500000.txs.map(hex => Buffer.from(hex, 'hex')),
        ])
        assert.throws(
            () => new XChainBlockDecoder('dogecoin-mainnet').blockFromBuffer(block.subarray(0, -1)),
            err => err instanceof XChainBlockDecoder.TransactionParseError && err.code === 'ERR_TRANSACTION_PARSE'
        )
    })
})

// The addresses each network derives for P2PKH, P2SH, P2WPKH, P2WSH and P2TR, in
// that order; DOGE has no witness outputs, so it lists only the first two.
const EXPECTED_ADDRESSES = {
    'bitcoin-mainnet': [
        '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH',
        '34oVnh4gNviJGMnNvgquMeLAxvXJuaRVMZ',
        'bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8',
        'bc1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqd8sxw4',
        'bc1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qfpjpqe',
    ],
    'bitcoin-testnet': [
        'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
        'tb1qxvenxvenxvenxvenxvenxvenxvenxvenqzqps5',
        'tb1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zq60xf56',
        'tb1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q7fyw6k',
    ],
    'bitcoin-regtest': [
        'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
        'bcrt1qxvenxvenxvenxvenxvenxvenxvenxvenztev8a',
        'bcrt1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqhkv0pq',
        'bcrt1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qnswg0v',
    ],
    'litecoin-mainnet': [
        'LLnCCHbSzfwWquEdaS5TF2Yt7uz5Qb1SZ1',
        'MB1e6aUeL3Zj4s4H2ZqFBHaaHd7kvvzTco',
        'ltc1qxvenxvenxvenxvenxvenxvenxvenxvenwcpknh',
        'ltc1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zqwr7k5s',
        'ltc1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3q29u36u',
    ],
    'litecoin-testnet': [
        'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
        'tltc1qxvenxvenxvenxvenxvenxvenxvenxvene2zlqa',
        'tltc1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zq9v6gt9',
        'tltc1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qp2c09f',
    ],
    'litecoin-regtest': [
        'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
        'rltc1qxvenxvenxvenxvenxvenxvenxvenxvenuxr9sr',
        'rltc1qg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zql4xswd',
        'rltc1pyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qmnyhqp',
    ],
    'dogecoin-mainnet': [
        'D6hLULEGDRbk86j58t5iWmeinqM6acA16V',
        '9uYkXY8aSzbCAj9rLpWKbmxYfVuM33MqfZ',
    ],
    'dogecoin-testnet': [
        'nVkQCLyB9Q4U15JGAhjAmBF22hjPYUwj3w',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
    ],
    'dogecoin-regtest': [
        'mh5CE8Nbj38iND267s4XnvhSmhDW7yWc6Q',
        '2MvMhrRzhzPDeU9QvbpTmybKSBGjUmC6TTu',
    ],
}

async function assertNetworkAddresses(network, addresses) {
    const decoder = new XChainDecoder(
        network, null, null, null, null, null,
        '127.0.0.1', 0, null, null, false
    )
    const tx = new bitcoin.Transaction()
    tx.addInput(Buffer.alloc(32, 1), 0)
    const scripts = network.startsWith('dogecoin')
        ? [P2PKH, P2SH]
        : [P2PKH, P2SH, P2WPKH, P2WSH, P2TR]
    for (const script of scripts) tx.addOutput(script, 1)

    const parsed = await decoder.parseTransaction(tx, new Set())
    assert.deepStrictEqual(parsed.paymentOutputs.map(output => output.destinationAddress), addresses)

    if (!network.startsWith('dogecoin')) {
        assert.strictEqual(bitcoin.address.fromOutputScript(P2WPKH, CryptoNetworks.getBitcoinJsNetwork(network)), addresses[2])
        assert.strictEqual(bitcoin.address.fromOutputScript(P2TR, CryptoNetworks.getBitcoinJsNetwork(network)), addresses[4])
    } else {
        assert.throws(() => bitcoin.address.fromOutputScript(P2WPKH, CryptoNetworks.getBitcoinJsNetwork(network)))
        assert.throws(() => bitcoin.address.fromOutputScript(P2TR, CryptoNetworks.getBitcoinJsNetwork(network)))
    }
}

describe('output address derivation conformance', function () {
    for (const [network, addresses] of Object.entries(EXPECTED_ADDRESSES)) {
        it(network + ' derives the coin prefixes and witness checksum variant', async function () {
            await assertNetworkAddresses(network, addresses)
        })
    }
})
