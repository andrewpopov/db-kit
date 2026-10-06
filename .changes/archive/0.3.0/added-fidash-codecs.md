---
kind: added
summary: timestamp-naive and date-text codecs, and a pgType option for json-text (text, json or jsonb)
---

`timestamp-naive` maps SQLAlchemy's SQLite DATETIME text (`YYYY-MM-DD HH:MM:SS` with an optional 1-6 digit fraction) to Postgres `timestamp without time zone`, keeping microseconds; a `T`, an offset, `Z` or an impossible date is `CODEC_INVALID`. `date-text` maps `YYYY-MM-DD` text to Postgres `date`. `json-text` gains `pgType: 'text' | 'json' | 'jsonb'`: without it `preserveText` still decides (true is text, false is jsonb), and a `pgType` that disagrees with `preserveText` is a manifest parse error. Postgres `json` stores its input verbatim, so it compares the exact text like `text`. `NaN`, `Infinity` and `-Infinity` tokens are refused for every `pgType`. `POSTGRES_CODEC_TYPES` now reads `timestamp` and `date` as raw text too.
