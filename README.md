# Coding Tools Conductor

Coding Tools Conductor (`ctc`) is an orchestration layer above `coding-tools-mcp`.
It exposes an MCP server to models and talks to the lower Python MCP server as an
MCP client. The TUI is an optional attach process, not the core runtime.

## Layering Boundaries

1. Single atomic filesystem, process, and git operations belong to
   `coding-tools-mcp`; this project forwards them instead of rebuilding them.
2. Cross-tool state, policy, workspace lifecycle, human review checkpoints, and
   handoff flows belong to Coding Tools Conductor.
3. Conductor calls the lower layer through MCP. It must not import the Python
   project or run shell/git directly. The only exception is the future
   `workspace/` module, where managed git worktree creation and cleanup must run
   in the source repository before the lower MCP server is pointed at the
   worktree.

CI lint keeps `execa` out of every module except `src/workspace/` and the setup
wizard.

## M1 Surface

- `ctc --version`
- `ctc start [path]` starts a model-facing MCP server over stdio.
- Backend modes:
  - `stdio`: spawn `coding-tools-mcp --stdio --workspace <path>` or a profile /
    CLI supplied command.
  - `http`: connect to a Streamable HTTP MCP endpoint with an optional bearer
    token read from an environment variable.
- Primary backend tools are re-exposed without prefixes, subject to profile
  allow/deny policy; additional MCP servers (see M6) are re-exposed with a
  `<server>__` prefix.
- Every proxied tool call emits a JSONL audit event under `~/.ctc/logs/`.

Example:

```bash
ctc start /path/to/repo --backend stdio
ctc start /path/to/repo --backend-command coding-tools-mcp --stdio --workspace /path/to/repo
ctc start /path/to/repo --backend-command-json '["coding-tools-mcp","--stdio","--workspace","/path/to/repo"]'
ctc start /path/to/repo --backend http --backend-url http://127.0.0.1:8765/mcp --backend-token-env CTC_TOKEN
```

## M2 Surface

Conductor now adds three model-facing tools above the transparent proxy:

- `open_workspace` opens either a direct workspace or an isolated detached git
  worktree and then points the lower MCP server at that path with
  `set_default_cwd`.
- `close_workspace` closes the active workspace and removes managed worktrees
  when they are clean, or when `force` is explicitly passed.
- `show_changes` creates a temporary-index git snapshot, diffs it against
  `refs/ctc/review/<session>/baseline`, `last-shown`, or `HEAD`, and advances
  `last-shown` after each review checkpoint.

Human-side workspace commands:

```bash
ctc ws list
ctc ws clean --yes
ctc ws clean --force --yes
ctc ws merge <session-id>
```

Worktree creation and cleanup are the only direct git operations in the core
runtime. Review checkpoints run git through the lower `exec_command` tool so the
layering boundary stays intact.

Managed worktrees are created inside the repository at
`.ctc/worktrees/<session-id>` so the workspace-confined lower server can reach
them with workspace-relative paths (it denies absolute paths). The directory is
added to `.git/info/exclude` automatically, so it never shows up in source-repo
status, diffs, or merges.

## M3 Surface

`open_workspace` now returns a context guide in addition to workspace metadata:

- repository-root `AGENTS.md`, `CLAUDE.md`, and `.cursorrules` files are listed
  with byte counts; root-level files are inlined up to a fixed safety limit.
- nested instruction files are listed by path so models know where deeper rules
  exist before editing there.
- workspace skills are discovered from `.ctc/skills/<name>/SKILL.md`, with
  `.claude/skills/` read as a compatibility fallback.

The model-facing `load_skill` tool returns the full `SKILL.md` content for a
skill listed by `open_workspace.context.skills`.

Profile setup and diagnostics are available from the human CLI:

```bash
ctc setup /path/to/repo
ctc setup /path/to/repo --yes --skip-smoke --default-mode worktree
ctc doctor /path/to/repo
ctc doctor /path/to/repo --skip-backend
```

Profiles are stored as JSON under `~/.ctc/profiles/<repo-hash>.json`. HTTP
bearer tokens are never written directly; profiles store `env:<NAME>` references
such as `env:CTC_TOKEN`.

## M4 Surface

Conductor now includes the first baton handoff protocol and a human attach TUI.

Model-facing baton tools write only inside the active workspace `.baton/`
directory:

- `baton_write_plan(content)` writes `.baton/plan.md`.
- `baton_read_plan()` reads `.baton/plan.md`.
- `baton_update_status(phase, step?, state, note?)` writes
  `.baton/status.json` with an `updatedAt` timestamp.
- `baton_write_report(content)` writes `.baton/report.md`.

The baton directory also contains an `artifacts/` folder for future diff or log
attachments. It is intended as local handoff state; add `.baton/` to workspace
gitignore templates when using it.

Human-side commands:

```bash
ctc baton show /path/to/repo
ctc            # opens the TUI (ctc tui is a deprecated alias)
ctc tui <session-id>
```

The TUI attaches to the latest session log by default and renders activity as
an append-only transcript that flows into the terminal scrollback, in the
style of Claude Code: each tool call is a `●` line with a dimmed `⎿` result
(or a red error), review checkpoints render as inline diff cards, and TUI
notices appear as `✓` / `✗` / `·` notes. Updates are event-driven — the TUI
watches `~/.ctc/logs` with a dirty-checked snapshot store instead of
repainting on a timer — so external stdio sessions stream in near real time
without flicker.

Interaction is input-first: printable keys always go to the composer, and
typing `/` opens a navigable command menu that fuzzy-matches as you type
(e.g. `/dr` finds `doctor`), highlights the matched characters, and wraps at
the ends — arrows to choose, Tab to complete, Enter to run. The composer
supports the usual readline editing keys (Ctrl+A/E to jump to line
start/end, Ctrl+W/U/K to delete by word or to the line edges, Ctrl+←/→ and
Alt+←/→ to move by word). Bounded panels open over the live region for `/diff`,
`/baton`, `/approvals`, `/config`, `/inspect` (also Ctrl+O), `/doctor`, and
`/help`; ↑/↓ scroll by line, ←/→ page while the composer is empty (PgUp/PgDn
also work), and Esc closes. Tab cycles session tabs when the
composer is empty, `/clear` resets the transcript, and Ctrl+C must be pressed
twice to quit so a stray interrupt cannot tear down live sessions.

If the model calls the lower `request_permissions` tool while the TUI is
attached, Conductor pauses the request and shows an approval prompt with
selectable options (`y`/`n`, `1`/`2`, arrows + Enter; left/right walk the
queue when several requests are pending; Esc denies). Without an attached
TUI, the request falls back to the lower backend's existing permission flow.

`/tunnel start` exposes the MCP server over a free try.cloudflare.com tunnel.
It requires a live session (`/new`) — a tunnel in front of a session-less
server could only answer 503, which remote connectors surface as a failed
setup. If `cloudflared` is already installed it starts immediately. Otherwise
the TUI does not dead-end — it opens a picker (arrows/number keys, Enter, Esc)
of the ways this host can run a tunnel:

- **Use wrangler (no install)** — runs `wrangler tunnel quick-start <url>`,
  using a `wrangler` on PATH or `npx wrangler` (the first `npx` run downloads
  wrangler and can take a minute). Nothing is installed permanently.
- **Install cloudflared** — `brew install cloudflared` on macOS when Homebrew
  is present, otherwise the official release binary is downloaded to
  `~/.ctc/bin/cloudflared`. Progress streams into the transcript, and the
  managed binary is preferred on later runs, so this is a one-time step.

Both providers surface the same `*.trycloudflare.com` URL. Hosts with neither
cloudflared nor `npx` say so plainly instead of hanging.

Model clients connect to the stable `/mcp` endpoint (locally
`http://127.0.0.1:<port>/mcp`, through a tunnel `https://<tunnel-host>/mcp`).
The port is persisted in the workspace profile, so a client configured once
keeps working across ctc restarts. `/mcp` always serves the most recently
opened session; `/mcp/<session-id>` remains available to pin a specific one
when several sessions are live. Following the Streamable HTTP spec, each
client that POSTs an `initialize` request gets its own MCP session (routed by
the `Mcp-Session-Id` header), so any number of clients can connect, reconnect,
and terminate sessions independently.

Conductor speaks both remote MCP transports, so connector platforms that
probe or only implement the legacy 2024-11-05 HTTP+SSE transport connect too:
a `GET /sse` — or a `GET /mcp` with an SSE `Accept` and no `Mcp-Session-Id`,
which is the spec's transport-fallback probe — opens the old handshake
(`endpoint` event, messages POSTed to `/messages?sessionId=...`, keepalive
pings so free tunnels do not idle the stream out). Common URL misconfigurations
stay routable instead of dead-ending in 404s: the bare tunnel origin `/` is an
alias for `/mcp`, and a plain browser/curl GET on `/`, `/mcp`, or
`/.well-known/mcp.json` returns a small server card describing the endpoints
and auth mode (the card and `/.well-known` stay readable without the bearer
token; everything else remains gated). When no ctc session is live, MCP
endpoints answer `503` rather than `404`, so clients report a temporarily
unavailable server instead of a wrong URL.

## M5 Surface

The ChatGPT Apps adapter is optional and remains isolated under
`src/adapters/chatgpt/`. Core Conductor behavior does not depend on it, and it
is disabled unless the workspace profile contains:

```json
{ "adapters": ["chatgpt"] }
```

You can also write that flag during setup:

```bash
ctc setup /path/to/repo --yes --skip-smoke --adapter chatgpt
```

When enabled, Conductor advertises MCP widget resources and adds ChatGPT Apps
metadata to three high-value tools only:

- `open_workspace` renders a workspace/context guide card.
- `show_changes` renders a review diff card.
- `baton_update_status` renders a baton progress card.

The adapter uses standard MCP Apps metadata (`_meta.ui.resourceUri`) plus
ChatGPT compatibility aliases such as `_meta["openai/outputTemplate"]`. It is a
host-specific presentation layer; the model-facing tool names and core tool
results stay unchanged.

## M6 Surface

Conductor now aggregates additional third-party MCP servers (GitHub MCP,
Playwright MCP, remote Streamable HTTP servers, …) behind the same
model-facing endpoint. The primary `coding-tools-mcp` backend is unchanged and
stays authoritative: its tools remain unprefixed, `open_workspace`, review
checkpoints, baton files, and `request_permissions` bind to it exclusively,
and a primary connection failure still fails startup. Extra servers are
tools-only: each of their tools is exposed as `<server>__<tool>`
(`github__create_issue`, `playwright__browser_click`), and calls are routed
back to the owning server.

Configuration lives in two merged places:

- the workspace profile (`~/.ctc/profiles/<repo-hash>.json`) under a new
  `mcpServers` record — personal, implicitly trusted;
- a shareable `<repo>/.ctc/mcp.json` committed with the repository.

```json
{ "mcpServers": {
    "github":     { "command": "docker", "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
                    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "env:GITHUB_TOKEN" } },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "env:REMOTE_AUTH" } } } }
```

Entries are stdio (`command`, `args`, `env`) or Streamable HTTP (`url`,
`headers`), plus optional `disabled` and per-server `allow`/`deny` tool
policies (unprefixed names). Server names must match `[A-Za-z0-9_-]+` so the
prefixed tool names stay MCP-safe; keep third-party tool names within your
host's length limits. `env` and `headers` values support `env:<NAME>`
references, resolved at connect time — recommended over literals so
`.ctc/mcp.json` never carries secrets. Extra stdio servers spawn with a
minimal default environment plus the configured `env` only; secrets must be
passed intentionally. On a name collision the profile entry replaces the
workspace entry wholesale (personal over shared), and exposed tool names
resolve conductor > primary > extras, with shadowed names reported per server.

Workspace-declared servers are a trust boundary: a cloned repository could
ship a malicious stdio command, so they start `disabled (untrusted)` until
approved with `/mcp trust <name>` (records a fingerprint of the entry in the
profile; if the repo later edits the entry, trust resets) or per-session with
`ctc start --trust-workspace-mcp`. Profile-declared servers are trusted as
your own configuration.

Failure semantics: extra servers never block startup. A broken command or
unreachable URL becomes a per-server `error` status with background reconnect
(250ms → 5s backoff, 8s connect timeout) while the session keeps serving.
Config parse problems surface as `server_status` error events instead of
aborting `ctc start`. The conductor now advertises `tools.listChanged` and
broadcasts `notifications/tools/list_changed` when an extra server connects,
drops, or is toggled, so clients pick up tool changes mid-session. Config
files are read once at session start; edit them and open a new session (or
use `/mcp reconnect` for connection-level retries).

TUI:

- `/mcp` opens a live status panel (name, state, tool count, source, detail);
  `mcp k/n` appears in the status bar whenever extra servers are configured.
- `/mcp enable|disable|reconnect <name>` manage the active TUI-hosted session
  (session-only — persistent opt-out is `"disabled": true` in config); with no
  name a picker opens. `/mcp trust <name>` is the only subcommand that writes
  the profile. External `ctc start` sessions render as read-only status.
- Connect/disconnect/error transitions stream into the transcript as
  `server_status` events, and audit `tool_call` events carry a `server` field
  for extra-server calls.

`ctc doctor` gains one `mcp:<name>` check per configured server: untrusted or
config-disabled servers warn, reachable servers report their tool count, and
connection or `env:` resolution failures fail the check. Note for mixed
versions: older ctc builds rewrite profiles through a stricter schema and drop
the new `mcpServers`/`trustedWorkspaceMcp` fields on their next profile write.
