---
kind: added
summary: Per-column codec manifest (parseCodecManifest, buildCodecs, validateManifest) for moving data between SQLite and Postgres
---

Apps declare each column's logical type once; nothing is inferred. Twelve codecs (`text`, `integer`, `bigint`, `real`, `decimal-as-string`, `boolean`, `timestamp-iso`, `timestamp-epoch-s`, `timestamp-epoch-ms`, `json-text`, `blob`, `uuid-text`) convert values both ways (`toPostgres`/`toSqlite`) and render a dialect-independent `canonical` string for exact comparison. NULL handling is explicit per column, and a lossy or invalid value is a `CodecError` naming table.column (never the value). `introspectSqlite`/`introspectPostgres` plus `validateManifest` fail on undeclared columns, declared-but-missing columns, `generated` mismatches and codec/Postgres-type mismatches. `POSTGRES_CODEC_TYPES` is the `pg` `types` option the codecs expect on reads. `DbKitErrorCode` gains `INVALID_MANIFEST`, `CODEC_NULL`, `CODEC_INVALID`, `CODEC_LOSSY`.
