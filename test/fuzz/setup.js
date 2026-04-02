// Fuzz test setup: mock mariadb (same as unit test setup)
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        return require.resolve('../unit/mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
