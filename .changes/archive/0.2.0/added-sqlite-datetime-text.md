---
kind: added
summary: acceptSqliteDatetimeText for timestamp-epoch-ms / timestamp-epoch-s columns that mix integers and SQLite datetime() text
---

A column Prisma wrote as epoch integers can also hold rows that raw SQL wrote with `CURRENT_TIMESTAMP` or `datetime('now')`. With `acceptSqliteDatetimeText: true` (only with `preserveInteger: false`; the other combination is refused when the manifest is parsed) such a TEXT value is accepted when it is exactly `YYYY-MM-DD HH:MM:SS[.SSS]`, read as UTC, and is the same value as the integer for that instant. Offsets, `T`, other formats and impossible dates are still `CODEC_INVALID` by table.column. Converting back writes the INTEGER form, so a reverse clone normalises those rows. The reverse clone now also binds integer-valued columns as SQLite integers (better-sqlite3 binds a JS number as REAL, which an untyped column keeps).
