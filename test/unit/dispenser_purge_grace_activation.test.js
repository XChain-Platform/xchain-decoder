'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { DISPENSER_PURGE_GRACE_ACTIVATION } = require('../../src/protocol/constants.js');

const EXPLICIT_DOC_CONSTANTS = process.env.XC_DOC_CONSTANTS;
const DOC_CONSTANTS = EXPLICIT_DOC_CONSTANTS || (process.env.XCHAIN_DOCS_DIR
    ? path.join(process.env.XCHAIN_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js'));

describe('DISPENSER_PURGE_GRACE_ACTIVATION conformance', function () {

    it('keeps mainnet and testnet unarmed while regtest is genesis-active', function () {
        assert.deepStrictEqual(DISPENSER_PURGE_GRACE_ACTIVATION, {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('is value-identical to the canonical map in xchain-documentation', function () {
        if (!fs.existsSync(DOC_CONSTANTS)) {
            if (EXPLICIT_DOC_CONSTANTS)
                assert.fail('XC_DOC_CONSTANTS does not exist: ' + DOC_CONSTANTS);
            this.skip();
        }
        const canonical = require(DOC_CONSTANTS).DISPENSER_PURGE_GRACE_ACTIVATION;
        if (!canonical && !EXPLICIT_DOC_CONSTANTS) this.skip();
        assert.ok(canonical && typeof canonical === 'object',
            'xchain-documentation/protocol/constants.js must export ' +
            'DISPENSER_PURGE_GRACE_ACTIVATION');
        assert.deepStrictEqual(DISPENSER_PURGE_GRACE_ACTIVATION, canonical,
            'the decoder purge-grace activation map drifted from the canonical map');
    });
});
