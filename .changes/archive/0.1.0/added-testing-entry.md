---
kind: added
summary: "@andrewpopov/db-kit/testing: startTestPostgres, createTestDatabase, describeEachDialect and compareSchemas for apps' dual-dialect tests"
---

A new subpath (not loaded by the root entry) so apps can test on SQLite and Postgres. `startTestPostgres` starts a real throwaway Postgres (optional peer `embedded-postgres`, installed as a devDependency; a clear error if it is missing) and `createTestDatabase` hands out and drops `test_<random>` databases. `describeEachDialect` (vitest) runs a test body once on a SQLite file and once on a fresh Postgres database, one shared server per test file, narrowed by `DB_KIT_TEST_DIALECTS`; a Postgres that cannot start fails the suite instead of skipping it. `compareSchemas` diffs the schema a migration produced on each dialect (tables, columns, keys, uniques, partial and expression indexes, CHECKs) with an allow-list of intentional differences.
