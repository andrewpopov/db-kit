---
kind: fixed
summary: clone preflights no longer refuse equal keys or miss unequal ones, count TEXT integers, scan orphans in linear time; json pgType keeps duplicate keys
---

The orphan-foreign-keys preflight now runs only for keys where raw SQLite equality is Postgres equality (integer/bigint codecs over INTEGER storage, or text codecs over TEXT storage compared `COLLATE BINARY`); other keys are listed as `orphan-check-skipped` in the plan (`skippedChecks`) and left to the re-`ADD CONSTRAINT` safety net, so equal timestamps, UUIDs and `'01'`/`'1'` are no longer refused and `NOCASE`/`RTRIM` columns no longer hide an orphan. The scan is a `LEFT JOIN` (linear, 0.21 s for 1M x 1M with an unindexed parent key; the correlated lookup was quadratic). `integer-width` now counts decimal-integer TEXT the codec accepts. `json-text` with `pgType` `text` or `json` accepts duplicate object keys (stored verbatim); `jsonb` still refuses them.
