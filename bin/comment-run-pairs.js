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
 * Which comments did the removal sweep REWRITE, and what did the rewrite take
 * with it?
 *
 * WHY A LINE COUNT CANNOT ANSWER THIS. A restore pass puts back the comment
 * runs that are GONE, and a coverage floor proves it did. Neither sees the
 * other half of the loss: the sweep also scrubbed internal references out of
 * lines it KEPT, and some of those rewrites took the explanation along with
 * the reference. The file ends up with a comment in the same place, shorter,
 * saying less, and every line-based check reads it as present.
 *
 * WHY THE COMPARISON IS RUN-LEVEL AND NOT LINE-LEVEL. Rewrapping a paragraph
 * at a different width changes every line in it, so line pairing reports a
 * pure rewrap as a total loss and buries the real cases. A RUN is a block of
 * consecutive comment lines, which is the unit a writer actually edits.
 *
 * HOW RUNS ARE PAIRED. By token overlap: the Jaccard index of the two runs'
 * word sets, with a floor of 0.3. Above the floor the two runs are the same
 * comment, edited. Below it they are different comments, and the before-run
 * counts as deleted (which the restore pass already handles) rather than as
 * rewritten.
 *
 * WHAT IS FLAGGED. A paired run whose AFTER side carries fewer content words
 * than its BEFORE side. The words it lost are printed so a reader can judge
 * whether they were the reference (correctly gone) or the explanation around
 * it (wrongly gone, and to be merged back WITHOUT the reference).
 *
 * The verdict is a human's. This tool finds the candidates and shows both
 * texts; it never edits a file, because deciding what a sentence was for is
 * exactly the part that cannot be automated.
 *
 * USAGE
 *   node bin/comment-run-pairs.js --before <sha> --after <sha> [--json]
 *   node bin/comment-run-pairs.js --before <sha> --after <sha> --file <path>
 *
 ********************************************************************/

'use strict';

const { execFileSync } = require('node:child_process');

const JACCARD_FLOOR = 0.3;

function git(args) {
    return execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
}

/** The same comment-line definition the coverage gate uses. */
function commentMask(lines) {
    const mask = new Array(lines.length).fill(false);
    let inBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (inBlock) { mask[i] = true; if (t.includes('*/')) inBlock = false; continue; }
        if (t.startsWith('//')) { mask[i] = true; continue; }
        if (t.startsWith('/*')) { mask[i] = true; if (!t.includes('*/')) inBlock = true; }
    }
    return mask;
}

/** Content words: whitespace tokens carrying a letter or a digit, markers off. */
function words(body) {
    return body
        .join(' ')
        .replace(/\/\*+|\*+\/|^\s*\*|\/\//g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''))
        .filter((w) => /[A-Za-z0-9]/.test(w));
}

/** Every comment run in a file, with the code line it sits above. */
function runs(text) {
    const lines = text.split('\n');
    const mask = commentMask(lines);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (!mask[i]) { i += 1; continue; }
        const start = i;
        while (i < lines.length && mask[i]) i += 1;
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        out.push({ body: lines.slice(start, i), anchor: j < lines.length ? lines[j].trim() : null, line: start + 1 });
    }
    return out;
}

function jaccard(a, b) {
    const sa = new Set(a.map((w) => w.toLowerCase()));
    const sb = new Set(b.map((w) => w.toLowerCase()));
    if (!sa.size && !sb.size) return 1;
    let shared = 0;
    for (const w of sa) if (sb.has(w)) shared += 1;
    return shared / (sa.size + sb.size - shared);
}

function fileList(before, after) {
    return git(['diff', '--name-only', `${before}..${after}`]).split('\n').filter(Boolean);
}

function blob(sha, file) {
    try { return git(['show', `${sha}:${file}`]); } catch (e) { return null; }
}

function main() {
    const argv = process.argv.slice(2);
    const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
    const before = arg('--before');
    const after = arg('--after');
    const only = arg('--file');
    const asJson = argv.includes('--json');
    if (!before || !after) { process.stderr.write('usage: comment-run-pairs.js --before <sha> --after <sha> [--file <path>] [--json]\n'); return 2; }

    const flagged = [];
    let pairs = 0;
    const files = only ? [only] : fileList(before, after);
    for (const file of files) {
        const b = blob(before, file);
        const a = blob(after, file);
        if (b === null || a === null) continue;

        const bRuns = runs(b).map((r) => ({ ...r, words: words(r.body) }));
        const aRuns = runs(a).map((r) => ({ ...r, words: words(r.body) }));
        const taken = new Set();

        for (const br of bRuns) {
            let best = null;
            let bestScore = 0;
            for (let k = 0; k < aRuns.length; k += 1) {
                if (taken.has(k)) continue;
                const score = jaccard(br.words, aRuns[k].words);
                if (score > bestScore) { bestScore = score; best = k; }
            }
            if (best === null || bestScore < JACCARD_FLOOR) continue;
            taken.add(best);
            pairs += 1;
            const ar = aRuns[best];
            if (ar.words.length >= br.words.length) continue;
            const after_ = new Set(ar.words.map((w) => w.toLowerCase()));
            const lost = br.words.filter((w) => !after_.has(w.toLowerCase()));
            if (!lost.length) continue;
            flagged.push({
                file,
                beforeLine: br.line,
                afterLine: ar.line,
                similarity: Number(bestScore.toFixed(2)),
                lostWords: lost.length,
                lost,
                beforeText: br.body.join('\n'),
                afterText: ar.body.join('\n'),
            });
        }
    }

    if (asJson) { process.stdout.write(`${JSON.stringify({ before, after, pairs, flagged }, null, 2)}\n`); return 0; }
    for (const f of flagged) {
        process.stdout.write(`\n${f.file}:${f.beforeLine} -> :${f.afterLine}  similarity ${f.similarity}, ${f.lostWords} word(s) lost\n`);
        process.stdout.write(`  BEFORE\n${f.beforeText.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
        process.stdout.write(`  AFTER\n${f.afterText.split('\n').map((l) => `    ${l}`).join('\n')}\n`);
    }
    process.stdout.write(`\n${pairs} paired run(s), ${flagged.length} that lost words\n`);
    return 0;
}

process.exit(main());
