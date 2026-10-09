---
kind: added
summary: Postgres to SQLite export for apps: exportToSqlite and runExportSqliteCli on @andrewpopov/db-kit/clone, with a ledger-mismatch refusal
---

`exportToSqlite` and `runExportSqliteCli` move the generic half of an app's Postgres to SQLite swap-back into db-kit: the app supplies its manifest, a template builder and its ledger ids; db-kit builds the template, checks the ledger, runs `reverseClone` and smoke-opens a copy. New refusal code `ledger-mismatch`; `CloneRefusal` accepts an optional message.
