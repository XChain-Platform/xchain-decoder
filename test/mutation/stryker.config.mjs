/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  // ── Plugins ────────────────────────────────────────────────────────────────
  plugins: ['@stryker-mutator/mocha-runner'],

  // ── What to mutate ─────────────────────────────────────────────────────────
  // Excludes db.js (requires real MariaDB) and api.js (requires running server).
  mutate: [
    '../../src/XChainDecoder.js',
    '../../src/XChainBlockDecoder.js',
    '../../src/BlockchainConnector.js',
    '../../src/CryptoNetworks.js',
    '../../src/util.js',
  ],

  // ── Test runner ────────────────────────────────────────────────────────────
  testRunner: 'mocha',
  mochaOptions: {
    // CRITICAL: setup.js installs a Module._resolveFilename patch that redirects
    // require('mariadb') to a mock. Stryker workers are fresh Node.js forks that
    // do NOT inherit the parent's module state — this require entry re-installs
    // the patch in each worker before any source file is loaded.
    require: ['../../test/unit/setup.js'],
    spec: ['../../test/unit/**/*.test.js'],
    config: '../../test/mutation/.mocharc.mutation.yml',
    'no-package': true,
  },

  // ── Coverage analysis ──────────────────────────────────────────────────────
  // "perTest" builds a test→mutant coverage map during a dry run, then only
  // executes relevant tests per mutant. 3-10x faster than "off".
  coverageAnalysis: 'perTest',

  // ── Timing ─────────────────────────────────────────────────────────────────
  timeoutMs: 30000,
  timeoutFactor: 1.5,

  // ── Reporting ──────────────────────────────────────────────────────────────
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: '../../reports/mutation/index.html',
  },

  // ── Quality thresholds ─────────────────────────────────────────────────────
  // Overall score is low (~37%) due to 539 no-coverage mutants in XChainDecoder.js's
  // start() method (requires running DB + bitcoind). The *covered code* score (~67%)
  // is the meaningful metric for unit-test-only runs.
  // "break: null" prevents exit-code failure; adjust upward as coverage improves.
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },

  tempDirName: '.stryker-tmp',
};
