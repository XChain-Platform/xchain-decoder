// Pre-load: mock mariadb before any source file requires it.
// mariadb v3.5+ is ESM-only which breaks CommonJS require().
// Benchmarks never need a real DB connection, so we stub it out.
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        return require.resolve('../unit/mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
