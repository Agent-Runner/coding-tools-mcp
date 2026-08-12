#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for coding-tools-mcp.
#
# The repository is a Python >=3.11 MCP server whose canonical dev loop is
# `python -m pip install -e ".[dev]"` followed by `make ci` (lint, typecheck,
# unittest discovery, protocol/integration/docs/schema gates, dogfood, and
# benchmark smokes). This script prepares that loop on the default Cursor image.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1. The compliance fixtures invoke a bare `python` (e.g. `python -m pytest`,
#    `python repl.py`). Ubuntu ships only `python3`, so provide the alias.
if ! command -v python >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends python-is-python3
fi

# 2. Grant the runtime's Landlock exec sandbox access to the Node toolchain.
#    The safe/trusted permission modes confine exec_command to system prefixes
#    (/usr, /bin, ...). On the Cursor image, Node/npm live under nvm
#    (~/.nvm) and the agent's exec daemon (/exec-daemon), so the golden/e2e
#    suites that shell out to `npm test`/`node --test` are otherwise blocked
#    with LANDLOCK_READ_ROOT_BLOCKED. This mirrors how the project's own
#    Dockerfile keeps the toolchain under system-readable roots.
#    The export is placed in ~/.bashrc alongside the image's nvm init so it
#    reaches the exec daemon that spawns the MCP server during `make test`.
BASHRC="${HOME}/.bashrc"
MARKER="# coding-tools-mcp: allow Landlock exec of the nvm/exec-daemon Node toolchain"
if ! grep -qF "$MARKER" "$BASHRC" 2>/dev/null; then
  {
    echo ""
    echo "$MARKER"
    echo 'export CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS="/exec-daemon:${HOME}/.nvm${CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS:+:$CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS}"'
  } >> "$BASHRC"
fi

# 3. Install the package plus dev tooling (ruff, mypy, PyYAML, typing_extensions)
#    in editable mode. Ubuntu 24.04's system interpreter is PEP 668 managed;
#    this is a disposable agent VM, so install directly into it (mirrors CI's
#    `pip install -e ".[dev]"`).
python3 -m pip install --break-system-packages -e ".[dev]"

echo "coding-tools-mcp environment ready."
