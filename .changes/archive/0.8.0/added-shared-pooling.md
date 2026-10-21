---
kind: added
summary: Share PgBouncer configuration and pooled runtime routing across applications
---

Add an ORM-independent pooling subpath, default pooled environment entrypoint,
and private configuration renderer CLI. Keep direct connections explicit for
migrations, backups and session-dependent work. Bound server connections, preserve
upstream TLS and retain database startup settings without ignoring them. Use
session pooling as the compatibility default; transaction mode is an explicit
choice for verified compatible consumers.
