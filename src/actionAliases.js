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
 * XChain Decoder - short-form ACTION-name aliases
 *
 * Lives in its own module because TWO decode-time readers need it and one of
 * them cannot require the other. XChainDecoder.js expands the alias on the
 * TOP-LEVEL action name (canonicalizeActionPayload), and
 * batchSubCommandCapture.js expands it on a BATCH's SUB-COMMAND names; the
 * capture module is required BY XChainDecoder.js, so reaching back for the
 * table would be a require cycle. XChainDecoder.js re-exports this object
 * under its historical name, so every existing reader
 * (`require('./XChainDecoder').ACTION_ALIASES`, which is how the cross-repo
 * ActionManifestConformance guard binds it to
 * xchain-documentation/protocol/action-manifest.json) is unaffected.
 *
 ********************************************************************/

'use strict';

// Short-form ACTION-name aliases. A spec-following client may encode any of
// these leading tokens (e.g. the BRC20/SRC20-compatible TRANSFER, or MSG for a
// shorter MESSAGE) and produce a valid on-chain payload. We expand the alias to
// its canonical name BEFORE the VALID_ACTION_NAMES gate and rewrite the stored
// payload to the canonical form, so the decoder DB never holds aliased names and
// every downstream consumer sees one spelling per action.
//
// The indexer's twin is `actions.js actionAliases`, applied to a BATCH's
// sub-actions by `batch.js normalizeSubAction` at/after the
// BATCH_SUBACTION_NORMALIZATION flag-day. Both tables are pinned to the same
// canonical manifest, which is what makes the decoder's sub-command view and the
// indexer's dispatch agree about what a batched `TRANSFER` IS.
const ACTION_ALIASES = {
    'TRANSFER': 'SEND',
    'ADDR': 'ADDRESS',
    'DROP': 'AIRDROP',
    'CAST': 'BROADCAST',
    'MSG': 'MESSAGE'
}

module.exports = ACTION_ALIASES
