# npm distribution packages

Publishable npm packages that protect and serve this project's names on the npm registry. Each is a real, working package — npm's dispute policy allows reclaiming empty name-squatting placeholders, so aliases here always install something functional.

| Package | Contents |
| --- | --- |
| [`coding-tools-conductor`](../conductor) | The canonical Conductor CLI/TUI (`ctc` command). Lives in `conductor/`, not here. |
| [`ctc-conductor`](./ctc-conductor) | Name alias. Installs the same `ctc` command and delegates to `coding-tools-conductor`. |
| [`coding-tools-mcp`](./coding-tools-mcp) | Launcher for the Python MCP server on PyPI, via `uvx`/`pipx`. |

`ctc-conductor` is not named `ctc-cli` because npm's registry rejects new unscoped
names it considers too similar to existing popular packages (this one collided
with `cp-cli`/`cpy-cli`/`dts-cli`) — the registry itself suggests scoping
(`@you/ctc-cli`) as the workaround. We picked a different unscoped name instead
so a plain `npx <package>` keeps working with no scope to type. This works
because npm's bin resolution (`libnpmexec/get-bin-from-manifest.js`) runs
whatever the package's sole `bin` entry is, regardless of whether it matches
the package name — so `npx ctc-conductor` still launches the `ctc` command.
If you also want the exact literal `ctc-cli` name, it is only obtainable
scoped, e.g. `@<your-npm-user>/ctc-cli` published with `--access public`.

## Publishing a beta

Publish the canonical package first — `ctc-conductor` depends on it:

```bash
# 1. Canonical conductor package (builds automatically via prepack)
cd conductor
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta

# 2. Alias + launcher
cd ../npm/ctc-conductor
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta

cd ../coding-tools-mcp
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta
```

`--tag beta` keeps `latest` unset until a stable release: users opt in with `npm install -g coding-tools-conductor@beta`. When promoting a stable version later, publish without `--tag` (or run `npm dist-tag add <pkg>@<version> latest`).

If a package name gets the same "too similar" 403 at publish time, pick another
unscoped candidate and check it's unregistered first: `curl -s -o /dev/null -w
'%{http_code}\n' https://registry.npmjs.org/<name>` (404 means available — it
does not predict the similarity check, which only runs on the real `npm
publish`). Prefer names with a distinctive word rather than a short generic
`<letters>-cli` suffix, since that pattern is densely populated.
