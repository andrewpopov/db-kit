---
kind: added
summary: parseDatabaseUrl, describe, openSqlite, openPostgres, openDatabase and a Drizzle helper (config + connect)
---

Open SQLite or Postgres from a `DATABASE_URL`. SQLite applies and verifies WAL, busy_timeout, foreign_keys and synchronous=NORMAL; Postgres applies a per-connection statement_timeout, a required application_name and TLS from `sslmode`. `describe()` and every error message redact the password. `drizzleFor` lives on the `@andrewpopov/db-kit/drizzle` subpath (optional `drizzle-orm` peer). Requires Node `^22.12 || ^24 || >=26`.
