---
kind: changed
summary: Resolve @andrewpopov dependencies from the fleet registry
---

Installs now resolve the `@andrewpopov` dependencies from the fleet registry at `https://npm.tail615381.ts.net/` through a committed `.npmrc`, instead of `github:andrewpopov/<kit>#<tag>` git refs, and the runtime `@andrewpopov/db-backup` moves from 0.22.1 to 0.27.1, whose own `alert-kit` dependency is also a registry pin, so the install no longer needs git access. The db-backup APIs db-kit uses are unchanged, so there is no behaviour change, but a consumer installing this version needs the `@andrewpopov` registry `.npmrc` (`@andrewpopov:registry=https://npm.tail615381.ts.net/`) and tailnet access to resolve that dependency.
