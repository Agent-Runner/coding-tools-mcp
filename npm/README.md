# npm distribution packages

Publishable npm packages that protect and serve this project's names on the npm registry. Each is a real, working package — npm's dispute policy allows reclaiming empty name-squatting placeholders, so aliases here always install something functional.

| Package | Contents |
| --- | --- |
| [`coding-tools-conductor`](../conductor) | The canonical Conductor CLI/TUI (`ctc` command). Lives in `conductor/`, not here. |
| [`ctc-cli`](./ctc-cli) | Name alias. Installs the same `ctc` command and delegates to `coding-tools-conductor`. |
| [`coding-tools-mcp`](./coding-tools-mcp) | Launcher for the Python MCP server on PyPI, via `uvx`/`pipx`. |

## Publishing a beta

Publish the canonical package first — `ctc-cli` depends on it:

```bash
# 1. Canonical conductor package (builds automatically via prepack)
cd conductor
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta

# 2. Alias + launcher
cd ../npm/ctc-cli
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta

cd ../coding-tools-mcp
npm version 0.1.0-beta.1 --no-git-tag-version
npm publish --tag beta
```

`--tag beta` keeps `latest` unset until a stable release: users opt in with `npm install -g coding-tools-conductor@beta`. When promoting a stable version later, publish without `--tag` (or run `npm dist-tag add <pkg>@<version> latest`).
