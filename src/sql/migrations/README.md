# Decoder schema migrations

Tracked, ordered schema migrations for the decoder database - the changes the
startup drift reconciler (`db.js` `verifyTables` → `alterTableForDrift`) deliberately
**won't** make on its own: data backfills, destructive index/column changes,
dedup-then-unique, type changes. Additive column/index drift is already
auto-reconciled from `src/sql/*.sql`, so those don't need a migration here.

Each `.sql` file is applied at most once and recorded in the `schema_migrations`
ledger table. Files are applied in lexical filename order, so every migration MUST
be named with a `YYYY-MM-DD-` prefix (`2026-06-17-pubkeys-add-monotonic-id.sql`);
that is the only form under which lexical order is provably chronological. The
runner throws on an undated filename. Do not use an undashed `20260612_` sequence
form: `-` (0x2D) sorts before `0` (0x30), so it would interleave ahead of dashed
files authored earlier.

## Required header tag

Every migration MUST declare its intent on a header line so a destructive change
can never silently auto-run on a validator fleet:

```sql
-- xchain:migration mode=auto     -- additive + idempotent; applied automatically at startup
-- xchain:migration mode=manual   -- destructive / data / dedup; applied only by an explicit operator run
```

A file with no tag defaults to `manual`. `auto` migrations must be idempotent -
guard every statement with `IF [NOT] EXISTS`.

The mode tag is a human declaration; a machine check backs it. A file tagged
`mode=auto` whose statements contain destructive DDL (DROP TABLE/DATABASE/SCHEMA,
CREATE OR REPLACE TABLE, TRUNCATE, RENAME TABLE, DELETE (any form, not just
`DELETE FROM`), an `ALTER TABLE` that drops/renames/CHANGEs a column or narrows
one to NOT NULL, any `ALTER IGNORE TABLE`, any ALTER other than `ALTER [ONLINE]
TABLE`, or any CREATE other than a table or an index, such as a trigger, event,
routine or view) fails startup with an actionable error rather than running
unattended. Re-tag such a file `mode=manual` and apply it deliberately.

## Applying

- **`auto`** migrations apply automatically on decoder startup (no-op once recorded).
- **`manual`** migrations apply only via the operator CLI:

  ```sh
  npm run migrate        # node src/db/migrate.js - applies pending auto + manual
  npm run migrate -- --file <name.sql>   # scopes the run to one migration
  ```

  Reads `DECODER_DB_*` from the service environment. Run with the decoder stopped
  if a migration's header says so. Some older migration headers name the runner's
  former location; those files are checksummed and stay as written, so use the
  commands above.

Migrations are immutable once applied - editing an applied file is detected via a
checksum mismatch and never silently re-run. On the operator path (`npm run
migrate`, i.e. `node src/db/migrate.js`) or with `MIGRATION_STRICT_CHECKSUM=1`, a
mismatch fails closed (throws) so a diverged schema is caught in CI / by an
operator; the passive decoder-startup path logs the mismatch at error level and
continues, to avoid a surprise fleet-wide boot failure.
