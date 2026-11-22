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
  plugins: [],

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
  testRunner: 'command',
  commandRunner: {
    command: "./node_modules/.bin/mocha --timeout 5000 --exit --require ./test/unit/support/setup.js 'test/unit/**/*.test.js' " +
      "--ignore test/unit/action_manifest_conformance.test.js " +
      "--ignore test/unit/chain_genesis_pin.test.js " +
      "--ignore test/unit/chain_identity_gate.test.js " +
      "--ignore test/unit/decoder_tip_stale_surface.test.js " +
      "--ignore test/unit/node_catch_up_wait.test.js " +
      "--ignore test/unit/node_catching_up_status.test.js " +
      "--ignore test/unit/reorg_recovery.test/05_reorg_wait_surface.test.js",
  },

  // ── Coverage analysis ──────────────────────────────────────────────────────
  // Mocha 12 no longer exposes the private module path used by the Stryker
  // Mocha runner. The command runner is public-CLI-only and cannot map tests.
  coverageAnalysis: 'off',

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
