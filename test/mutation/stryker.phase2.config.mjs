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
  plugins: [],

  mutate: [
    'src/XChainDecoder.js',
    'src/chain/XChainBlockDecoder.js',
    'src/chain/blockchain_connector.js',
    'src/chain/crypto_networks.js',
    'src/util.js',
  ],

  testRunner: 'command',
  commandRunner: {
    command: "./node_modules/.bin/mocha --timeout 10000 --exit --require ./test/unit/support/setup.js " +
      "'test/unit/**/*.test.js' 'test/security/**/*.test.js' " +
      "--ignore test/unit/action_manifest_conformance.test.js",
  },

  coverageAnalysis: 'off',

  // Higher timeout to accommodate security tests.
  timeoutMS: 60000,
  timeoutFactor: 1.5,

  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/phase2/index.html',
  },

  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },

  tempDirName: '.stryker-tmp',
};
