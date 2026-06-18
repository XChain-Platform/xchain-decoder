// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Regression test setup: reuses the unit test mariadb mock.
// This prevents ESM import errors when loading source files that require mariadb.
const Module = require('module')
const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'mariadb') {
        return require.resolve('../unit/mariadbMock.js')
    }
    return originalResolveFilename.call(this, request, parent, isMain, options)
}
