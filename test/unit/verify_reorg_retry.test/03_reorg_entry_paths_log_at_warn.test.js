/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Every path into a rollback logs at warn.
 *
 * decoder.logWarn exists so a reorg reaches a warn-and-above alerting rule;
 * decoder.log writes info to stdout, which those rules do not read. A rollback
 * can start from a forward hash mismatch, an equal-height tip swap or a node tip
 * below the stored tip, so each entry line and the shared rollback summary must
 * go through logWarn, or alerting sees a reorg only when one path detected it.
 */

'use strict'

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')

const SRC_DIR = path.join(__dirname, '..', '..', '..', 'src', 'XChainDecoder')

// Return the logger method that emits the line carrying `marker` in `file`.
function loggerFor(file, marker){
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8')
    const at = src.indexOf(marker)
    assert.ok(at > 0, file + ' no longer carries "' + marker + '"; update this guard with the new text')
    const lineStart = src.lastIndexOf('\n', at) + 1
    const m = /this\.(log\w*)\(/.exec(src.slice(lineStart, at))
    assert.ok(m, 'no this.log* call precedes "' + marker + '" on its line in ' + file)
    return m[1]
}

describe('reorg entry paths log at warn @unit', function () {
    const SITES = [
        ['block_ingest.js',        'A reorg has been detected at block'],
        ['sync_loop.js',           'Equal-height tip replacement detected'],
        ['tip_refresh.js',         'Reconciling orphan blocks...'],
        ['reorg_verification.js',  'reorg: rolled back'],
    ]
    for (const [file, marker] of SITES){
        it(file + ' logs "' + marker + '" through logWarn', function () {
            assert.strictEqual(loggerFor(file, marker), 'logWarn')
        })
    }
})
