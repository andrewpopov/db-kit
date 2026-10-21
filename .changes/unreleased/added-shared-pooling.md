---
kind: added
summary: Share PgBouncer configuration and pooled runtime routing across applications
---

Add an ORM-independent pooling subpath, default pooled environment entrypoint,
and private configuration renderer CLI. Keep direct connections explicit for
migrations, backups and session-dependent work. Bound server connections, preserve
upstream TLS and track database startup settings without ignoring them.
