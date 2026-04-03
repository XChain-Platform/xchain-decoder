// Regression test setup — reuses the unit test mariadb mock.
// This prevents ESM import errors when loading source files that require mariadb.
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        return require.resolve('../unit/mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
