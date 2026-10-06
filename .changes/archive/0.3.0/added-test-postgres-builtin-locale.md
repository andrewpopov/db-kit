---
kind: added
summary: startTestPostgres accepts locale 'builtin:<name>' (PG 17 builtin provider); embedded-postgres peer range bounded to 17.x and 18.x
---

`startTestPostgres({ locale: 'builtin:C.UTF-8' })` initialises with `--locale-provider=builtin --builtin-locale=C.UTF-8`, matching production. It is opt-in: the default locale is unchanged. The optional `embedded-postgres` peer range is now `>=17.0.0-beta.0 <19.0.0-0`, stating the supported PG majors (the 17.x and 18.x betas).
