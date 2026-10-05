# Changelog fragments

This package manages its `CHANGELOG.md` with
[`release-kit`](https://github.com/andrewpopov/release-kit) using a
fragment-based flow instead of hand-editing the changelog directly.

## Convention

Each user-facing change gets its own markdown fragment under
`.changes/unreleased/<kind>-<slug>.md`, with front-matter and a short body:

```markdown
---
kind: added
summary: One-line, user-facing summary of the change
---

A short paragraph describing the change in more detail.
```

`kind` must be one of the kinds declared in `release-kit.config.js`:
`breaking`, `added`, `changed`, `fixed`, `security`.

## Workflow

- **Add a fragment:** `npm run release:note -- --kind added --slug short-slug --summary "User-facing summary"`
- **Cut a release:** `npm run release:cut` compiles the fragments into a new
  `## <version>` section at the top of `CHANGELOG.md`, bumps `package.json`,
  and archives the consumed fragments under `.changes/archive/`.
- **Check hygiene:** `npm run release:hygiene -- --base origin/main`

See `RELEASING.md` for the full release process.
