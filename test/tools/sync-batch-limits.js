'use strict';

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
 * XChain Decoder - CANONICAL SYNC for the indexer's BATCH limit tables
 *
 *   node test/tools/sync-batch-limits.js          # rewrite the vendored module
 *   node test/tools/sync-batch-limits.js --check   # exit 1 if it has drifted
 *
 * WHY A GENERATOR AND NOT A HAND COPY. src/protocol/indexerBatchLimits.js decides which
 * BATCHes the decoder refuses to capture for, and it must agree with
 * xchain-indexer/src/actions/batch.js exactly: a cap that exists here and not there
 * SUPPRESSES capture for a batch the indexer dispatches, which is the money-bearing
 * under-capture direction. Two hand-maintained copies of one consensus table can never
 * re-converge once they diverge (the platform's own coins-registry lesson), so the vendored
 * file is written FROM the sibling and a unit test re-derives it on every run.
 *
 * WHAT IT READS. The real Batch class, INSTANTIATED, not a regex over its source: the caps
 * live on `this` in the constructor, so a rename, a reformat or a move to a computed value
 * all keep working while a scrape would silently read nothing. The constructor touches only
 * its injected collaborators' identities (never their methods), so a stub-shaped `action`
 * object is enough and no database is needed.
 *
 * WHAT IT DELIBERATELY DOES NOT VENDOR: the BATCH_ISSUANCE_LIMITS activation INSTANT.
 * The decoder never evaluates that flag at runtime. Its own gate
 * (BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION) is required by
 * batchSubCommandOutputCaptureActivation.test.js to sit at or after the indexer's
 * BATCH_ISSUANCE_LIMITS instant on every ARMED network, so at every block time where this
 * module's rules run, that flag is provably already on. Copying the instant here would add a
 * second thing to drift and would answer a question the ordering invariant has already
 * answered; the ordering, its block-index gates and its consensus-version gate are asserted
 * in batchLimitsVendoring.test.js instead.
 *
 * Lives under test/ rather than bin/ because it is a maintenance tool for the conformance
 * suite that consumes it: batchLimitsVendoring.test.js requires deriveFromSibling() and
 * renderModule() from HERE, so the check and the fix can never implement two different ideas
 * of what the vendored file should say.
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const INDEXER_BATCH   = path.join(INDEXER_ROOT, 'src', 'actions', 'batch.js');
const INDEXER_CHANGES = path.join(INDEXER_ROOT, 'src', 'protocol_changes.js');

const VENDORED = path.join(__dirname, '..', '..', 'src', 'protocol', 'indexerBatchLimits.js');

// Minimal stand-in for the `action` object xchain-indexer/src/actions.js hands the Batch
// constructor. The constructor only STORES these, so identity is all that is required; any
// method call would be a change in that constructor and is meant to break loudly here.
function stubAction(){
    return {
        config:          {},
        decoderDb:       {},
        indexerDb:       {},
        util:            {},
        mapper:          {},
        protocolChanges: {},
        actionAliases:   {},
    };
}

// The BATCH limit tables as the sibling indexer defines them RIGHT NOW.
function deriveFromSibling(){
    const Batch = require(INDEXER_BATCH);
    const batch = new Batch(stubAction());
    return {
        COMMAND_LIMIT:       batch.commandLimit,
        ACTION_LIMITS:       sortedCopy(batch.actionLimits),
        GATED_ACTION_LIMITS: sortedCopy(batch.gatedActionLimits),
        CHILD_ISSUE_KEY:     batch.childIssueKey,
    };
}

// Key order is normalized so a reordering in the sibling cannot show up as drift, and so the
// rendered file is stable across regenerations.
function sortedCopy(table){
    const out = {};
    for (const key of Object.keys(table).sort()) out[key] = table[key];
    return out;
}

// The BATCH_ISSUANCE_LIMITS registration, read off a REAL ProtocolChanges instance rather
// than a regex: every activation field is on the parsed change object. Used by the
// conformance test, not written into the vendored module (see the header).
function issuanceLimitsChange(network){
    const ProtocolChanges = require(INDEXER_CHANGES);
    const changes = new ProtocolChanges({
        config:    { NETWORK: network || 'regtest' },
        decoderDb: { getBlockTime: async () => 0 },
    });
    return { change: changes.changes['BATCH_ISSUANCE_LIMITS'], consensusVersion: changes.version };
}

function literal(value){
    return JSON.stringify(value);
}

function renderTable(table, indent){
    const pad = ' '.repeat(indent);
    const rows = Object.keys(table).map(k => pad + '    ' + literal(k) + ': ' + literal(table[k]) + ',');
    return '{\n' + rows.join('\n') + '\n' + pad + '}';
}

function renderModule(derived){
    return `'use strict';

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
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 *   regenerate: node test/tools/sync-batch-limits.js
 *   drift gate: test/unit/batchLimitsVendoring.test.js (re-derives and compares on every
 *               unit run; skips only when the sibling checkout is absent, and
 *               XCHAIN_REQUIRE_SIBLINGS=1 turns that skip into a failure)
 *
 * SOURCE OF TRUTH: xchain-indexer/src/actions/batch.js, read by instantiating the real Batch
 * class. These are the tables whose breach makes the indexer reject a BATCH AS A WHOLE, so
 * that not one of its sub-commands runs. The decoder mirrors them to stop capturing outputs
 * for commands nothing will execute (batchSubCommandCapture.hasProvablyRejectedBatch).
 *
 * THE DIRECTION OF ERROR IS NOT SYMMETRIC, which is why this file is generated rather than
 * typed: a cap that is TIGHTER here than in the indexer suppresses capture for a batch the
 * chain really runs, and a missed settlement output is a payment that is never recognised.
 * A cap that is LOOSER here merely leaves today's over-capture open for that shape.
 *
 ********************************************************************/

// Global per-BATCH command cap. Breached => 'invalid: COMMAND (limit)', whole batch.
// GATED on BATCH_ISSUANCE_LIMITS in the indexer; see the module header of
// batchSubCommandCapture.js for why that flag is provably active wherever the decoder's
// own capture gate is.
const COMMAND_LIMIT = ${literal(derived.COMMAND_LIMIT)};

// Per-ACTION caps in force in BOTH flag states (indexer: this.actionLimits).
// 0 means the ACTION may not appear in a BATCH at all.
const ACTION_LIMITS = ${renderTable(derived.ACTION_LIMITS, 0)};

// Per-ACTION caps that arrive WITH BATCH_ISSUANCE_LIMITS (indexer: this.gatedActionLimits),
// merged over ACTION_LIMITS at/after that flag-day.
const GATED_ACTION_LIMITS = ${renderTable(derived.GATED_ACTION_LIMITS, 0)};

// The non-ACTION bucket a dotted-TICK (child) ISSUE is counted under at/after
// BATCH_ISSUANCE_LIMITS, so child issuance is exempt from the top-level ISSUE cap.
const CHILD_ISSUE_KEY = ${literal(derived.CHILD_ISSUE_KEY)};

module.exports = {
    COMMAND_LIMIT,
    ACTION_LIMITS,
    GATED_ACTION_LIMITS,
    CHILD_ISSUE_KEY,
};
`;
}

function main(){
    const check = process.argv.includes('--check');
    if (!fs.existsSync(INDEXER_BATCH)){
        console.error('sibling indexer not found: ' + INDEXER_BATCH);
        console.error('set XCHAIN_INDEXER_DIR to its checkout root');
        process.exit(2);
    }
    const rendered = renderModule(deriveFromSibling());
    const current  = fs.existsSync(VENDORED) ? fs.readFileSync(VENDORED, 'utf8') : null;
    if (current === rendered){
        console.log('src/protocol/indexerBatchLimits.js is in sync with ' + INDEXER_BATCH);
        return;
    }
    if (check){
        console.error('DRIFT: src/protocol/indexerBatchLimits.js does not match ' + INDEXER_BATCH);
        console.error('run: node test/tools/sync-batch-limits.js');
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(VENDORED), { recursive: true });
    fs.writeFileSync(VENDORED, rendered);
    console.log((current === null ? 'wrote ' : 'updated ') + VENDORED);
}

if (require.main === module) main();

module.exports = {
    INDEXER_BATCH,
    INDEXER_CHANGES,
    VENDORED,
    deriveFromSibling,
    issuanceLimitsChange,
    renderModule,
};
