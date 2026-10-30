---
kind: changed
summary: Installing from git no longer runs a full dependency install: the `prepare` script is gone (run `npm run hooks` once after cloning) and `build` is now `compile`
---

The pinned git install no longer triggers a nested devDependency install; `dist/` is committed so nothing is built at install time.
