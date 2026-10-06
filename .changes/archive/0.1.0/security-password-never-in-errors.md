---
kind: security
summary: Passwords never appear in describe(), parse errors, or scrubbed connect-failure errors
---

Parse errors never quote the URL, Postgres driver errors are re-created with the password removed (and the original is not kept as `cause`), and `describe()` replaces the password, including a `password=` query parameter, with `***`.
