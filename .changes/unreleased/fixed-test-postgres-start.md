---
kind: fixed
summary: startTestPostgres throws a typed error with postgres's log and survives a port collision
---

`startTestPostgres` no longer rejects with `undefined` (embedded-postgres' bare early-exit rejection, shown by vitest as `Unknown Error: undefined`) when the server fails to start: it throws `DbKitError` `TEST_POSTGRES_START_FAILED` whose message carries the port, the attempt count and the tail of postgres's own output. The port is now chosen after initdb and a bind conflict is retried on a fresh port (up to 3 attempts), and the server listens on 127.0.0.1 only, the address the client connects to, so a taken 127.0.0.1 port is a fatal bind error rather than a silent start on `::1`.
