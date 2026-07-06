# Publishing

Two npm packages live in this repository:

| Package | Where | Notes |
| --- | --- | --- |
| `coding-tools-conductor` | repo root | The canonical Conductor CLI/TUI (`ctc`). Closed source: published as a minified `dist/` bundle only. |
| `run-ctc` | `run-ctc/` | Name alias. Installs the same `ctc` command and delegates to `coding-tools-conductor` in-process. |

## Non-negotiable: the leak guard

Before **any** publish, `npm pack --dry-run` must list no `*.map` file and
nothing under `src/`. Sourcemaps embed `sourcesContent` — the complete
TypeScript source. `coding-tools-conductor@0.1.0-beta.1` shipped such a map
and had to be unpublished. Three layers now prevent a repeat:

1. `tsup.config.ts` sets `sourcemap: false` and `minify: true`.
2. The `files` array in `package.json` excludes `dist/**/*.map`.
3. CI and the release workflow fail on any `.map` or `src/` path in the
   packed tarball.

## Publish order

`run-ctc` depends on the canonical package, so publish that first:

```bash
npm ci && npm test
npm publish --tag beta            # coding-tools-conductor; prepack builds dist/

cd run-ctc
npm version <version> --no-git-tag-version   # only when its contents changed
npm publish --tag beta
```

`--tag beta` keeps `latest` unset until a stable release: users opt in with
`npm install -g coding-tools-conductor@beta`. To promote a stable version,
publish without `--tag` or run `npm dist-tag add <pkg>@<version> latest`.

Burned version numbers — npm never allows republishing an unpublished
version: `coding-tools-conductor@0.1.0-beta.1` (the sourcemap leak) and
`run-ctc@0.1.0` (unpublished to release the leaked version's dependent
lock). Skip them forever.

Prefer the `Publish to npm` GitHub Actions workflow over publishing from a
laptop: it re-runs the test suite and the leak guard in a clean environment.

## One-time setup after creating this repository

- Fill in `repository`, `homepage`, and `bugs` in both `package.json` files
  with this repository's URL. They were deliberately removed when conductor
  left the public monorepo so npm would not advertise a dead (or private)
  link.
- Add an `NPM_TOKEN` repository secret (npm automation token) for the
  release workflow.
