# db-kit project guidelines

`@andrewpopov/db-kit`: fleet database toolkit. Open SQLite (`better-sqlite3`) or
Postgres (`pg.Pool`) from a `DATABASE_URL` with fleet-standard settings, and a
log-safe description of the connection. Status: in progress (PKG-175; v0.1 scope
item 1, config + connect). The codec manifest landed in PKG-176; clone and cluster ops arrive in later tickets.
Fleet-wide package rules live in `packages-meta`; this package's source and packed
exports are authoritative. Prisma apps keep `@andrewpopov/prisma-tools` for provider
selection; this kit is for Drizzle/raw-driver apps.

## Layout

- `src/url.ts`: `parseDatabaseUrl` / `describe`, the zod config schema (discriminated on `dialect`).
- `src/sqlite.ts`, `src/postgres.ts`: one `open*` each; `src/open.ts` dispatches on dialect.
- `src/drizzle.ts`: `drizzleFor`, on the `./drizzle` subpath so `drizzle-orm` stays an optional peer.
- `src/codecs/`: the per-column codec manifest (PKG-176). `manifest.ts` (zod schema), `implementations.ts` (each codec parses
  either dialect into one logical value and renders it back; `canonical` renders it for comparison), `bound.ts` (NULL rule +
  `CodecError` naming table.column), `introspect.ts`, `validate.ts`, `pg-types.ts` (`POSTGRES_CODEC_TYPES`, the `pg` read config).
- `src/clone/` (PKG-177a part 1, subpath `./clone`, bin `db-kit`): `snapshot.ts` (verified snapshot via `@andrewpopov/db-backup`), `catalog.ts` (every target catalog read), `rules.ts` (facts to refusals), `source.ts` (snapshot scan, sequence restart values), `plan.ts` (`planClone`), `errors.ts` (the refusal-code allowlist), `cli.ts`; part 2 adds `execute.ts` (the one-transaction clone), `load.ts` (COPY text), `verify.ts` (row-by-row verification), `order.ts` (key ordering on both sides). `scripts/clone-perf.mjs` is the throughput harness.
- `src/testing/` (PKG-181, subpath `./testing`): `postgres.ts` (`startTestPostgres`, `createTestDatabase`; `embedded-postgres` is an optional peer loaded lazily), `dialects.ts` (`describeEachDialect`; vitest loaded lazily), `parity.ts` (`compareSchemas`). `src/test-support/embedded-pg.ts` is this repo's own thin wrapper over it. `src/testing/fixtures/` is run only by a child vitest and is not built.
- `src/errors.ts`: `DbKitError` (typed codes) and `scrubError`.
- `src/test-support/embedded-pg.ts`: starts a real throwaway Postgres (`embedded-postgres`, temp dir,
  random port, password auth, TLS with a self-signed cert). Never skip the Postgres tests: a skipped dialect is rot.
- ESM-only (`"type": "module"`, NodeNext). `dist/` is tracked: consumers install from a git tag.

## Design decisions

- **The password never reaches a message.** Parse errors are built from structural facts (scheme,
  field names), never the URL. Driver errors from Postgres are re-created by `scrubError` (message
  and code scrubbed, original NOT kept as `cause`). `describe()` prints `***`. Keep it that way:
  never interpolate a URL or `config.password` into an error.
- **Settings are verified, not assumed.** SQLite pragmas are read back after being set and a
  mismatch throws `SQLITE_PRAGMA_UNVERIFIED`. Postgres `statement_timeout` is a per-connection startup parameter.
- **sslmode defaults to `disable`** (what `pg` does without TLS); remote databases must say
  `require`, `verify-ca` or `verify-full` explicitly. Only `verify-full` checks the hostname.
- `applicationName` has no default on purpose: it is how an operator finds a connection in `pg_stat_activity`.

- **Codecs never infer and never echo a value.** A column's logical type is declared; `CodecError` messages name
  table.column and the reason only, since a value may be personal data. The `preserve*` options default to `true`
  (an engine move keeps existing contracts); only an explicit `false` changes the Postgres column type.

## Rules

- Every export is a compatibility commitment; add a `.changes/unreleased/` fragment for any
  user-visible change (see `RELEASING.md`). Do not hand-edit `CHANGELOG.md`.
- Dependencies: `better-sqlite3` must stay `^13` (older aborts on Node 24.19+).

## Verify

`npm ci && npm run verify` (typecheck, tests incl. real Postgres, build, dist freshness, pack
smoke, audits). `verify:dist-fresh` needs `src/` and `dist/` committed first. The committed
`.githooks/pre-push` runs the same chain.
