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
  // ── Plugins ────────────────────────────────────────────────────────────────
  plugins: ['@stryker-mutator/mocha-runner'],

  // ── What to mutate ─────────────────────────────────────────────────────────
  // Excludes db.js (requires real MariaDB) and api.js (requires running server).
  // src/XChainDecoder.js is now a thin facade over src/XChainDecoder/**; both
  // are mutated so coverage lands on the split implementation modules rather
  // than stopping at the re-export layer.
  mutate: [
    'src/XChainDecoder.js',
    'src/XChainDecoder/**',
    'src/chain/XChainBlockDecoder.js',
    'src/chain/blockchain_connector.js',
    'src/chain/crypto_networks.js',
    'src/util.js',
  ],

  // ── Test runner ────────────────────────────────────────────────────────────
  testRunner: 'mocha',
  mochaOptions: {
    // CRITICAL: setup.js installs a Module._resolveFilename patch that redirects
    // require('mariadb') to a mock. Stryker workers are fresh Node.js forks that
    // do NOT inherit the parent's module state; this require entry re-installs
    // the patch in each worker before any source file is loaded.
    require: ['test/unit/support/setup.js'],
    spec: ['test/unit/**/*.test.js'],
    // These tests read src/XChainDecoder.js and/or the src/XChainDecoder/**
    // split modules as TEXT and grep them for source literals (e.g. a Set
    // literal, an exact conditional string). Stryker runs against an
    // instrumented copy of those files in its sandbox, where the literal no
    // longer looks the way the regex expects, so the test fails on every
    // mutation run including the dry run and takes the whole run down with
    // it. Each is a real guard on the real tree (npm test runs it); it just
    // cannot participate here now that the split modules are mutated too.
    ignore: [
      'test/unit/action_manifest_conformance.test.js',
      'test/unit/chain_genesis_pin.test.js',
      'test/unit/chain_identity_gate.test.js',
      'test/unit/decoder_tip_stale_surface.test.js',
      'test/unit/node_catch_up_wait.test.js',
      'test/unit/node_catching_up_status.test.js',
    ],
    config: 'test/mutation/.mocharc.mutation.yml',
    'no-package': true,
  },

  // ── Coverage analysis ──────────────────────────────────────────────────────
  // "perTest" builds a test→mutant coverage map during a dry run, then only
  // executes relevant tests per mutant. 3-10x faster than "off".
  coverageAnalysis: 'perTest',

  // ── Timing ─────────────────────────────────────────────────────────────────
  timeoutMS: 30000,
  timeoutFactor: 1.5,

  // ── Reporting ──────────────────────────────────────────────────────────────
  reporters: ['html', 'clear-text', 'progress'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },

  // ── Quality thresholds ─────────────────────────────────────────────────────
  // Overall score is dragged down by no-coverage mutants in the paths that need a
  // running DB + bitcoind (e.g. XChainDecoder.js's start()). The *covered code*
  // score is the meaningful metric for unit-test-only runs.
  // "break: null" prevents exit-code failure; adjust upward as coverage improves.
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },

  tempDirName: '.stryker-tmp',
};
