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

Read Postgres with `pool.query({ text, values, types: POSTGRES_CODEC_TYPES })` on a handle opened with `postgres: { applicationName, codecSession: true }`: timestamptz and json/jsonb must arrive as raw text (the default parsers round to milliseconds and pre-parse JSON), and `codecSession` pins `TimeZone=UTC` and `DateStyle=ISO, YMD` so that text is deterministic (the parser also accepts second-resolution offsets such as `+00:09:21`). Values are never inferred and never coerced silently.

| codec | SQLite value | Postgres column | notes |
|---|---|---|---|
| `text` | TEXT | `text` | |
| `integer` | INTEGER | `bigint` (`integer`/`smallint` also accepted) | safe JS integer only; beyond 2^53 is a `CODEC_LOSSY` error |
| `bigint` | INTEGER as `bigint` | `bigint` | a bigint end to end, never a JS number; outside int64 is lossy |
| `real` | REAL | `double precision` | NaN and Infinity are refused, and `-0` is refused on the way into SQLite (it stores 0) |
| `decimal-as-string` | TEXT | `numeric` | exact; plain numeric text only (no exponent, NaN, JS number) |
| `boolean` | exactly `0` or `1` | `boolean` | `2`, `'1'`, `true` are refused |
| `timestamp-iso` | TEXT ISO-8601 with an explicit offset | `text` by default (`preserveText: true`), or `timestamptz` (`preserveText: false`) | sub-microsecond precision and years outside 0001-9999 are lossy; converting back writes UTC `...Z` text |
| `timestamp-epoch-s`, `timestamp-epoch-ms` | INTEGER | `bigint` by default (`preserveInteger: true`), or `timestamptz` (`preserveInteger: false`) | converting back refuses sub-second / sub-millisecond values |
| `json-text` | TEXT JSON | `text` by default (`preserveText: true`), or `jsonb` (`preserveText: false`) | invalid JSON, duplicate object keys at any depth (no engine keeps both) and nesting deeper than 512 levels are refused; jsonb reorders keys, so compare via `canonical` |
| `blob` | Buffer | `bytea` | canonical form is the sha256 hex |
| `uuid-text` | TEXT | `uuid` | written back lowercase |

The preserve options default to `true`: an engine move keeps existing contracts as they are, and only an explicit `false` changes the Postgres column type.

Every column declares `nullable` (required). NULL into a non-nullable column is a `CodecError` (`CODEC_NULL`) naming `table.column`, as is every invalid (`CODEC_INVALID`) or lossy (`CODEC_LOSSY`) value; the message names the column and the reason, never the value. A column with `generated: true` is verified but excluded from `copyColumns(table)`.

`canonical(value, dialect)` returns a dialect-independent string for exact comparison (timestamps as microsecond UTC ISO, JSON with sorted keys, decimals normalised, blobs as sha256 hex, booleans as `true`/`false`) and `null` for a nullable NULL. A column that **preserves** its stored form (`preserveText: true` / `preserveInteger: true`, the default) compares the exact stored text or integer: `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z`, or `{"a":1}` and `{ "a": 1 }`, are different values there, and equal only when the codec actually converts. JSON numbers are compared as exact decimals (`1`, `1.0`, `1e0` and `10e-1` are equal; integers past 2^53 stay distinct) and strings byte-exact after escape normalisation.

`validateManifest` fails on: an undeclared table or column (named, with the side it was found on), a declared table or column missing from either side, a `generated` flag that does not match each engine, and a codec whose expected Postgres type is not the real column type. `ok` is true only with zero issues; `report` is the human-readable form.

## Clone preflight (`@andrewpopov/db-kit/clone`, `db-kit clone --plan-only`)

SQLite to Postgres clone, part 1: everything that happens **before** anything is written. The load itself (transaction, FK drop/re-add, sequences, receipt, verification) is not in this build, so `db-kit clone` without `--plan-only` exits 2. The target schema comes from the app's own Postgres migrations; clone never creates it.

```
DB_KIT_TARGET_URL=postgres://... db-kit clone --from-live /srv/app/data/app.db --manifest manifest.json \
  --writers-stopped --plan-only [--topology cluster.json] [--confirm-production host:port/db] [--truncate] [--json]
```

- **Target URL only from the environment** (`DB_KIT_TARGET_URL`), never argv. Exit codes: `0` plan has no refusals, `1` refused, `2` usage error or unsupported operation.
- **Snapshot** (`takeSnapshot({ livePath, writersStopped })`): refuses without `writersStopped: true` (operator attestation that every writer is stopped). With writers stopped it first runs `PRAGMA wal_checkpoint(TRUNCATE)` on the live database (a WAL database's `-wal` usually still exists at cutover) and refuses with `live-checkpoint-blocked` if the checkpoint is busy or the `-wal` is not empty afterwards (someone still holds it). It then takes the write lock (`BEGIN IMMEDIATE`) and holds it until the after-evidence is read, so a writer that was not stopped is refused (`live-writer-active`) in either journal mode while readers, db-backup included, are unaffected. It then takes the copy with `@andrewpopov/db-backup`'s `createSqliteSnapshot` into a private `0700` temp directory, records the copy's sha256, and refuses if the live main file's size, mtime or sha256, or the `-wal` size, differ before and after the copy (`-shm` is ignored: every reader touches it). The copy must pass `PRAGMA integrity_check`, `foreign_key_check` and be UTF-8. The directory is removed on every exit path.
- **Target identity**: one `pg.Client`, one `READ ONLY` transaction, `search_path = ''`, catalog reads from `pg_catalog`. Prints `system_identifier`, database, address and version; refuses a standby (`pg_is_in_recovery()`). A target is non-production only when host, port, `system_identifier` and database ALL match a `"production": false` entry of the `--topology` JSON (an array of `{host, port, systemIdentifier, database, production}`, or `{"entries": [...]}`); otherwise `--confirm-production` must equal `host:port/database`. No topology means production.
- **Schema gate** beyond `validateManifest`: real primary keys equal the manifest's; NOT NULL agrees with `nullable`; refuses non-internal triggers (any enable mode), rules, row level security, partitioned or inherited tables, NOT VALID foreign keys, comments on a foreign key, any event trigger in the database, a publication covering a copied table, any subscription, a sequence that is unowned, shared between columns, or cycling (including a late-bound `nextval('x'::text)` default anywhere in the database, which has no dependency to follow: `sequence-dynamic-default`), a publication that is FOR ALL TABLES or covers schema `db_kit` (it would adopt the receipt table), NOT VALID foreign keys into a copied table from uncopied tables, and (with `--truncate`) a foreign key into a copied table from a table that is not copied. A foreign table is not a base table, so a manifest that declares one fails `validateManifest`.
- **Capabilities and state**: ownership of every copied table, `CREATE` for schema `db_kit` (the receipt schema, outside manifest coverage; an existing `db_kit.clone_receipt` must have the exact expected columns and primary key and no RLS, triggers, rules or publication membership), non-empty copied tables (refused unless `--truncate`), a WAL archiver failure in the last 15 minutes, a replication slot retaining more than 5 GiB.
- **Source data**: TEXT containing NUL in a copied non-blob column is refused naming `table.column`.
- **Plan output**: target identity, per-table rows and estimated bytes, the foreign keys that will be dropped and re-added (with `confrelid`, `conkey`, `confkey`, `conpfeqop`, `confupdtype`, `confdeltype`, `confmatchtype`, `confdelsetcols`, deferrable/deferred, validated, the referenced index), incoming references from uncopied tables, each sequence with its computed `RESTART WITH` (extreme in the sequence's direction, plus `sqlite_sequence` for AUTOINCREMENT, plus the increment; refused when outside min/max; `null` for an empty table), and every refusal.
- **Errors** are an allowlisted code plus table/column/object identity (`CLONE_REFUSAL_CODES`), never a driver message, value, SQL or URL.

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
