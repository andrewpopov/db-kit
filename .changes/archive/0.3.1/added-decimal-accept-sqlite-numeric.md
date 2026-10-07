---
kind: added
summary: decimal-as-string gains acceptSqliteNumeric for INTEGER/REAL storage on NUMERIC-affinity columns
---

`decimal-as-string` accepts `acceptSqliteNumeric: true` (default false; refused at manifest parse on any other codec) for a column Prisma declares `Decimal` but SQLite stores with NUMERIC affinity, so INTEGER and REAL rows sit beside TEXT and NULL. An INTEGER (number or bigint, exact past 2^53) becomes its decimal string; a REAL becomes the shortest round-trip decimal of the double, written out without an exponent (`1e-7` is `0.0000001`). NaN, Infinity and `-0` are refused. A REAL `0.1` and Postgres `numeric` `0.1` / `0.10` verify as equal. Converting back writes a SQLite number only when exact (an int64 integer, or a decimal that is the shortest digits of a double); anything else is `CODEC_LOSSY`. Without the option behaviour is unchanged.
