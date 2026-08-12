#!/usr/bin/env node
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
/**
 * XChain Decoder Performance Benchmark Harness
 *
 * Usage:
 *   node test/benchmarks/harness.js                    # run all scenarios
 *   node test/benchmarks/harness.js --scenario NAME    # run one scenario
 *   node test/benchmarks/harness.js --list             # list available scenarios
 *   node test/benchmarks/harness.js --compare          # compare against baseline
 *   node test/benchmarks/harness.js --save-baseline    # save results as new baseline
 *   node test/benchmarks/harness.js --json             # output raw JSON
 *   node test/benchmarks/harness.js --quick            # reduced iterations
 */

// Must load setup BEFORE any decoder source to mock mariadb
require('./setup')

const fs = require('fs')
const path = require('path')
const MockBlockchainConnector = require('./MockBlockchainConnector')
const MockDatabase = require('./MockDatabase')
const DataGenerator = require('./DataGenerator')
const MetricsCollector = require('./MetricsCollector')
const XChainDecoder = require('../../src/XChainDecoder')

const BASELINE_PATH = path.join(__dirname, 'baseline.json')

// Available scenarios
const SCENARIO_FILES = [
    'deobfuscation',
    'parse-transaction',
    'block-processing',
    'sustained-sync',
    'spike-load',
    'large-payload',
    'mempool-stress'
]

function parseArgs() {
    const args = process.argv.slice(2)
    const config = {
        scenario: null,
        compare: false,
        saveBaseline: false,
        json: false,
        quick: false,
        list: false,
        verbose: false
    }

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--scenario': case '-s':
                config.scenario = args[++i]; break
            case '--compare': case '-c':
                config.compare = true; break
            case '--save-baseline':
                config.saveBaseline = true; break
            case '--json': case '-j':
                config.json = true; break
            case '--quick': case '-q':
                config.quick = true; break
            case '--list': case '-l':
                config.list = true; break
            case '--verbose': case '-v':
                config.verbose = true; break
            case '--help': case '-h':
                printUsage(); process.exit(0)
        }
    }

    return config
}

function printUsage() {
    console.log(`
XChain Decoder Performance Benchmarks

Usage: node test/benchmarks/harness.js [options]

Options:
  --scenario, -s NAME   Run a specific scenario (default: all)
  --compare, -c         Compare results against stored baseline
  --save-baseline       Save current results as new baseline
  --json, -j            Output raw JSON results
  --quick, -q           Reduced iterations for fast feedback
  --list, -l            List available scenarios
  --verbose, -v         Show detailed progress
  --help, -h            Show this help

Scenarios: ${SCENARIO_FILES.join(', ')}
`)
}

function createDecoder() {
    const mockConnector = new MockBlockchainConnector()
    const mockDb = new MockDatabase()

    const decoder = new XChainDecoder(
        'bitcoin-regtest', '', 0, 'bench', '', '', '', 0, '', '', false
    )

    decoder.connector = mockConnector
    decoder.db = mockDb

    return decoder
}

function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatDelta(current, baseline) {
    if (!baseline) return ''
    const pct = ((current - baseline) / baseline) * 100
    const sign = pct > 0 ? '+' : ''
    const color = Math.abs(pct) < 5 ? '' : (pct > 0 ? '' : '')
    return ` (${sign}${pct.toFixed(1)}%)`
}

function printScenarioResult(result, baseline) {
    switch (result.scenario) {
        case 'deobfuscation':
            console.log('\n--- Deobfuscation (AES-128-CTR) ---')
            for (const [size, data] of Object.entries(result.results)) {
                const bl = baseline?.results?.[size]
                console.log(`  ${size.padEnd(8)} ${formatNumber(data.opsPerSec).padStart(10)} ops/sec  avg: ${data.avgUs}us${formatDelta(data.opsPerSec, bl?.opsPerSec)}`)
            }
            break

        case 'parse-transaction':
            console.log('\n--- Parse Transaction ---')
            for (const [type, data] of Object.entries(result.results)) {
                const bl = baseline?.results?.[type]
                console.log(`  ${type.padEnd(12)} ${formatNumber(data.opsPerSec).padStart(10)} ops/sec  avg: ${data.avgUs}us${formatDelta(data.opsPerSec, bl?.opsPerSec)}`)
            }
            break

        case 'block-processing':
            console.log('\n--- Block Processing ---')
            for (const [label, data] of Object.entries(result.results)) {
                const bl = baseline?.results?.[label]
                console.log(`  ${label.padEnd(16)} ${String(data.blocksPerSec).padStart(8)} blocks/sec  ${formatNumber(data.txsPerSec).padStart(8)} txs/sec  avg: ${data.avgBlockMs}ms/block${formatDelta(data.blocksPerSec, bl?.blocksPerSec)}`)
            }
            break

        case 'sustained-sync':
            console.log('\n--- Sustained Sync ---')
            console.log(`  Blocks: ${result.blockCount}  Total txs: ${formatNumber(result.totalTxs)}  XChain txs: ${formatNumber(result.totalXchn)}`)
            console.log(`  Throughput: ${result.blocksPerSec} blocks/sec  ${formatNumber(result.txsPerSec)} txs/sec  ${formatNumber(result.xchnTxsPerSec)} xchn/sec`)
            console.log(`  Wall time: ${(result.wallTimeMs / 1000).toFixed(2)}s  CPU user: ${result.cpuUserMs}ms  system: ${result.cpuSystemMs}ms`)
            console.log(`  Memory: peak heap ${result.peakMemory.heapUsedMB.toFixed(1)}MB  RSS ${result.peakMemory.rssMB.toFixed(1)}MB`)
            console.log(`  Event loop lag: p50=${result.eventLoopLag.p50.toFixed(2)}ms  p99=${result.eventLoopLag.p99.toFixed(2)}ms  max=${result.eventLoopLag.max.toFixed(2)}ms`)
            if (result.throughputDeltaPercent != null) {
                const stable = Math.abs(result.throughputDeltaPercent) < 10 ? 'STABLE' : 'DEGRADED'
                console.log(`  Throughput drift: ${result.throughputDeltaPercent > 0 ? '+' : ''}${result.throughputDeltaPercent}% (${stable})`)
            }
            break

        case 'spike-load':
            console.log('\n--- Spike Load ---')
            console.log(`  Calm:  ${result.calm.blocks} blocks  ${result.calm.blocksPerSec} blocks/sec  ${formatNumber(result.calm.txsPerSec)} txs/sec`)
            console.log(`  Spike: ${result.spike.blocks} blocks x ${result.spike.txsPerBlock} xchn txs  ${result.spike.blocksPerSec} blocks/sec  ${formatNumber(result.spike.txsPerSec)} txs/sec`)
            console.log(`  Calm/Spike throughput ratio: ${result.throughputRatio}x (higher = more impact from density)`)
            console.log(`  Memory: peak heap ${result.peakMemory.heapUsedMB.toFixed(1)}MB  RSS ${result.peakMemory.rssMB.toFixed(1)}MB`)
            break

        case 'large-payload':
            console.log('\n--- Large Payload Scaling ---')
            for (const [size, data] of Object.entries(result.results)) {
                const bl = baseline?.results?.[size]
                console.log(`  ${size.padEnd(8)} ${formatNumber(data.opsPerSec).padStart(10)} ops/sec  avg: ${data.avgUs}us${formatDelta(data.opsPerSec, bl?.opsPerSec)}`)
            }
            console.log(`  Scaling factor (100B -> 8KB): ${result.scalingFactor}x slower`)
            break

        case 'mempool-stress':
            console.log('\n--- Mempool Stress ---')
            for (const [label, data] of Object.entries(result.results)) {
                const bl = baseline?.results?.[label]
                console.log(`  ${label.padEnd(12)} ${String(data.totalMs).padStart(6)}ms  ${formatNumber(data.txsPerSec).padStart(8)} txs/sec  mem: ${data.memoryDeltaMB > 0 ? '+' : ''}${data.memoryDeltaMB}MB${formatDelta(data.txsPerSec, bl?.txsPerSec)}`)
            }
            break
    }
}

async function runScenario(scenarioName, decoder, generator, config) {
    const scenario = require(`./scenarios/${scenarioName}.bench.js`)
    const metrics = new MetricsCollector()

    const scenarioConfig = { ...config }
    if (config.quick) {
        scenarioConfig.iterations = Math.max(100, Math.floor((scenarioConfig.iterations || 5000) / 10))
        scenarioConfig.blockCount = Math.max(20, Math.floor((scenarioConfig.blockCount || 500) / 10))
        scenarioConfig.calmBlocks = 10
        scenarioConfig.spikeBlocks = 5
    }

    if (!config.json) {
        process.stdout.write(`  Running ${scenario.name}...`)
    }

    const result = await scenario.run(decoder, generator, metrics, scenarioConfig)

    if (!config.json) {
        process.stdout.write(` done\n`)
    }

    return result
}

async function main() {
    const config = parseArgs()

    if (config.list) {
        console.log('Available scenarios:')
        for (const name of SCENARIO_FILES) {
            const s = require(`./scenarios/${name}.bench.js`)
            console.log(`  ${s.name.padEnd(22)} ${s.description}`)
        }
        return
    }

    // Suppress decoder console.log noise unless verbose
    const originalLog = console.log
    const originalError = console.error
    let suppressLogs = !config.verbose && !config.json

    const scenariosToRun = config.scenario
        ? [config.scenario]
        : SCENARIO_FILES

    for (const name of scenariosToRun) {
        if (!SCENARIO_FILES.includes(name)) {
            console.error(`Unknown scenario: ${name}`)
            console.error(`Available: ${SCENARIO_FILES.join(', ')}`)
            process.exit(1)
        }
    }

    let baseline = null
    if (config.compare) {
        try {
            baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
        } catch (e) {
            console.error('No baseline found. Run with --save-baseline first.')
        }
    }

    let commitHash = 'unknown'
    try {
        const { execSync } = require('child_process')
        commitHash = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '../..') })
            .toString().trim()
    } catch (e) { /* ignore */ }

    if (!config.json) {
        console.log('=== XChain Decoder Performance Benchmarks ===')
        console.log(`Date: ${new Date().toISOString()}`)
        console.log(`Commit: ${commitHash}`)
        console.log(`Mode: ${config.quick ? 'quick' : 'full'}`)
        console.log(`Scenarios: ${scenariosToRun.join(', ')}`)
        console.log('')
    }

    const allResults = {
        timestamp: new Date().toISOString(),
        commit: commitHash,
        mode: config.quick ? 'quick' : 'full',
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        scenarios: {}
    }

    for (const name of scenariosToRun) {
        const decoder = createDecoder()
        const generator = new DataGenerator()

        if (suppressLogs) {
            console.log = () => {}
            console.error = () => {}
        }

        try {
            const result = await runScenario(name, decoder, generator, config)
            allResults.scenarios[name] = result

            console.log = originalLog
            console.error = originalError

            if (!config.json) {
                printScenarioResult(result, baseline?.scenarios?.[name])
            }
        } catch (err) {
            console.log = originalLog
            console.error = originalError
            console.error(`\n  ERROR in ${name}: ${err.message}`)
            if (config.verbose) console.error(err.stack)
            allResults.scenarios[name] = { error: err.message }
        }
    }

    if (config.json) {
        console.log = originalLog
        console.log(JSON.stringify(allResults, null, 2))
    }

    if (config.saveBaseline) {
        console.log = originalLog
        fs.writeFileSync(BASELINE_PATH, JSON.stringify(allResults, null, 2))
        console.log(`\nBaseline saved to ${BASELINE_PATH}`)
    }

    if (!config.json) {
        console.log('\n=== Benchmark Complete ===')
    }
}

main().catch(err => {
    console.error('Benchmark harness failed:', err)
    process.exit(1)
})
