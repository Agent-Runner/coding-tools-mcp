# Coding Tools MCP 0.3.0 宣发文案

发布日：2026-08-13
包：`coding-tools-mcp` 0.3.0（PyPI + npm launcher）
仓库：https://github.com/xyTom/coding-tools-mcp
迁移：https://github.com/xyTom/coding-tools-mcp/blob/main/docs/migration-0.3.md
视频：`video/` 下 Remotion 工程，合成 id `Release030`（英）/ `Release030Zh`（中）

本页是可直接粘贴的对外文案。技术细节以 CHANGELOG 和 `docs/migration-0.3.md` 为准；这里只讲用户听得懂的重点。

---

## 一句话

**中文：** Coding Tools MCP 0.3.0：完整支持 MCP `2026-07-28`，HTTP 不再有会话——命令属于工作区，断线也能接着干。

**English:** Coding Tools MCP 0.3.0: full MCP `2026-07-28`, no HTTP sessions. Commands belong to the workspace and survive reconnect.

---

## 五个必须讲的更新

1. **MCP `2026-07-28` 全量支持。** 请求自带协议版本，不必先握手。`server/discover` 之后可以直接 `tools/list` / `tools/call`。握手时代的 `2025-11-25` / `2025-06-18` 原样保留。
2. **HTTP 彻底无状态。** 不再签发 `Mcp-Session-Id`，没有 128 会话上限，也没有空闲过期。一个工作区、一个运行时，所有已认证客户端共用。
3. **命令活过断线。** `kill_session` → `kill_command`，`session_id` → `command_id`。关掉 HTTP 不会杀掉进程；重连后用同一个 `command_id` 就能继续写 stdin、读输出。
4. **并发补丁不再丢写。** 两个客户端改同一文件，后来者拿到可重试冲突，而不是静默覆盖。`apply_patch` 也不再把不该动的行结束符改掉。
5. **模型终于看得见错误。** `category` 和 `retryable` 写进给模型的文本（以前只在多数客户端不会转发的 `structuredContent` 里）。命令输出同时保留开头和末尾，第一条报错不会被大日志冲掉。

破坏性变更请指向迁移指南，不要在短帖里展开全部字段。

---

## GitHub Release 正文

### 中文

```markdown
# Coding Tools MCP 0.3.0

没有会话。两代协议。一个工作区。

0.3.0 完整支持 MCP `2026-07-28`：请求自己声明协议版本，不必先 `initialize`。`server/discover` 之后可以直接列出并调用工具。握手时代的 `2025-11-25` 和 `2025-06-18` 继续按原来的字节形状提供，现代字段不会漏进旧客户端的响应。

HTTP 不再有会话。服务器不再签发 `Mcp-Session-Id`；一个工作区只有一个运行时。命令用 `command_id` 标识，属于工作区而不是某次连接——断开、重连、换一个客户端，都可以继续、读取或终止同一条命令。

顺手修了两件会让人骂的事：两个客户端同时 `apply_patch` 不再互相覆盖；补丁不再改写它没被要求改的行。工具错误现在把 `category` 和 `retryable` 写进模型看得到的文本，这样一次注定失败的调用不会被无脑重试。

**升级前请读** [docs/migration-0.3.md](https://github.com/xyTom/coding-tools-mcp/blob/main/docs/migration-0.3.md)。目录从 20 个工具变成 18 个（`get_default_cwd` / `set_default_cwd` 已删除）；`kill_session` 和 `session:` 输出引用不再接受。

```bash
uvx coding-tools-mcp --stdio --workspace /path/to/repo
npx coding-tools-mcp --stdio --workspace /path/to/repo
```

PyPI · npm · Apache-2.0
```

### English

```markdown
# Coding Tools MCP 0.3.0

No sessions. Two protocol eras. One workspace.

0.3.0 is full MCP `2026-07-28`: a request states its own protocol version, so it does not have to handshake first. `server/discover`, then `tools/list` / `tools/call`. Handshake-era `2025-11-25` and `2025-06-18` keep the byte shape they already had — modern fields never leak into those responses.

HTTP is stateless. The server no longer issues `Mcp-Session-Id`. One workspace is one runtime. Commands are named by `command_id` and owned by the workspace, not by a connection — disconnect, reconnect, or switch clients, and you can still continue, read, or kill the same command.

Two fixes that used to lose work: concurrent `apply_patch` calls no longer overwrite each other, and a patch no longer rewrites line endings it was not asked to touch. Tool errors now put `category` and `retryable` in the text the model actually sees, so a call that cannot succeed is not retried blindly.

**Read** [docs/migration-0.3.md](https://github.com/xyTom/coding-tools-mcp/blob/main/docs/migration-0.3.md) **before upgrading.** The catalog is 18 tools (`get_default_cwd` / `set_default_cwd` are gone). `kill_session` and `session:` output refs are not accepted.

```bash
uvx coding-tools-mcp --stdio --workspace /path/to/repo
npx coding-tools-mcp --stdio --workspace /path/to/repo
```

PyPI · npm · Apache-2.0
```

---

## Twitter / X

### 中文（一条）

Coding Tools MCP 0.3.0 发布。

完整支持 MCP 2026-07-28：不必握手就能调工具。
HTTP 不再有会话——命令属于工作区，断线重连接着干。
两个客户端改同一文件不再丢写。
错误文案带上 retryable，模型看得见。

迁移指南在仓库 docs/migration-0.3.md
https://github.com/xyTom/coding-tools-mcp

### 中文线程

1/ Coding Tools MCP 0.3.0。没有会话的协议时代：MCP 2026-07-28 全量支持，握手时代客户端原样能连。

2/ 握手不再是入场券。`server/discover` → 直接 `tools/list` / `tools/call`。没发 initialize 也能干活；initialize 本身变成幂等的。

3/ HTTP 不再签发 Mcp-Session-Id。一个工作区一个运行时。128 会话上限、空闲过期、会话对不上就 503，全部删掉。

4/ 命令活过断线。`kill_session` 改名 `kill_command`，句柄叫 `command_id`。关掉连接不会杀掉进程；重连后用同一个 id 继续写 stdin。

5/ 两个客户端同时打补丁，后来者拿到可重试冲突，而不是把先到的改动覆盖掉。apply_patch 也不再偷偷改行结束符。

6/ 以前 retryable 只在 structuredContent 里，多数客户端不转给模型。现在写进错误文本：不该重试的调用，模型能看见。

7/ 升级是破坏性的。cwd 两个工具没了，相对路径一律相对工作区根。先读 docs/migration-0.3.md，再 uvx / npx coding-tools-mcp。

### English (single)

Coding Tools MCP 0.3.0 is out.

Full MCP 2026-07-28 — call tools without a handshake.
HTTP has no sessions. Commands belong to the workspace and survive reconnect.
Concurrent patches no longer lose writes.
Errors now say retryable in the text the model sees.

Migration: docs/migration-0.3.md
https://github.com/xyTom/coding-tools-mcp

### English thread

1/ Coding Tools MCP 0.3.0: no sessions, two protocol eras, one workspace. Full MCP 2026-07-28, handshake-era clients unchanged.

2/ The handshake is no longer an admission gate. server/discover, then tools immediately. initialize is idempotent; -32002 is gone.

3/ HTTP issues no Mcp-Session-Id. One workspace, one runtime. The 128-session ceiling, idle expiry, and session-mismatch 503s go with it.

4/ Commands outlive the connection. kill_session → kill_command, session_id → command_id. Close HTTP, reconnect, keep typing.

5/ Two clients patching the same file get a retryable conflict instead of a silent overwrite. apply_patch also stopped rewriting line endings it was not asked to touch.

6/ retryable and category used to live only in structuredContent, which most clients never forward. They are in the error text now.

7/ Breaking: 18 tools, no session cwd, old command handle names rejected. Read docs/migration-0.3.md, then uvx or npx coding-tools-mcp.

---

## 微博 / 即刻 / 朋友圈

Coding Tools MCP 0.3.0 发布了。这是一个给任意 AI 聊天客户端用的编程运行时：读文件、打补丁、跑命令、看 git，限制在一个工作区里。

这个版本的重点不是新工具，而是把会话删掉。HTTP 不再签发 session；命令用 command_id 挂在工作区上，断线重连还能接着写。同时完整支持新协议 MCP 2026-07-28——不必握手就能调工具，旧客户端也不用改。

顺手修了并发补丁丢写，以及模型看不见「能不能重试」的问题。有破坏性变更，升级前看仓库里的 migration-0.3.md。

https://github.com/xyTom/coding-tools-mcp

---

## 小红书 / 短视频封面文案

标题：让 Claude / Cursor 安全改你代码的 MCP，出 0.3.0 了

封面大字：0.3.0 · 没有会话

正文：

给任意 AI 聊天窗口一双能碰代码仓库的手。不是又一个 agent 产品，是一个模型中立的 MCP 运行时：18 个工具，一个工作区，权限模式把关。

0.3.0 三件事：

① 新协议 MCP 2026-07-28 全量支持，不用先握手
② 命令属于工作区，关掉连接也不会把进程杀掉
③ 两个人同时改一个文件，不再出现后写覆盖先写

适合：已经在用 Claude Desktop / Cursor / Cline 的人，想把聊天变成能跑测试、能提交前看 diff 的工作流。

开源 Apache-2.0，PyPI 和 npm 都能装。

---

## Hacker News / Reddit

**Title:** Coding Tools MCP 0.3.0 — full MCP 2026-07-28, stateless HTTP, commands that survive reconnect

**Body:**

Show HN / programming:

Coding Tools MCP is a model-neutral coding runtime over MCP: read, search, atomic multi-file patch, exec with a real PTY, git. One server, any client (Claude Desktop, Claude Code, Cursor, Cline, or a loop you write). Workspace-rooted, permission-gated, Landlock on Linux.

0.3.0 is the protocol release:

- Full MCP 2026-07-28 (per-request version, server/discover, no handshake required). Handshake-era 2025-11-25 / 2025-06-18 keep their existing byte shape.
- HTTP is stateless: no Mcp-Session-Id, no 128-session cap. One workspace is one runtime.
- Commands are workspace-owned (`command_id`). Closing the transport does not kill them; any authenticated client of that workspace can continue / read / kill.
- Concurrent apply_patch no longer loses an update (retryable conflict instead of silent overwrite). Patch application no longer rewrites non-newline line breaks.
- Error text now includes category + retryable, because most clients never forward structuredContent to the model.

Breaking: get_default_cwd / set_default_cwd removed (18 tools); kill_session / session_id / session: refs rejected. Migration: https://github.com/xyTom/coding-tools-mcp/blob/main/docs/migration-0.3.md

Repo: https://github.com/xyTom/coding-tools-mcp

---

## 视频口播 / 字幕稿（与画面同步）

片长约 48 秒，30 fps。中英各一条成片。

| 秒 | 画面 | 中文 | English |
| --- | --- | --- | --- |
| 0–4 | 大号 0.3.0 | Coding Tools MCP 零点三。没有会话，两代协议，一个工作区。 | Coding Tools MCP 0.3.0. No sessions. Two protocol eras. One workspace. |
| 4–12 | 三个协议版本徽章 | 完整支持 MCP 2026-07-28。握手不再是入场券。旧客户端原样能连。 | Full MCP 2026-07-28. The handshake is no longer an admission gate. |
| 12–19 | Session-Id 被划掉 | HTTP 彻底无状态。一个工作区，一个运行时，每个已认证客户端。 | HTTP has no sessions. One workspace, one runtime, every authenticated client. |
| 19–27 | 断线重连时间线 | 命令活过断线。关掉连接，换一个客户端，用同一个 command_id 接着写。 | Commands outlive the connection. Disconnect, reconnect, keep typing. |
| 27–34 | 两个客户端打补丁 | 两个客户端改同一文件：后来者拿到冲突，而不是把先到的覆盖掉。 | Two clients, one file: a retryable conflict, not a lost write. |
| 34–41 | 错误文案 + 日志头尾 | 错误把 retryable 写进模型看得到的文本。大日志也留得住开头的报错。 | Errors the model can see. Command output keeps the head and the tail. |
| 41–48 | CTA | 十八个工具，开源 Apache。npx coding-tools-mcp。先读迁移指南。 | 18 tools, Apache-2.0. npx coding-tools-mcp. Read the migration guide. |

---

## 升级检查清单（可附在帖子评论 / Release 脚注）

从 0.2.x 上来时：

- 相对路径一律相对工作区根；用 `exec_command.workdir` 指定子目录。
- `kill_session` 改成 `kill_command`，参数和输出引用改成 `command_id` / `command:<id>:stdout|stderr`。
- 不要再发送 `Mcp-Session-Id`；旧值会被忽略，不会报 Unknown session。
- 用 `kill_command` 终止命令，不要指望 `notifications/cancelled` 去杀进程。
- 互不信任的客户端请用各自的工作区进程；一个工作区是一个信任域。
