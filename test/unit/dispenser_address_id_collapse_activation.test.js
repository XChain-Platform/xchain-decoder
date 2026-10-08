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

const activationPath = path.join(__dirname, '..', '..', 'src', 'protocol', 'constants', 'activation.js');
const activation = require(activationPath);
const constants = require('../../src/protocol/constants.js');

const EXPLICIT_DOCS_DIR = process.env.XCHAIN_DOCS_DIR;
const DOCS_CONSTANTS = EXPLICIT_DOCS_DIR
    ? path.join(EXPLICIT_DOCS_DIR, 'protocol', 'constants.js')
    : path.join(__dirname, '..', '..', '..', 'xchain-documentation', 'protocol', 'constants.js');
const NAME = 'DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION';

function declaration(source) {
    const marker = `const ${NAME} = {`;
    const start = source.indexOf(marker);
    assert.notStrictEqual(start, -1, `${NAME} declaration is missing`);
    const end = source.indexOf('\n};', start);
    assert.notStrictEqual(end, -1, `${NAME} declaration is unterminated`);
    return source.slice(start, end + 3);
}

describe('DISPENSER_ADDRESS_ID_COLLAPSE_ACTIVATION conformance', function () {

    it('keeps mainnet and testnet inert while regtest is genesis-active', function () {
        assert.deepStrictEqual(activation[NAME], {
            mainnet: 9999999999,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('is re-exported by the public constants module', function () {
        assert.ok(activation[NAME]);
        assert.strictEqual(constants[NAME], activation[NAME]);
    });

    it('is byte-equal to the canonical declaration in xchain-documentation', function () {
        if (!fs.existsSync(DOCS_CONSTANTS)) {
            if (EXPLICIT_DOCS_DIR)
                assert.fail('XCHAIN_DOCS_DIR does not contain protocol/constants.js');
            this.skip();
        }

        const decoderSource = fs.readFileSync(activationPath, 'utf8');
        const docsSource = fs.readFileSync(DOCS_CONSTANTS, 'utf8');
        assert.strictEqual(declaration(decoderSource), declaration(docsSource));
    });
});
