/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/mocha-runner'],

  mutate: [
    'src/XChainDecoder.js',
    'src/XChainBlockDecoder.js',
    'src/BlockchainConnector.js',
    'src/CryptoNetworks.js',
    'src/util.js',
  ],

  testRunner: 'mocha',
  mochaOptions: {
    // test/unit/setup.js is sufficient for BOTH unit and security tests —
    // both setup files install the same Module._resolveFilename patch.
    require: ['./test/unit/setup.js'],
    spec: [
      'test/unit/**/*.test.js',
      'test/security/**/*.security.test.js',
    ],
    config: '.mocharc.mutation-phase2.yml',
    'no-package': true,
  },

  coverageAnalysis: 'perTest',

  // Higher timeout to accommodate security tests.
  timeoutMs: 60000,
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
