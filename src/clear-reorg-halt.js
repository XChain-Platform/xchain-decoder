// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old path src/clear-reorg-halt.js working for installed containers
// whose xchain-node still execs `node src/clear-reorg-halt.js`. The tool itself
// lives at src/clear_reorg_halt.js. Delete this file once the fleet runs an
// xchain-node that execs the new path.

'use strict'

const path = require('path')
const Module = require('module')

if (require.main === module){
    // Run the tool as the main module, so its own require.main check loads the
    // service .env and starts it exactly as `node src/clear_reorg_halt.js` would.
    process.argv[1] = path.join(__dirname, 'clear_reorg_halt.js')
    Module.runMain()
} else {
    module.exports = require('./clear_reorg_halt.js')
}
