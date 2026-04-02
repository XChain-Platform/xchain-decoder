// Pre-load setup: mock mariadb before any source file requires it.
// The mariadb v3.5+ package is ESM-only, which breaks CommonJS require().
// For unit tests we never need a real DB connection, so we stub it out.
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        // Return a path to our mock
        return require.resolve('./mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
