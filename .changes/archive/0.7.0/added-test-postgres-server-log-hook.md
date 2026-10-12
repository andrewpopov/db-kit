---
kind: added
summary: startTestPostgres accepts onServerLog(line, stream) to receive every server log line for the cluster's lifetime
---

Receives every non-empty server log line, tagged `stdout`/`stderr`, for the cluster's whole lifetime. A throwing listener is ignored; ready detection is unchanged.
