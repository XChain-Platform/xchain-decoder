const assert = require('assert')
const bitcoin = require('bitcoinjs-lib')
const CryptoNetworks = require('../../src/CryptoNetworks')

describe('CryptoNetworks', () => {

    describe('#getBitcoinJsNetwork()', () => {
        it('should return bitcoinjs bitcoin mainnet for "bitcoin-mainnet"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet')
            assert.strictEqual(net, bitcoin.networks.bitcoin)
        })

        it('should return bitcoinjs testnet for "bitcoin-testnet"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-testnet')
            assert.strictEqual(net, bitcoin.networks.testnet)
        })

        it('should return bitcoinjs regtest for "bitcoin-regtest"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest')
            assert.strictEqual(net, bitcoin.networks.regtest)
        })

        it('should return Dogecoin mainnet config with correct pubKeyHash', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet')
            assert.strictEqual(net.pubKeyHash, 0x1e)
            assert.strictEqual(net.scriptHash, 0x16)
            assert.strictEqual(net.wif, 0x9e)
        })

        it('should return Dogecoin testnet config with correct pubKeyHash', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet')
            assert.strictEqual(net.pubKeyHash, 0x71)
        })

        it('should return Dogecoin regtest config matching testnet values', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest')
            assert.strictEqual(net.pubKeyHash, 0x71)
            assert.strictEqual(net.scriptHash, 0xc4)
        })

        it('should return Litecoin mainnet config with bech32 prefix "ltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet')
            assert.strictEqual(net.bech32, 'ltc')
            assert.strictEqual(net.pubKeyHash, 0x30)
        })

        it('should return Litecoin testnet config with bech32 prefix "tltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet')
            assert.strictEqual(net.bech32, 'tltc')
        })

        it('should return Litecoin regtest config with bech32 prefix "rltc"', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest')
            assert.strictEqual(net.bech32, 'rltc')
        })

        it('should return undefined for an unknown network', () => {
            const net = CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet')
            assert.strictEqual(net, undefined)
        })

        it('should include messagePrefix for all Dogecoin networks', () => {
            for (const variant of ['dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest']) {
                const net = CryptoNetworks.getBitcoinJsNetwork(variant)
                assert.ok(net.messagePrefix.includes('Dogecoin'))
            }
        })

        it('should include messagePrefix for all Litecoin networks', () => {
            for (const variant of ['litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest']) {
                const net = CryptoNetworks.getBitcoinJsNetwork(variant)
                assert.ok(net.messagePrefix.includes('Litecoin'))
            }
        })

        it('should include bip32 keys for all custom networks', () => {
            const customs = [
                'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
                'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
            ]
            for (const name of customs) {
                const net = CryptoNetworks.getBitcoinJsNetwork(name)
                assert.ok(net.bip32, `${name} missing bip32`)
                assert.ok(typeof net.bip32.public === 'number', `${name} missing bip32.public`)
                assert.ok(typeof net.bip32.private === 'number', `${name} missing bip32.private`)
            }
        })
    })

    describe('#getFirstBlock()', () => {
        it('should return 900000 for bitcoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-mainnet'), 900000)
        })

        it('should return 100000 for bitcoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-testnet'), 100000)
        })

        it('should return 3000000 for litecoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-mainnet'), 3000000)
        })

        it('should return 4470000 for litecoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-testnet'), 4470000)
        })

        it('should return 6000000 for dogecoin-mainnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-mainnet'), 6000000)
        })

        it('should return 19900000 for dogecoin-testnet', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-testnet'), 19900000)
        })

        it('should return 0 for all regtest networks', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('bitcoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('litecoin-regtest'), 0)
            assert.strictEqual(CryptoNetworks.getFirstBlock('dogecoin-regtest'), 0)
        })

        it('should return 0 for unknown networks (default case)', () => {
            assert.strictEqual(CryptoNetworks.getFirstBlock('unknown-network'), 0)
        })
    })
})
