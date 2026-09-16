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
 *
 * Finds one xchain-indexer action handler in a sibling checkout, whichever shape it has.
 *
 * WHY. A handler is one file, src/actions/<name>.js, until the indexer's file-size work
 * splits it into src/actions/<name>/ with the entry at index.js and the logic in parts
 * beside it, leaving NO flat file behind (the sdk pre-flight drift gate refuses
 * to pin a handler directory while a flat <name>.js sits next to it, since require() would
 * resolve the flat file first). Anything here that names the flat path then reads a file
 * that is not there: the sync tool reports a missing sibling, and a source-text mirror
 * check reports the indexer as registering nothing.
 *
 * WHAT. entry() is the path to require, source() the handler's whole text: the entry plus
 * every part beside it, so a literal or a registration that moved into a part is still
 * read. A checkout that still carries the flat file reads exactly as it always did.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

/** The path to require for handler <name> under an indexer checkout root. */
function entry(indexerRoot, name) {
    const flat = path.join(indexerRoot, 'src', 'actions', name + '.js');
    if (fs.existsSync(flat)) return flat;
    const inDirectory = path.join(indexerRoot, 'src', 'actions', name, 'index.js');
    return fs.existsSync(inDirectory) ? inDirectory : flat;
}

/** Every file of handler <name>, sorted, entry included. Empty when the handler is absent. */
function files(indexerRoot, name) {
    const dir = path.join(indexerRoot, 'src', 'actions', name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory())
        return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
            .map((f) => path.join(dir, f));
    const flat = path.join(indexerRoot, 'src', 'actions', name + '.js');
    return fs.existsSync(flat) ? [flat] : [];
}

/** The handler's source text, entry and parts newline-joined, or null when it is absent. */
function source(indexerRoot, name) {
    const list = files(indexerRoot, name);
    return list.length ? list.map((f) => fs.readFileSync(f, 'utf8')).join('\n') : null;
}

module.exports = { entry, files, source };
