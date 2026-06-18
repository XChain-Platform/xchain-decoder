/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/mocha-runner'],

  mutate: [
    '../../src/XChainDecoder.js',
    '../../src/XChainBlockDecoder.js',
    '../../src/BlockchainConnector.js',
    '../../src/CryptoNetworks.js',
    '../../src/util.js',
  ],

  testRunner: 'mocha',
  mochaOptions: {
    // test/unit/setup.js is sufficient for BOTH unit and security tests;
    // both setup files install the same Module._resolveFilename patch.
    require: ['../../test/unit/setup.js'],
    spec: [
      '../../test/unit/**/*.test.js',
      '../../test/security/**/*.security.test.js',
    ],
    config: '../../test/mutation/.mocharc.mutation-phase2.yml',
    'no-package': true,
  },

  coverageAnalysis: 'perTest',

  // Higher timeout to accommodate security tests.
  timeoutMs: 60000,
  timeoutFactor: 1.5,

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: '../../reports/mutation/phase2/index.html',
  },

  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },

  tempDirName: '.stryker-tmp',
};
