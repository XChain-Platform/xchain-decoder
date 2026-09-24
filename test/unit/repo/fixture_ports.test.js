'use strict'

const assert = require('assert')
const ports = require('../../../bin/fixture-ports.js')

describe('fixture ports', function () {
    it('keeps base ports when CI_PORT_OFFSET is absent or zero', function () {
        assert.strictEqual(ports.port('XCHAIN_TEST_NODE_PORT', {}), 18544)
        assert.strictEqual(ports.port('XCHAIN_TEST_DB_PORT', { CI_PORT_OFFSET: '0' }), 13318)
    })

    it('adds CI_PORT_OFFSET to host ports', function () {
        const env = { CI_PORT_OFFSET: '10700' }
        assert.strictEqual(ports.port('XCHAIN_TEST_NODE_PORT', env), 29244)
        assert.strictEqual(ports.port('XCHAIN_E2E_DB_PORT', env), 24019)
    })

    it('does not add the offset to an explicit final port override', function () {
        const env = { CI_PORT_OFFSET: '10700', XCHAIN_TEST_NODE_PORT: '41000' }
        assert.strictEqual(ports.port('XCHAIN_TEST_NODE_PORT', env), 41000)
    })

    it('rejects invalid offsets and out-of-range results', function () {
        assert.throws(() => ports.port('XCHAIN_TEST_NODE_PORT', { CI_PORT_OFFSET: '-1' }), /non-negative integer/)
        assert.throws(() => ports.port('XCHAIN_TEST_NODE_PORT', { CI_PORT_OFFSET: '50000' }), /TCP port range/)
    })
})
