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
| `describe(config)` | Log-safe string. Also accepts a raw URL string (regex-redacted if it does not parse). |
| `openSqlite(config, opts)` | `{ dialect, db, health(), close() }`, `db` is a `better-sqlite3` `Database`. |
| `openPostgres(config, opts)` | `{ dialect, pool, health(), close() }`, `pool` is a `pg.Pool`. |
| `openDatabase(url, { sqlite?, postgres? })` | Parse, then dispatch on the scheme. |
| `drizzleFor(handle)` | `drizzle-orm/better-sqlite3` or `drizzle-orm/node-postgres` instance (from `@andrewpopov/db-kit/drizzle`). |
| `DbKitError` | `code`: `INVALID_DATABASE_URL`, `INVALID_OPTIONS`, `SQLITE_PRAGMA_UNVERIFIED`, `SQLITE_OPEN_FAILED`. |

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

Postgres (`PostgresOptions`): `applicationName` (**required**, appears in `pg_stat_activity`), `statementTimeoutMs=30000` (server-side, per connection; 0 disables), `poolSize=10`, `idleTimeoutMs=30000`, `connectionTimeoutMs=10000`, `healthTimeoutMs=5000` (bounds the whole `select 1`), `tlsCa` (PEM, for a private CA), `onPoolError`.

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
