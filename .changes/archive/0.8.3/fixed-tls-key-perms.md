---
kind: fixed
summary: startTestPostgres({ tls }) starts on hosts whose openssl writes a group/world-readable key (macOS LibreSSL)
---

With `tls` set, the generated `server.key` is now chmod 0600 before Postgres reads it. macOS's `/usr/bin/openssl` (LibreSSL 3.3) writes the key 0644, which Postgres refuses ("private key file has group or world access"), so every TLS test server failed to start on a Mac with `TEST_POSTGRES_START_FAILED`. OpenSSL 3 hosts already wrote 0600 and see no change.
