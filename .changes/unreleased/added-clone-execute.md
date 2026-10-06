---
kind: added
summary: db-kit clone --execute / --dry-run and executeClone (SQLite to Postgres load with exact verification)
---

`executeClone` copies a verified SQLite snapshot into an already-migrated Postgres database in one transaction: table locks, the preflight re-run under them, optional TRUNCATE, foreign keys dropped and re-added with their catalog fields compared, streaming `COPY` (bounded memory), a row-by-row verification against a second read of the snapshot (per-table SHA-256 receipt), sequence restarts, and a `db_kit.clone_receipt` row. A lost COMMIT acknowledgement is resolved through `txid_status` and reported as COMMITTED, ABORTED or UNKNOWN (CLI exit codes 0, 4, 5). `--dry-run` runs everything and rolls back. `scripts/clone-perf.mjs` measures throughput on a synthetic fidash-shaped database. `DbKitErrorCode` gains `CLONE_OUTCOME`; primary keys that reorder on conversion are refused.
