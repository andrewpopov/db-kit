---
kind: fixed
summary: startTestPostgres no longer lets embedded-postgres turn a failing test run into exit 0
---

Importing `embedded-postgres` installs an `async-exit-hook` whose `beforeExit` handler calls `process.exit(0)`, overriding a runner's `process.exitCode = 1` (a vitest `globalSetup` that started a server made a failing run exit 0). `startTestPostgres` now removes exactly the process listeners that import added, immediately after it, and cleans up its own servers on `exit` and on SIGHUP/SIGINT/SIGTERM (the signal is re-raised, never turned into exit 0). The server child is unref'd so an unstopped server cannot hang the process.
