# @andrewpopov/db-kit

Fleet database toolkit. v0.1 so far: open **SQLite** or **Postgres** from a `DATABASE_URL` with fleet-standard settings, and describe the connection without leaking its password.

ESM-only, Node `^22.12 || ^24 || >=26`. Install from a git tag: `github:andrewpopov/db-kit#vX.Y.Z`.

Prisma apps keep using `@andrewpopov/prisma-tools` for provider selection; this kit is for Drizzle and raw-driver apps.

## API

```ts
import { openDatabase, parseDatabaseUrl, describe } from '@andrewpopov/db-kit';
import { drizzleFor } from '@andrewpopov/db-kit/drizzle'; // needs the optional drizzle-orm peer

const handle = openDatabase(process.env.DATABASE_URL!, {
  postgres: { applicationName: 'zirkbot' }, // required for postgres URLs
  sqlite: { busyTimeoutMs: 5000 },
});
console.log(describe(parseDatabaseUrl(process.env.DATABASE_URL!))); // postgres://app:***@db:5432/zirk?sslmode=verify-full
await handle.health(); // { ok, latencyMs, error? } never throws
const db = drizzleFor(handle); // BetterSQLite3Database | NodePgDatabase (narrow `handle.dialect` for the exact type)
await handle.close(); // idempotent
```

| Export | What |
|---|---|
| `parseDatabaseUrl(url)` | URL -> zod-validated `DatabaseConfig` (`dialect: 'sqlite' \| 'postgres'`). Throws `DbKitError('INVALID_DATABASE_URL')`. |
| `describe(config)` | Log-safe string. Also accepts a raw URL string; one that does not parse is reduced to `scheme://[***@]host`. |
| `openSqlite(config, opts)` | `{ dialect, db, health(), close() }`, `db` is a `better-sqlite3` `Database`. |
| `openPostgres(config, opts)` | `{ dialect, pool, health(), close() }`, `pool` is a `pg.Pool`. |
| `openDatabase(url, { sqlite?, postgres? })` | Parse, then dispatch on the scheme. |
| `drizzleFor(handle)` | `drizzle-orm/better-sqlite3` or `drizzle-orm/node-postgres` instance (from `@andrewpopov/db-kit/drizzle`). |
| `DbKitError` | `code`: `INVALID_DATABASE_URL`, `INVALID_OPTIONS`, `SQLITE_PRAGMA_UNVERIFIED`, `SQLITE_OPEN_FAILED`, `INVALID_MANIFEST`, `CODEC_NULL`, `CODEC_INVALID`, `CODEC_LOSSY`. |
| `parseCodecManifest`, `buildCodecs`, `validateManifest`, `introspectSqlite`, `introspectPostgres`, `POSTGRES_CODEC_TYPES`, `CodecError` | Codec manifest, see below. |

## Codec manifest

Moving an app from SQLite to Postgres needs each column's *logical* type, because SQLite cannot tell them apart (`0/1` may be a boolean or an integer, TEXT may be a date or a string). The manifest declares them; nothing is inferred.

```ts
const manifest = parseCodecManifest({
  version: 1,
  tables: {
    orders: {
      primaryKey: ['id'],
      columns: {
        id: { codec: 'bigint', nullable: false },
        paid: { codec: 'boolean', nullable: false },
        placed_at: { codec: 'timestamp-epoch-ms', preserveInteger: false, nullable: false },
        meta: { codec: 'json-text', preserveText: false, nullable: true },
        total_cents: { codec: 'integer', nullable: false, generated: true },
      },
    },
  },
});
const codecs = buildCodecs(manifest);
const codec = codecs.column('orders', 'paid');
codec.toPostgres(1); // true        (read SQLite with .safeIntegers(true) so bigint columns stay exact)
codec.toSqlite(true); // 1
codec.canonical(1, 'sqlite') === codec.canonical(true, 'postgres'); // 'true' === 'true'
validateManifest(manifest, { sqlite: introspectSqlite(sqliteDb), postgres: await introspectPostgres(pool) }); // { ok, issues, generated, report }
```

Read Postgres with `pool.query({ text, values, types: POSTGRES_CODEC_TYPES })` on a handle opened with `postgres: { applicationName, codecSession: true }`: timestamp, timestamptz, date and json/jsonb must arrive as raw text (the default parsers round to milliseconds and pre-parse JSON), and `codecSession` pins `TimeZone=UTC` and `DateStyle=ISO, YMD` so that text is deterministic (the parser also accepts second-resolution offsets such as `+00:09:21`). Values are never inferred and never coerced silently.

| codec | SQLite value | Postgres column | notes |
|---|---|---|---|
| `text` | TEXT | `text` | |
| `integer` | INTEGER | `bigint` (`integer`/`smallint` also accepted) | safe JS integer only; beyond 2^53 is a `CODEC_LOSSY` error |
| `bigint` | INTEGER as `bigint` | `bigint` | a bigint end to end, never a JS number; outside int64 is lossy |
| `real` | REAL | `double precision` | NaN and Infinity are refused, and `-0` is refused on the way into SQLite (it stores 0) |
| `decimal-as-string` | TEXT | `numeric` | exact; plain numeric text only (no exponent, NaN, JS number) |
| `boolean` | exactly `0` or `1` | `boolean` | `2`, `'1'`, `true` are refused |
| `timestamp-iso` | TEXT ISO-8601 with an explicit offset | `text` by default (`preserveText: true`), or `timestamptz` (`preserveText: false`) | sub-microsecond precision and years outside 0001-9999 are lossy; converting back writes UTC `...Z` text |
| `timestamp-epoch-s`, `timestamp-epoch-ms` | INTEGER | `bigint` by default (`preserveInteger: true`), or `timestamptz` (`preserveInteger: false`) | converting back refuses sub-second / sub-millisecond values. `acceptSqliteDatetimeText: true` (needs `preserveInteger: false`; refused at manifest parse otherwise) also accepts TEXT written by SQLite's `datetime()` / `CURRENT_TIMESTAMP`, exactly `YYYY-MM-DD HH:MM:SS[.SSS]` read as UTC, for a column Prisma wrote as integers and raw SQL wrote as text. Anything else (a `T`, an offset, other formats, an impossible date) stays `CODEC_INVALID`. Converting back writes the INTEGER form, so a reverse clone normalises those rows to integers |
| `json-text` | TEXT JSON | `text` by default, or set `pgType: 'text' \| 'json' \| 'jsonb'`. Without `pgType`, `preserveText: true` (default) means `text` and `false` means `jsonb`; giving both with values that disagree is refused at manifest parse | invalid JSON, `NaN` / `Infinity` / `-Infinity` tokens (Python's `json.dumps` emits them), duplicate object keys at any depth (no engine keeps both) and nesting deeper than 512 levels are refused; `jsonb` reorders keys, so compare via `canonical`, while `text` and `json` (Postgres `json` stores its input verbatim) compare the exact stored text |
| `timestamp-naive` | TEXT exactly `YYYY-MM-DD HH:MM:SS` or `YYYY-MM-DD HH:MM:SS.f` (1-6 fractional digits): SQLAlchemy's SQLite DATETIME storage | `timestamp without time zone` only (no `preserveText`; use `text` to keep the text) | a `T`, an offset, `Z`, an impossible date or non-TEXT storage is `CODEC_INVALID`; years outside 0001-9999 are lossy. `canonical` is `YYYY-MM-DDTHH:MM:SS.ffffff`; converting back writes the 6-digit form, so a reverse clone normalises the 19-char form. Not allowed in a primary key (`primary-key-order-unsupported`) |
| `date-text` | TEXT `YYYY-MM-DD` (a real calendar date) | `date` | anything else is `CODEC_INVALID`; `canonical` is the same `YYYY-MM-DD` |
| `blob` | Buffer | `bytea` | canonical form is the sha256 hex |
| `uuid-text` | TEXT | `uuid` | written back lowercase |

The preserve options default to `true`: an engine move keeps existing contracts as they are, and only an explicit `false` changes the Postgres column type.

A table that must not be copied (an ORM's migration ledger such as `_prisma_migrations`, a derived search table) is still declared, as `{ copy: false, reason: '...' }`: so an UNDECLARED table stays an error, but it is never copied, verified, counted for emptiness or truncated, and is allowed to exist on either side or neither. A foreign key between a skipped table and a copied one is refused (`foreign-key-to-skipped-table`) in both directions. `parseCodecManifest` returns the copied tables in `tables` and the skipped ones in `skipped`.

Every column declares `nullable` (required). NULL into a non-nullable column is a `CodecError` (`CODEC_NULL`) naming `table.column`, as is every invalid (`CODEC_INVALID`) or lossy (`CODEC_LOSSY`) value; the message names the column and the reason, never the value. A column with `generated: true` is verified but excluded from `copyColumns(table)`.

`canonical(value, dialect)` returns a dialect-independent string for exact comparison (timestamps as microsecond UTC ISO, JSON with sorted keys, decimals normalised, blobs as sha256 hex, booleans as `true`/`false`) and `null` for a nullable NULL. A column that **preserves** its stored form (`preserveText: true` / `preserveInteger: true`, the default) compares the exact stored text or integer: `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z`, or `{"a":1}` and `{ "a": 1 }`, are different values there, and equal only when the codec actually converts. JSON numbers are compared as exact decimals (`1`, `1.0`, `1e0` and `10e-1` are equal; integers past 2^53 stay distinct) and strings byte-exact after escape normalisation.

`validateManifest` fails on: an undeclared table or column (named, with the side it was found on), a declared table or column missing from either side, a `generated` flag that does not match each engine, and a codec whose expected Postgres type is not the real column type. `ok` is true only with zero issues; `report` is the human-readable form.

## Clone (`@andrewpopov/db-kit/clone`, `db-kit clone --plan-only | --dry-run | --execute`)

SQLite to Postgres clone. `--plan-only` does everything that happens **before** anything is written; `--execute` runs the plan in one Postgres transaction and commits an exactly verified copy or leaves the target logically unchanged; `--dry-run` does all of it, verification included, then ROLLBACK (not free: it writes WAL and leaves dead tuples). The target schema comes from the app's own Postgres migrations; clone never creates it (its only DDL is the temporary foreign-key drop/re-add and the `db_kit` receipt table).

```
DB_KIT_TARGET_URL=postgres://... db-kit clone --from-live /srv/app/data/app.db --manifest manifest.json \
  --writers-stopped (--plan-only | --dry-run | --execute) [--topology cluster.json] [--confirm-production host:port/db] [--truncate] [--json] [--commit-poll-seconds 30]
```

- **Target URL only from the environment** (`DB_KIT_TARGET_URL`), never argv. Exit codes: `0` plan has no refusals / dry run verified / COMMITTED, `1` refused or failed with the target unchanged, `2` usage error, `4` COMMIT ABORTED (nothing committed), `5` COMMIT outcome UNKNOWN (inspect `db_kit.clone_receipt` and the target before doing anything; never re-run blindly).
- **Snapshot** (`takeSnapshot({ livePath, writersStopped })`): refuses without `writersStopped: true` (operator attestation that every writer is stopped). With writers stopped it first runs `PRAGMA wal_checkpoint(TRUNCATE)` on the live database (a WAL database's `-wal` usually still exists at cutover) and refuses with `live-checkpoint-blocked` if the checkpoint is busy or the `-wal` is not empty afterwards (someone still holds it). It then takes the write lock (`BEGIN IMMEDIATE`) and holds it until the after-evidence is read, so a writer that was not stopped is refused (`live-writer-active`) in either journal mode while readers, db-backup included, are unaffected. It then takes the copy with `@andrewpopov/db-backup`'s `createSqliteSnapshot` into a private `0700` temp directory, records the copy's sha256, and refuses if the live main file's size, mtime or sha256, or the `-wal` size, differ before and after the copy (`-shm` is ignored: every reader touches it). The copy must pass `PRAGMA integrity_check`, `foreign_key_check` and be UTF-8. The directory is removed on every exit path.
- **Target identity**: one `pg.Client`, one `READ ONLY` transaction, `search_path = ''`, catalog reads from `pg_catalog`. Prints `system_identifier`, database, address and version; refuses a standby (`pg_is_in_recovery()`). A target is non-production only when host, port, `system_identifier` and database ALL match a `"production": false` entry of the `--topology` JSON (an array of `{host, port, systemIdentifier, database, production}`, or `{"entries": [...]}`); otherwise `--confirm-production` must equal `host:port/database`. No topology means production.
- **Schema gate** beyond `validateManifest`: real primary keys equal the manifest's; NOT NULL agrees with `nullable`; refuses non-internal triggers (any enable mode), rules, row level security, partitioned or inherited tables, NOT VALID foreign keys, comments on a foreign key, any event trigger in the database, a publication covering a copied table, any subscription, a sequence that is unowned, shared between columns, or cycling (including a CHECK constraint, index expression, generated column or column-type domain that calls a volatile function such as `nextval` (`volatile-expression`: it would advance the sequence during COPY and survive a rollback), a late-bound `nextval('x'::text)` default anywhere in the database, which has no dependency to follow: `sequence-dynamic-default`), a publication that is FOR ALL TABLES or covers schema `db_kit` (it would adopt the receipt table), NOT VALID foreign keys into a copied table from uncopied tables, and (with `--truncate`) a foreign key into a copied table from a table that is not copied. A foreign table is not a base table, so a manifest that declares one fails `validateManifest`.
- **Capabilities and state**: ownership of every copied table, `CREATE` for schema `db_kit` (the receipt schema, outside manifest coverage; an existing `db_kit.clone_receipt` must have the exact expected columns and primary key and no RLS, triggers, rules or publication membership), non-empty copied tables (refused unless `--truncate`), a WAL archiver failure in the last 15 minutes, a replication slot retaining more than 5 GiB.
- **Source data**: TEXT containing NUL in a copied non-blob column is refused naming `table.column`.
- **Plan output**: target identity, per-table rows and estimated bytes, the foreign keys that will be dropped and re-added (with `confrelid`, `conkey`, `confkey`, `conpfeqop`, `confupdtype`, `confdeltype`, `confmatchtype`, `confdelsetcols`, deferrable/deferred, validated, the referenced index), incoming references from uncopied tables, each sequence with its computed `RESTART WITH` (extreme in the sequence's direction, plus `sqlite_sequence` for AUTOINCREMENT, plus the increment; refused when outside min/max; `null` for an empty table), and every refusal.
- **Errors** are an allowlisted code plus table/column/object identity (`CLONE_REFUSAL_CODES`), never a driver message, value, SQL or URL.

### Execution

One `pg.Client`, one transaction (`lock_timeout` 10 s, `statement_timeout` 0, `search_path` empty, `row_security` off). The order is: verified snapshot; `LOCK TABLE ... ACCESS EXCLUSIVE` on every copied and FK-related table in name order; the **whole preflight again under the locks** (authoritative; any refusal aborts); `TRUNCATE ... RESTRICT` over the copied set if `--truncate` and something is there; `DROP CONSTRAINT` for the foreign keys of copied tables; `COPY ... FROM STDIN` per table in manifest order; re-`ADD CONSTRAINT` with the identical definition (Postgres re-validates) and a field-by-field comparison with the captured catalog rows (`foreign-keys-changed` on any difference); `ALTER SEQUENCE ... RESTART [WITH n]`; verification; the receipt; COMMIT. Nothing here uses `session_replication_role`, `nextval` or `setval`.

- **Load**: SQLite TEXT is read as its stored bytes and refused if it is not valid UTF-8 (`source-invalid-utf8`; checked in the plan, again at load and at verify, since a lossy decode would verify against itself). SQLite is read with 64-bit integers as `bigint`, ordered by primary key (`COLLATE BINARY` on text keys, uuid text lowercased, never the column's declared collation), converted by each column's codec and streamed as COPY text (backslash, tab, newline, CR escaped; `\N` for NULL; bytea as `\\x` hex; generated columns omitted). Memory is one ~1 MiB chunk plus the stream's buffer, never a table; backpressure is honoured.
- **Verification**: every declared column (generated ones too) of every table is compared row by row, in primary-key order, between a second independent read of the snapshot and the target read through a server-side cursor (5000 rows per fetch; `COLLATE "C"` on text keys). Rows are compared as a versioned, type-tagged, length-prefixed encoding of the codecs' canonical forms; the per-table SHA-256 over those encodings is the receipt. The first difference refuses naming table and column, never a value. A primary key whose order differs between the SQLite text and the converted Postgres type (`decimal-as-string`, converting `timestamp-iso` or `json-text`) is refused up front (`primary-key-order-unsupported`).
- **Receipt and COMMIT outcome**: `db_kit.clone_receipt(run_id uuid primary key, started_at timestamptz, manifest_sha text, per_table jsonb)` gets one row before COMMIT, and `txid_current()` is recorded. No COMMIT error is proof of anything (a pooler can give up after the server committed), so the transaction's own `txid_status` decides: asked on the same connection first, then, if that is gone, clone reconnects, re-checks `system_identifier` and database, and polls `txid_status` (bounded by `--commit-poll-seconds`; "in progress" keeps waiting). It reports COMMITTED (the result says `acknowledged: false`), ABORTED or UNKNOWN, and never retries the COMMIT. The receipt row is evidence, not the barrier. The receipt table is locked with the copied tables and re-validated (no trigger, rule, RLS or publication) before the insert. If removing the temporary snapshot fails after the outcome is known, the outcome is kept and reported with `cleanupWarning` / `cleanupFailed` and a stderr warning.
- **Progress and timing**: one line per table and phase on stderr (suppressed with `--json`); the result carries per-table rows, load/verify seconds, rows/s and the digests. `scripts/clone-perf.mjs` generates a fidash-shaped synthetic SQLite of N GB and times plan, load, verify and commit against a throwaway target (`DB_KIT_TARGET_URL=... node scripts/clone-perf.mjs --gb 1 --reset`). Measured locally (M-series Mac, embedded Postgres 17, 0.9 GB file, 3.1 M rows): load 328 k rows/s (96 MB/s), verify 116 k rows/s, 45 s end to end, peak RSS 521 MB (463 MB at a tenth of the size).

## Testing on both dialects (`@andrewpopov/db-kit/testing`)

A subpath, never loaded by the root entry. It needs two OPTIONAL peers the app installs as **devDependencies**: `embedded-postgres` (a real throwaway Postgres; it never enters the production dependency tree) and `vitest` (only for `describeEachDialect`; `startTestPostgres`, `createTestDatabase` and `compareSchemas` work under any runner). If `embedded-postgres` is missing, `startTestPostgres` throws a `DbKitError` that says to `npm i -D embedded-postgres`.

```ts
import { describeEachDialect, compareSchemas, startTestPostgres, createTestDatabase } from '@andrewpopov/db-kit/testing';

describeEachDialect('orders repository', ({ dialect, url, open }) => {
  it('saves and reads an order', async () => {
    const handle = open();            // a db-kit handle on a fresh SQLite file / a fresh Postgres database
    await migrate(handle);            // your app's own migration, per dialect
    // ... url() is the database's URL if you need it
  });
});
```

- `startTestPostgres({ extraFlags?, locale?, tls? })` returns `{ url, config, caPem, startupMs, stop() }`: a real Postgres in a temp directory on a random free port with password auth (no TLS unless `tls: { san? }`, which needs `openssl`). `locale` is `'C'`, a libc locale name, or `'icu:en-US'` (a server built with ICU). `createTestDatabase(server)` makes a fresh `test_<random>` database and returns `{ name, url, config, release() }`; `release()` drops it (open connections are terminated).
- `describeEachDialect(name, fn, opts?)` runs `fn({ dialect, url, open })` inside `describe('<name> [sqlite]')` and `describe('<name> [postgres]')`: a throwaway SQLite file, and a fresh database on one Postgres server shared by the whole test file (stopped after the file). `url()` and `open()` are functions to call inside tests (`fn` itself runs at collection time); handles from `open()` are closed afterwards. `DB_KIT_TEST_DIALECTS=sqlite|postgres|both` (default both) narrows a run, and a mistyped value throws. **If Postgres is requested and cannot start, its suite fails; it is never skipped.** (vitest lists the tests of a suite whose `beforeAll` threw as skipped under a FAILED suite, and the run exits non-zero.)
- `compareSchemas(sqliteHandle, pgHandle, { allow?, schema? })` returns `{ ok, differences, allowed, report }`: the schema your migration produced on each side, compared on tables, columns (logical type class, nullability, default presence), primary keys, unique constraints, indexes (partial `WHERE` and expression indexes included) and CHECK constraints. A unique index of plain columns counts as a unique constraint. Index and check expressions are compared after normalising case, quoting, whitespace, parentheses and Postgres casts; names only label a difference. Record intentional differences in `allow` (`{ kind?, table?, name? }`, each given field must match), for example a column that is `boolean` on Postgres and `integer` on SQLite: `{ kind: 'column-type', table: 'users', name: 'active' }`. A dropped partial index on either side fails by name.

Where `embedded-postgres` has actually run (the spike): macOS arm64 with Node 24.14 (local development; first start of a fresh install took 53 s on a busy machine, later starts about 3 to 4 s), `skybox` (linux/x64, Node 24.16, a start takes about 2 s; the full suite including its real-Postgres tests passes there) and `wintop` (the same suite passed there on earlier lane runs, as their `lane: running on wintop` lines show; its platform and architecture were not recorded). Linux aarch64 (bigpi) has NOT been tested with embedded-postgres: the clone throughput harness was only run locally.

### Reverse clone: Postgres to SQLite (the rollback window)

`db-kit clone --reverse --to-sqlite <new path> --sqlite-template <file> --manifest <file> --writers-stopped [--dry-run] [--topology f] [--confirm-production host:port/db] [--json]`, or `reverseClone(options)` from `@andrewpopov/db-kit/clone`. Stop and drain every writer first (`--writers-stopped` is your attestation), then flip `DATABASE_URL` yourself afterwards. The source URL comes from `DB_KIT_SOURCE_URL` only. Exit codes: `0` written (or dry run verified), `1` refused (nothing at the target path), `2` usage, `3` PUBLISHED WITH WARNINGS: the SQLite file is in place and verified, but a later step failed (`warnings`: `temp-not-removed`, `directory-fsync-failed`, `receipt-not-written`). Never treat 3 as "target unchanged".

- **The target is a NEW file** that must not exist (a dangling symlink counts); neither may its `-journal`, `-wal`, `-shm` (a hot journal would be replayed over the verified file) or `.receipt.json`, checked before the load and again just before publishing (`sqlite-target-exists`, with the suffix as the object). Its schema is your app's own SQLite migrations, supplied as an already-migrated EMPTY **template** file that is copied (SQLite's backup API, so a WAL template is fine) and never modified or created by clone; a template with rows in a copied table, a damaged one, or one that does not match the manifest is refused. A template's journal mode is kept. Tables declared `copy: false` keep whatever the template holds, such as its own migration ledger.
- **Source**: one `pg.Client` in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` with `row_security` off, a pinned session (UTC, ISO dates, `bytea_output=hex`, `extra_float_digits=3`, both as startup options and again with `SET LOCAL`, since a role or database default of `escape` or `0` would otherwise change what both sides of a verification read) and fixed type parsers (the bytea parser rejects anything but hex); identity and production confirmation as for the forward clone; a standby is refused (`source-in-recovery`).
- **Load** into a hidden temp file in the target's directory, in one SQLite transaction with `foreign_keys` off: each value through the codec's `toSqlite` (lossy values refuse by `table.column`: `-0`, a timestamp finer than the epoch unit, values outside SQLite's ranges), generated columns omitted. Then `PRAGMA foreign_key_check` must be empty (`sqlite-foreign-key-violation`) and `integrity_check` ok (`sqlite-integrity-failed`) before COMMIT. For an AUTOINCREMENT table whose integer key owns an ascending Postgres sequence, `sqlite_sequence` becomes the highest id that sequence ever issued (never below the rows present), so ids are not reused.
- **Verify** every table row by row against a second read of the same Postgres snapshot, in the same key order (Postgres `COLLATE "C"`, SQLite `COLLATE BINARY`), on the same canonical encoding as the forward clone.
- **Only then**: fsync, a no-clobber hard-link of the temp file into place (a file that appeared meanwhile is never overwritten), fsync of the directory, and `<path>.receipt.json`, itself linked without clobbering (run id, source identity, manifest hash, the file's sha256, per-table counts and digests). The database file is the commit point. Numeric options (`fetchRows`, `batchBytes`, `lockTimeoutMs`, `commitPollMs`, `maxSlotRetentionBytes`, `--commit-poll-seconds`) are validated up front and refused as `invalid-option` naming the option (`fetchRows: 0` would otherwise "verify" empty tables). A killed process leaves no file at the target path, only a hidden `.<name>.db-kit-tmp-*` file you can delete.

## URL forms

**SQLite**, `file:` and `sqlite:` are equivalent:

| URL | Meaning |
|---|---|
| `file:app.db`, `file:./app.db` | relative to the process cwd at open time |
| `file:/abs/app.db`, `file:///abs/app.db` | absolute |
| `file::memory:` | private in-memory database |

No query string, fragment or authority (`file://host/x` is refused). Paths are percent-decoded.

**Postgres**, `postgres:` and `postgresql:`:
`postgres://[user[:password]@]host[:port]/database[?sslmode=...]`. Port defaults to 5432. Percent-encode special characters in user and password. Accepted query keys: `sslmode`, `user`, `password` (a password may be given in the userinfo or as `?password=`, not both). Anything else is an error.

Any other scheme is rejected.

## Defaults

SQLite (each applied and **read back**; a mismatch throws `SQLITE_PRAGMA_UNVERIFIED`): `journal_mode=WAL` (in-memory databases are exempt; `readonly: true` does not request it), `busy_timeout=5000` (`busyTimeoutMs`), `foreign_keys=ON`, `synchronous=NORMAL`.

Postgres (`PostgresOptions`): `applicationName` (**required**, appears in `pg_stat_activity`), `statementTimeoutMs=30000` (server-side, per connection, sent as a startup option; 0 disables and overrides any role/database default), `poolSize=10`, `idleTimeoutMs=30000`, `connectionTimeoutMs=10000`, `healthTimeoutMs=5000` (bounds the whole `select 1`; `health()` uses its own short-lived connection, destroyed on timeout, so a stuck probe never holds a pool slot), `tlsCa` (PEM, for a private CA), `onPoolError`.

### sslmode (default `disable`)

| mode | TLS | certificate chain | hostname |
|---|---|---|---|
| `disable` | no | n/a | n/a |
| `require` | yes | not verified | not verified |
| `verify-ca` | yes | verified | not checked |
| `verify-full` | yes | verified | **verified** |

Use `verify-full` for anything off the machine. `require` only encrypts; it does not stop an active attacker.

## Redaction guarantee

The password is never in: `describe()` output, any `DbKitError` message, or an error produced by a connect failure (wrong password, unreachable host), including its `cause` chain and `String(err)`. Parse errors never quote the URL. Postgres driver errors surfaced by `health()` and `close()` are re-created with the password removed; the original is deliberately not attached as `cause`. Errors thrown by calling `handle.pool` directly are the driver's own: they carry no password today (the driver never echoes it), but that is the driver's behaviour, not this kit's. `describe()` still shows the user name and host.

## Tests

`npm test` starts a real throwaway Postgres (`embedded-postgres`, temp dir, random port, password auth, self-signed TLS) so both dialects are always exercised; nothing is skipped. First run downloads the platform binary through npm.
