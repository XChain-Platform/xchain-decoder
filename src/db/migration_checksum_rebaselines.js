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
 **********************************************************************/

const Database = require('../db.js')

// Applied-migration files whose checksum may be healed in place. Entries are
// (old sha256 -> new sha256) pairs pinned to reviewed edits; anything else
// still fails the immutability guard in runMigrations(). `from` may be a list
// when the same reviewed edit supersedes several historical revisions (fleet
// DBs recorded whichever revision they applied first). Executable SQL is
// byte-identical across every pinned revision (verified: strip `--` comment
// lines and blank lines; the residue hashes identically from first commit to
// HEAD) for every entry EXCEPT three, which are justified by a measured data
// equivalence instead and each carry that argument in full at its own entry
// rather than relying on this blanket sentence: the byte-order one at the
// bottom, the 8151979 revision of the unique-index one, and the June widen-ids
// revisions.
// Applied fleet-wide through code deploy: both the startup auto-run and
// `node src/db/migrate.js` pass through this heal before the mismatch guard, so no
// direct schema_migrations SQL is ever needed. Keeps the shared entries aligned
// with xchain-indexer while also pinning decoder-specific historical revisions.
Database.MIGRATION_CHECKSUM_REBASELINES = {
    // Comment-only edits: 3a1c435 rewrote the validator note into the follower
    // ordering note (and dropped an em-dash), ec36bd4 added the license header.
    // The single ALTER statement is unchanged since authorship (9f3b898).
    '2026-06-15-events-data-mediumtext.sql': {
        from: [
            'c34872de8f381587269d0a408138b9caadb5cbec01660eef034a95a7a039ca42',  // 9f3b898..6869813
            '08cd99f76467f8aa82ffb06df5ff46b67095c5d1fd89dd427b6a085d52a30006',  // 3a1c435
        ],
        to:   '3790d814dec1ecbf7be78065be82a9f7e4f983c4529620f3c1a7d01f129881e8',  // ec36bd4 (HEAD)
    },
    // Comment-only edits: 6869813 corrected the stale header comment (table
    // rebuild warning), ec36bd4 added the license header. The executable
    // statements are unchanged since authorship (710a954).
    '2026-06-17-pubkeys-add-monotonic-id.sql': {
        from: [
            '84b1c8093344d8a829d724c6e99468bb12c24cb85fe9a248a04e57b6d5769697',  // 710a954
            '1aabdd6da22872473ce26757c357dbbb68240fb5681956adce959778203b9caa',  // 6869813..3a1c435
        ],
        to:   '1d8406192690e5a754ec9430fcd9115e907f34944f340a70b776166a62f83868',  // ec36bd4 (HEAD)
    },
    // Comment-only edits: the header claimed mode=manual left the file
    // "pending and harmless on fresh DBs" and that IF [NOT] EXISTS made a partial
    // run resumable. Both were false and both invited the corrupting blanket run,
    // so the header names MIGRATION_PRECONDITIONS below as the actual guard, and
    // now also carries the `deploy-precondition=required` tag so the deploy tool can
    // see the same requirement from a cloned source tree. The four statements are
    // unchanged since authorship (63fc384): stripping `--` comment lines and blank
    // lines leaves the identical residue
    // 820a0b2ae5b662a4e963dd2301f6ac86d2f67feaa6b59527c23fabec3c1a678c at every
    // revision pinned here.
    '2026-06-13-dispensers-expiration-bigint.sql': {
        from: [
            '8b163db63932ec7940fc0c4ff83abb6a52d27ab4a192c377ce5195c3ca4b969f',  // 63fc384
            'c4d622adc34b3190a7cc43954b4c815a3c79bb6c6b7374be39c16d66454d1549',  // ec36bd4 (license header)
            '44901ce7272347e6665ffe29655dbd7b8f3e45ba58b26671e50d07c0c629caef',  // header correction
            '36a7d4566d462c2b76734c4527ad203d408cbf6cc75d483bcedc9e5b74929ad2',  // c657df8 (decoder header correction)
            '2e20aceb9a446f03ff8ef7a9fd2cc6dede722c30610de57c0d1ef25a455b4dca',  // comment tidy
        ],
        to:   '0e871ed4aea8649d6a5ffe866d78af38ceee37e5cd07d651287cfe1e8c99c8b2',  // deploy-precondition tag (HEAD)
    },
    // Comment-only edit: added the `deploy-precondition=required` header tag (and the
    // comment explaining it) so the deploy tool can see, from the source tree it is
    // about to deploy, that this migration is a startup-assertion precondition. The
    // single ALTER is unchanged since authorship; this is the file's only prior
    // committed revision.
    '2026-07-24-pubkeys-widen-uncompressed.sql': {
        from: '2dccc278c37935e1e5b0fc2b0a8c4514a24d5381936a1d9bc1fc5ce8d8473c43',
        to:   '156fca3b75b332ef099e8dd5d28624d9ebc26d34e143e37e1f9503b6c0da0c1d',  // deploy-precondition tag (HEAD)
    },
    // Comment-only edit: added the `deploy-precondition=required` header tag (and the
    // comment explaining it) so the deploy tool can see, from the source tree it is
    // about to deploy, that this migration is a startup-assertion precondition. The
    // two ALTER statements are unchanged since authorship; this is the file's only
    // prior committed revision.
    '2026-08-10-action-data-utf8mb4.sql': {
        from: '027a643d3ff0be087b38889f947fdde2b4d8c696682c3b3642f288553f419068',
        to:   '0b3b2fefb780da1fb96a0d5518967b67b215676cc1ac02efc08ec1672d9091b2',  // deploy-precondition tag (HEAD)
    },
    // Comment-only edits after the foreign-key repair: 7817e6c added the decoder
    // license header, 2d85912 tidied comments, and 6e78693 added the deploy tag.
    // 4d5db57 and the mirrored a0f826b revision introduced the same executable SQL.
    //
    // Treat the June decoder revisions as schema equivalence. A recorded row proves
    // every statement completed. The oldest revision's extra mempool id MODIFYs were
    // superseded when 4dcea50 rebuilt that table with raw string columns.
    //
    // Preserve the successful earlier revisions that left the schema-source FK in
    // place instead of temporarily dropping and restoring it. The startup contract
    // checks all widened columns and the FK, so any drift still fails closed.
    '2026-06-02-widen-ids-to-bigint.sql': {
        from: [
            '715bd5cc798334117d435e7314ddbb14a94992fa5a7074ca9ac7c0159ad2aff8',  // 418df36 (first ledger-tracked decoder revision)
            '09bfe2eaa495e175c7619de075776bd0ce35f1fbff24a412d3787090a6c0f802',  // ef4c606 (mempool id ALTERs removed)
            'e9b534afe1e1fab8024bd8e9c513708517c73d6fcfd9cfebe40f8c639dd64bb9',  // 576ea8a (June comment correction)
            '6abc5b52e41a33995272334c88d09f9d1c05f478dc62078f295485789ec5c82a',  // 4d5db57 (foreign-key repair)
            'e508ea3bcc4ea4f8f6fd241d93c678245a0ddcb9e582094fe4ddbb636b66d6d7',  // a0f826b
            'b06d1edc06351ad523568191146a127c8e8fa5c76d7dcfe88f8ed40542196dde',  // 7817e6c (decoder license header)
            '82865499dd2ccc48c0a0a016535409a9201b415395f49c70b41c73a3aeda8847',  // ec36bd4 (license header)
            'b03b41b6fcabef9c959851ede9b75cc9089cef7c015bdd69cfcea74ad5acea7a',  // comment tidy
        ],
        to:   '33423de08d0869d7a81829301668383ee3cb47e7226bff587fcfcbf9fa0c7b1c',  // deploy-precondition tag (HEAD)
    },
    // TWO revisions are pinned here and they are blessed for DIFFERENT reasons, so both are
    // stated rather than filed together under the blanket sentence above.
    //
    //   50a5e83 (8845b9ad): the revision that ADDED the `@mempool_has_ids` guard, so the
    //   guarded UPDATEs are what actually ran. 7817e6c then added the license header.
    //   Stripped residue verified IDENTICAL between 50a5e83 and HEAD: ordinary contract.
    //
    //   8151979 (e1f7df79): the ORIGINAL shipped revision, applied by every node deployed in
    //   the 2026-06-10 .. 2026-07-10 window (one production BTC node among them, which is why its decoder
    //   logged the mismatch every startup). Its residue is NOT identical to HEAD's: 50a5e83
    //   rewrote four mempool_transactions repoints from bare statements into
    //   `SET @s := IF(@mempool_has_ids, '<the same statement>', 'DO 0')` + PREPARE/EXECUTE.
    //   This is therefore a DATA equivalence, not a text one, and it is decided by the
    //   ledger row itself rather than assumed:
    //
    //     - the recorded row EXISTS, so the file ran to completion on that database;
    //     - the 8151979 form references mempool_transactions.source_id / destination_id /
    //       tx_hash_id unguarded, so completion is only possible where those columns were
    //       present (otherwise MariaDB aborts the statement with errno 1054 and the runner
    //       records nothing);
    //     - columns present is exactly the branch HEAD's guard takes (@mempool_has_ids = 1),
    //       and the string it then PREPAREs is the same UPDATE / DELETE text.
    //
    //   So on every database this heals, the two revisions executed the identical statements.
    //   The guard only diverges on the post-2026-06-15-mempool-raw-strings schema, where the
    //   old form could not have been recorded as applied in the first place.
    //
    // The check to re-run before extending this entry to a new database: if a row for this
    // file can ever be present WITHOUT the migration having completed (a runner that stamps
    // before applying, or a hand-inserted ledger row), the argument above does not carry and
    // the schema must be reconciled instead.
    '2026-05-28-unique-index-tables.sql': {
        from: [
            'e1f7df7973881b6fcaa5535fe5aca86b82bb7f45fa4e7e5fdcf9c5859c468207',  // 8151979..50a5e83^
            '8845b9addc0990b0433f8862969b57cb472535474b4b4d5576c408db777b57ce',  // 50a5e83..7817e6c^
        ],
        to:   '4f7f53ea5423d5ad50e0a2136243dab9e215033e6a110c7b47e66ba5361d44c2',  // 7817e6c (HEAD)
    },
    // c808bd1 carries the same executable SQL as HEAD; 7817e6c only added the
    // license header. The earlier 0a6afe3 revision is a data equivalence instead,
    // said plainly rather than filed quietly alongside the comment-only revisions:
    //
    //     recorded (0a6afe3):  JOIN blocks prev ON prev.block_index = b.block_index - 1
    //     HEAD     (c808bd1):  JOIN blocks prev ON prev.block_index + 1 = b.block_index
    //
    // The two are algebraically identical for every block_index >= 1 and differ ONLY at
    // block_index 0, where `b.block_index - 1` underflows BIGINT UNSIGNED - which is the
    // defect c808bd1 fixed. So this is justified by a DATA equivalence rather than by a text
    // equivalence, and the data was measured on 2026-08-14 rather than assumed: the lowest
    // block any decoder holds is its XChain genesis pin, BTC 950000, LTC 3120000, DOGE
    // 6240000. No decoder database contains block_index 0, or anything near it, so the
    // divergent branch was UNREACHABLE on every database this heals and both forms produced
    // identical rows.
    //
    // The check to re-run before extending this entry to a new database: if it can ever hold
    // block_index 0, this reasoning does NOT carry and the schema must be reconciled instead.
    '2026-06-02-fix-previous-block-hash-byte-order.sql': {
        from: [
            '263aba4e1f16aca19342cb1d58eb072735e822ddffc3823e8850cf52404c37dd',  // 0a6afe3..c808bd1^
            '508028700454d7a8785e9795cb3ab7c42cfc3454b8e2171c6cab69b378f51998',  // c808bd1 (underflow fix)
        ],
        to:   'db1e2cac25b7ed132dddaf33a483f35151208901c40a5b4c637d5b5f23492663',  // 7817e6c (HEAD)
    },
    // Comment-only edit: 7817e6c added the license header. The DROP, CREATE,
    // INSERT, and DROP statements are unchanged since authorship (4dcea50).
    '2026-06-15-mempool-raw-strings.sql': {
        from: '67a001bbb0ae04c2919f77df3b6da715e527858a3bc7c4a05d53305c6a2d7bf3',  // 4dcea50
        to:   '571c0a30c8264acf89e5f5a11e491cb2c733d96c9ec732c0036bf6cdeb273456',  // 7817e6c (HEAD)
    },
};
