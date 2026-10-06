---
kind: added
summary: db-kit clone --plan-only and @andrewpopov/db-kit/clone (SQLite to Postgres clone preflight: verified snapshot, target gate, plan)
---

New `@andrewpopov/db-kit/clone` subpath and `db-kit` bin. `takeSnapshot` refuses without `writersStopped`, snapshots through `@andrewpopov/db-backup` into a private temp directory and refuses on any live-file change or failed integrity/foreign-key/UTF-8 check. `planClone` reads the Postgres target in one read-only transaction (identity, topology/production confirmation, schema gate, ownership, emptiness, archiver and replication-slot health) and returns the per-table counts, the foreign keys that will be dropped and re-added, the sequence restart values and every refusal, as an allowlisted code plus table/column identity. The target URL is read only from `DB_KIT_TARGET_URL`. The transactional load is not included yet. `DbKitErrorCode` gains `CLONE_REFUSED`.
