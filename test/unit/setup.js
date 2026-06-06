// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

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
