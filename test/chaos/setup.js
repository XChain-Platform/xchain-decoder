/**
 * Mocha root hook for chaos engineering tests.
 *
 * Pre-loads mariadb mock (same as unit tests) so chaos tests can run
 * without a real database. Individual tests that need real infra
 * should skip themselves if the required services aren't available.
 */
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        return require.resolve('../unit/mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
