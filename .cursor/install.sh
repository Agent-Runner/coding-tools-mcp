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

# 2. Grant the runtime's Landlock exec sandbox access to toolchain paths that
#    live outside the system prefixes (/usr, /bin, ...) it allows by default.
#    On the Cursor image:
#      - Node/npm live under nvm (~/.nvm) and the agent exec daemon
#        (/exec-daemon), so suites that shell out to `npm test` / `node --test`
#        are otherwise blocked with LANDLOCK_READ_ROOT_BLOCKED.
#      - Debian symlinks /usr/lib/pythonX.Y/sitecustomize.py into
#        /etc/pythonX.Y, so on stricter Landlock kernels a sandboxed `python`
#        fails to read it and pollutes stderr; grant the /etc python config dir.
#    This mirrors how the project's own Dockerfile keeps the toolchain under
#    system-readable roots. The export is placed in ~/.bashrc alongside the
#    image's nvm init so it reaches the exec daemon that spawns the MCP server
#    during `make test`.
BASHRC="${HOME}/.bashrc"
MARKER_TAG="coding-tools-mcp: allow Landlock"
MARKER="# ${MARKER_TAG} exec/read of the nvm + exec-daemon + python toolchain"
PY_ETC="/etc/python$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
# Replace any previously-managed block (any marker variant) so re-runs and
# rebuilds from an older snapshot pick up an updated value without duplicating.
if grep -qF "$MARKER_TAG" "$BASHRC" 2>/dev/null || grep -qF 'CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS' "$BASHRC" 2>/dev/null; then
  tmp_bashrc="$(mktemp)"
  grep -vF "$MARKER_TAG" "$BASHRC" | grep -vF 'CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS' > "$tmp_bashrc" || true
  # collapse any trailing blank lines left behind, then move back
  sed -e :a -e '/^\n*$/{$d;N;ba}' "$tmp_bashrc" > "$BASHRC"
  rm -f "$tmp_bashrc"
fi
{
  echo ""
  echo "$MARKER"
  # Fixed assignment (not self-appending) so re-sourcing ~/.bashrc in nested
  # shells keeps the value stable instead of growing on each source.
  echo "export CODING_TOOLS_MCP_EXEC_ALLOW_ROOTS=\"/exec-daemon:\${HOME}/.nvm:${PY_ETC}\""
} >> "$BASHRC"

# 3. Install the package plus dev tooling (ruff, mypy, PyYAML, typing_extensions)
#    in editable mode. Ubuntu 24.04's system interpreter is PEP 668 managed;
#    this is a disposable agent VM, so install directly into it (mirrors CI's
#    `pip install -e ".[dev]"`).
python3 -m pip install --break-system-packages -e ".[dev]"

echo "coding-tools-mcp environment ready."
