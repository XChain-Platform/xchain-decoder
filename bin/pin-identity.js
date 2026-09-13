#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The identity pin: sha256 of every file this repo holds a copy of but does
 * not own.
 *
 * WHY IT IS A SEPARATE PIN FROM THE SUITE TITLES. The suite pin proves that a
 * restructure changed nothing about what runs. This one proves the opposite
 * kind of thing: that a restructure changed nothing about what this repo
 * VENDORS. Both populations below are refreshed from a canonical in another
 * repo, so an edit here is not a local change, it is drift that reddens every
 * consumer's drift tier at a moment nobody connects to the edit.
 *
 * THE TWO POPULATIONS, kept apart because their canonicals differ:
 *
 *   coins           src/coins/*.js, refreshed from the hub by sync-coins.sh.
 *   twinFixtures    the two conformance fixtures whose canonicals live in the
 *                   encoder (roundtrip-conformance.json) and in the
 *                   documentation repo (action-manifest.json).
 *
 * A file that is missing is recorded as null rather than skipped, so a
 * vendored file that disappears fails the comparison instead of shrinking the
 * pin quietly.
 *
 * USAGE
 *   node bin/pin-identity.js                write bin/pins/identity.json
 *   node bin/pin-identity.js --json         print the pin, write nothing
 *   node bin/pin-identity.js --check        compare the tree against the pin,
 *                                           exit 1 on any difference
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const PIN_FILE  = path.join(REPO_ROOT, 'bin', 'pins', 'identity.json');

// Hub-canonical, vendored in by sync-coins.sh. Listed rather than globbed: a
// glob would quietly absorb a sixth file somebody dropped into the directory,
// and the point of the pin is that this set is fixed.
const COINS = [
    'src/coins/BTC.js',
    'src/coins/DOGE.js',
    'src/coins/LTC.js',
    'src/coins/consensus_pin.js',
    'src/coins/index.js',
];

// The two conformance fixtures this repo holds as byte twins. Their canonicals
// are the encoder and the documentation repo, so a diff here means one of the
// two trees moved and the reconciler has not run.
const TWIN_FIXTURES = [
    'test/fixtures/roundtrip-conformance.json',
    'test/fixtures/action-manifest.json',
];

/** sha256 of a tracked file, or null when it is not there at all. */
function hashFile(rel) {
    const abs = path.join(REPO_ROOT, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { return null; }
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** The pin as an object: two named populations, each a path-to-sha256 map. */
function buildPin() {
    const hashes = (list) => {
        const out = {};
        for (const rel of list.slice().sort()) out[rel] = hashFile(rel);
        return out;
    };
    return {
        repo: 'xchain-decoder',
        what: 'sha256 of every file this repo vendors from a canonical it does not own',
        coins: hashes(COINS),
        twinFixtures: hashes(TWIN_FIXTURES),
    };
}

const USAGE = 'usage: node bin/pin-identity.js [--json | --check]';
const KNOWN_FLAGS = new Set(['--json', '--check']);

function main() {
    const args = process.argv.slice(2);
    // Refuse anything unrecognised BEFORE doing anything. With no flags this tool
    // rewrites the pin, so a typo such as `--chek` must never fall through to
    // that write and silently re-bless whatever the tree holds now.
    const unknown = args.filter((a) => !KNOWN_FLAGS.has(a));
    if (unknown.length) {
        console.error(`pin-identity: unknown argument(s): ${unknown.join(' ')}\n${USAGE}`);
        return 2;
    }
    const pin  = buildPin();
    const text = `${JSON.stringify(pin, null, 2)}\n`;

    if (args.includes('--json')) {
        process.stdout.write(text);
        return 0;
    }

    if (args.includes('--check')) {
        let pinned;
        try { pinned = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')); } catch (e) {
            console.error(`identity pin unreadable at bin/pins/identity.json: ${e.message}`);
            return 1;
        }
        const differences = [];
        for (const group of ['coins', 'twinFixtures']) {
            const was = pinned[group] || {};
            const now = pin[group] || {};
            for (const rel of new Set([...Object.keys(was), ...Object.keys(now)])) {
                if (was[rel] !== now[rel]) differences.push(`${rel}: pinned ${was[rel]}, tree ${now[rel]}`);
            }
        }
        if (differences.length) {
            console.error('vendored identity MOVED, which is drift and not a local change:');
            for (const line of differences) console.error(`  ${line}`);
            return 1;
        }
        console.log(`identity pin holds: ${Object.keys(pin.coins).length} coin files, ${Object.keys(pin.twinFixtures).length} twin fixtures`);
        return 0;
    }

    fs.mkdirSync(path.dirname(PIN_FILE), { recursive: true });
    fs.writeFileSync(PIN_FILE, text);
    console.log(`written to bin/pins/identity.json: ${Object.keys(pin.coins).length} coin files, ${Object.keys(pin.twinFixtures).length} twin fixtures`);
    return 0;
}

process.exit(main());
