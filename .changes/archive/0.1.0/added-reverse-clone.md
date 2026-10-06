---
kind: added
summary: copy:false manifest tables and db-kit clone --reverse (Postgres to a fresh SQLite file)
---

A manifest table can be declared `{ copy: false, reason }`: still declared (undeclared tables stay an error), never copied, verified, emptied or truncated, and a foreign key between it and a copied table is refused. `reverseClone` / `db-kit clone --reverse` copies a REPEATABLE READ snapshot of Postgres into a new SQLite file made from your own empty migrated template: codecs `toSqlite` with lossy values refused by name, `foreign_key_check` and `integrity_check` before COMMIT, row-by-row verification against a second read of the snapshot, `sqlite_sequence` set from the Postgres sequence high-water, then an fsynced no-clobber hard-link into place with a receipt JSON beside it. A killed run leaves nothing at the target path. `parseCodecManifest` now returns `skipped` next to `tables`; `TableInput` is exported.
