---
kind: fixed
summary: canonical() of a preserved timestamp-iso, epoch or json-text column is now the exact stored value
---

With `preserveText`/`preserveInteger` set (the default) the column is stored verbatim, so `canonical` no longer normalises instants, whitespace, key order or number spelling: `2026-01-01T00:00:00Z` and `2026-01-01T00:00:00.000Z`, or `{"a":1}` and `{ "a": 1 }`, now compare unequal. Normalising canonical forms apply only when the codec converts (`preserve* : false`).
