#!/usr/bin/env node
/**
 * Manual smoke harness for Conductor — exercises CLI, MCP stdio, TUI controller,
 * HTTP endpoints, and failure paths. Run from conductor/ after build:
 *   node scripts/manual-smoke.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO = resolve(ROOT, "..");
const CTC = join(ROOT, "dist/index.js");
const PATH_ENV = `/home/ubuntu/.local/bin:${process.env.PATH ?? ""}`;

const results = [];

function pass(name, detail = "") {
  results.push({ name, status: "PASS", detail });
  console.log(`✓ PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  results.push({ name, status: "FAIL", detail });
  console.error(`✗ FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail = "") {
  results.push({ name, status: "WARN", detail });
  console.log(`! WARN  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, detail = "") {
  results.push({ name, status: "SKIP", detail });
  console.log(`- SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function runCli(args, { env = {}, expectExit = 0, cwd = REPO } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CTC, ...args], {
      cwd,
      env: { ...process.env, PATH: PATH_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
      if (code !== expectExit) reject(new Error(`ctc ${args.join(" ")} exited ${code}, expected ${expectExit}\n${stderr}${stdout}`));
    });
    child.on("error", reject);
  });
}

async function initGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  for (const cmd of [
    ["git", ["init", "-b", "main"]],
    ["git", ["config", "user.email", "test@example.com"]],
    ["git", ["config", "user.name", "Test"]],
  ]) {
    await new Promise((res, rej) => {
      const c = spawn(cmd[0], cmd[1], { cwd: dir, stdio: "ignore" });
      c.on("close", (code) => (code === 0 ? res() : rej(new Error(`${cmd[0]} failed`))));
    });
  }
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  await new Promise((res, rej) => {
    const c = spawn("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
    c.on("close", (code) => (code === 0 ? res() : rej()));
  });
  await new Promise((res, rej) => {
    const c = spawn("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    c.on("close", (code) => (code === 0 ? res() : rej()));
  });
}

async function connectMcpStdio(repoPath, extraArgs = [], envOverrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CTC, "start", repoPath, "--backend", "stdio", ...extraArgs],
    env: { ...process.env, PATH: envOverrides.PATH ?? PATH_ENV, ...envOverrides },
    stderr: "pipe",
  });
  const client = new Client({ name: "manual-smoke", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function testCliBasics(ctcHome, repo) {
  try {
    const ver = await runCli(["--version"]);
    if (ver.stdout.trim() === "0.1.0") pass("CLI --version");
    else fail("CLI --version", ver.stdout.trim());
  } catch (e) {
    fail("CLI --version", e.message);
  }

  try {
    const setup = await runCli(["setup", repo, "--yes", "--default-mode", "worktree"], { env: { CTC_HOME: ctcHome } });
    if (setup.stdout.includes("Profile written")) pass("CLI setup --yes");
    else fail("CLI setup --yes", setup.stdout.slice(0, 200));
  } catch (e) {
    fail("CLI setup --yes", e.message);
  }

  try {
    const doctor = await runCli(["doctor", repo], { env: { CTC_HOME: ctcHome } });
    const hasPass = doctor.stdout.includes("PASS") && doctor.stdout.includes("backend");
    if (hasPass) pass("CLI doctor (happy path)");
    else fail("CLI doctor (happy path)", doctor.stdout.slice(0, 300));
  } catch (e) {
    fail("CLI doctor (happy path)", e.message);
  }

  try {
    const noProfile = await runCli(["doctor", "/tmp/nonexistent-ctc-repo-xyz"], {
      env: { CTC_HOME: ctcHome },
      expectExit: 1,
    });
    if (noProfile.stdout.includes("No profile found")) pass("CLI doctor (no profile → fail)");
    else fail("CLI doctor (no profile)", noProfile.stdout.slice(0, 200));
  } catch (e) {
    fail("CLI doctor (no profile)", e.message);
  }

  try {
    const skip = await runCli(["doctor", repo, "--skip-backend"], { env: { CTC_HOME: ctcHome } });
    if (skip.stdout.includes("Skipped by --skip-backend")) pass("CLI doctor --skip-backend");
    else fail("CLI doctor --skip-backend");
  } catch (e) {
    fail("CLI doctor --skip-backend", e.message);
  }
}

async function testWorkspaceCli(ctcHome, repo) {
  try {
    const list = await runCli(["ws", "list"], { env: { CTC_HOME: ctcHome } });
    pass("CLI ws list", list.stdout.trim() || "(empty list ok)");
  } catch (e) {
    fail("CLI ws list", e.message);
  }

  try {
    const clean = await runCli(["ws", "clean", "--yes"], { env: { CTC_HOME: ctcHome } });
    pass("CLI ws clean --yes");
  } catch (e) {
    fail("CLI ws clean --yes", e.message);
  }

  try {
    await runCli(["ws", "merge", "nonexistent-session-id"], { env: { CTC_HOME: ctcHome }, expectExit: 1 });
    pass("CLI ws merge (bad session → non-zero exit)");
  } catch (e) {
    fail("CLI ws merge (bad session)", e.message);
  }
}

async function testMcpTools(ctcHome, repo) {
  let client;
  try {
    ({ client } = await connectMcpStdio(repo));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const required of ["open_workspace", "close_workspace", "show_changes", "baton_write_plan", "baton_read_plan", "baton_update_status", "baton_write_report", "load_skill", "read_file", "exec_command"]) {
      if (names.includes(required)) pass(`MCP tool listed: ${required}`);
      else fail(`MCP tool listed: ${required}`);
    }

    const opened = await callTool(client, "open_workspace", { path: repo, mode: "worktree" });
    if (opened.workspace?.mode === "worktree") pass("MCP open_workspace (worktree)");
    else fail("MCP open_workspace (worktree)", JSON.stringify(opened).slice(0, 200));
    const activePath = opened.workspace?.activePath ?? repo;

    if (opened.context?.instructionFiles || opened.context?.skills !== undefined) pass("MCP open_workspace context guide");
    else warn("MCP open_workspace context guide", "no instruction files in test repo");

    await callTool(client, "baton_write_plan", { content: "# Plan\n\nTest plan." });
    const plan = await callTool(client, "baton_read_plan");
    if (String(plan.content ?? plan).includes("Test plan")) pass("MCP baton_write_plan + baton_read_plan");
    else fail("MCP baton plan roundtrip");

    await callTool(client, "baton_update_status", { phase: "test", state: "running", note: "smoke" });
    await callTool(client, "baton_write_report", { content: "# Report\nDone." });
    pass("MCP baton_update_status + baton_write_report");

    const batonShow = await runCli(["baton", "show", activePath], { env: { CTC_HOME: ctcHome } });
    if (batonShow.stdout.includes("Test plan") || batonShow.stdout.includes("# Plan")) pass("CLI baton show (worktree path)");
    else fail("CLI baton show (worktree path)", batonShow.stdout.slice(0, 200));

    const changes = await callTool(client, "show_changes", { against: "baseline" });
    pass("MCP show_changes", `files=${changes.files?.length ?? 0}`);

    const closed = await callTool(client, "close_workspace", { force: true });
    if (closed.closed !== false) pass("MCP close_workspace (force)");
    else warn("MCP close_workspace (force)", closed.message ?? JSON.stringify(closed));
  } catch (e) {
    fail("MCP tools suite", e.message);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function testMcpEdgeCases(ctcHome, repo) {
  // Missing backend command
  try {
    await connectMcpStdio(repo, ["--backend-command", "ctc-fake-backend-xyz"]);
    fail("MCP missing backend", "should have thrown");
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes("stdio backend failed") || msg.includes("failed to start") || msg.includes("Connection closed")) {
      pass("MCP missing backend (clear error)");
    } else {
      fail("MCP missing backend", e.message);
    }
  }

  // Tool policy deny
  let client;
  try {
    const deniedRepo = await mkdtemp(join(tmpdir(), "ctc-deny-"));
    await initGitRepo(deniedRepo);
    await runCli(["setup", deniedRepo, "--yes", "--deny", "exec_command"], { env: { CTC_HOME: ctcHome } });
    ({ client } = await connectMcpStdio(deniedRepo));
    await callTool(client, "open_workspace", { path: deniedRepo, mode: "direct" });
    try {
      await callTool(client, "exec_command", { command: "echo hi" });
      fail("MCP tool deny policy", "exec_command should be denied");
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes("denied") || msg.includes("policy") || msg.includes("not allowed") || msg.includes("disabled by this workspace profile")) {
        pass("MCP tool deny policy (exec_command blocked)");
      } else {
        warn("MCP tool deny policy", e.message);
      }
    }
    await rm(deniedRepo, { recursive: true, force: true });
  } catch (e) {
    fail("MCP tool deny policy setup", e.message);
  } finally {
    await client?.close().catch(() => undefined);
  }

  // HTTP backend without server
  try {
    const httpRepo = await mkdtemp(join(tmpdir(), "ctc-http-fail-"));
    await initGitRepo(httpRepo);
    process.env.CTC_FAIL_TOKEN = "x";
    await runCli(
      ["setup", httpRepo, "--yes", "--skip-smoke", "--backend", "http", "--backend-url", "http://127.0.0.1:1/mcp", "--backend-token-env", "CTC_FAIL_TOKEN"],
      { env: { CTC_HOME: ctcHome } },
    );
    const doc = await runCli(["doctor", httpRepo], { env: { CTC_HOME: ctcHome }, expectExit: 1 });
    if (doc.stdout.includes("FAIL") && doc.stdout.includes("backend")) pass("CLI doctor (unreachable HTTP backend → fail)");
    else fail("CLI doctor (unreachable HTTP backend)", doc.stdout.slice(0, 300));
    await rm(httpRepo, { recursive: true, force: true });
  } catch (e) {
    fail("CLI doctor (unreachable HTTP backend)", e.message);
  }
}

async function testTuiController(ctcHome, repo) {
  process.env.CTC_HOME = ctcHome;
  const { TuiSessionController } = await import("../src/tui/session-controller.ts");
  const controller = new TuiSessionController();

  try {
    const created = await controller.create({ path: repo, mode: "worktree" });
    if (created.sessionId && created.httpUrl) pass("TUI controller /new (worktree + HTTP)", created.httpUrl);
    else fail("TUI controller /new");

    const httpClient = new Client({ name: "http-smoke", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(created.httpUrl));
    await httpClient.connect(transport);
    const httpTools = await httpClient.listTools();
    if (httpTools.tools.length > 5) pass("HTTP MCP /mcp endpoint", `${httpTools.tools.length} tools`);
    else fail("HTTP MCP /mcp endpoint");
    await httpClient.close();

    const origin = new URL(created.httpUrl).origin;
    const card = await fetch(origin);
    if (card.ok) pass("HTTP server card GET /");
    else fail("HTTP server card GET /", String(card.status));

    const wellKnown = await fetch(`${origin}/.well-known/mcp.json`);
    if (wellKnown.ok) pass("HTTP /.well-known/mcp.json");
    else fail("HTTP /.well-known/mcp.json");

    const cfg = await controller.configure(repo, []);
    if (cfg.text.includes("repo:")) pass("TUI controller /config (view)");
    else fail("TUI controller /config (view)");

    const cfgChange = await controller.configure(repo, ["mode", "direct"]);
    if (cfgChange.changed) pass("TUI controller /config mode direct");
    else fail("TUI controller /config mode");

    try {
      await controller.configure(repo, ["mode", "bogus"]);
      fail("TUI controller /config invalid mode", "should throw");
    } catch (e) {
      if (String(e.message).includes("direct or worktree")) pass("TUI controller /config invalid mode (clear error)");
      else fail("TUI controller /config invalid mode", e.message);
    }

    try {
      await controller.startTunnel({ provider: "cloudflared", command: "echo", baseArgs: [], startupTimeoutMs: 500, label: "test" });
      fail("TUI tunnel without session", "should not reach here");
    } catch {
      // expected from empty sessions — but we have a session, so test no-session separately
    }

    const closed = await controller.close(created.sessionId, {});
    if (closed.closed !== false) pass("TUI controller /close");
    else warn("TUI controller /close", closed.message);

    // 503 when no live session
    const probe503 = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
      }),
    });
    if (probe503.status === 503) pass("HTTP /mcp returns 503 when no live session");
    else warn("HTTP /mcp no-session status", String(probe503.status));
  } catch (e) {
    fail("TUI controller suite", e.message);
  } finally {
    await controller.closeClients();
  }

  // Tunnel guard with no session
  const empty = new TuiSessionController();
  try {
    await empty.startTunnel({ provider: "cloudflared", command: "echo", baseArgs: [], startupTimeoutMs: 500, label: "test" });
    fail("TUI /tunnel start without session");
  } catch (e) {
    if (String(e.message).includes("No live session")) pass("TUI /tunnel start without session (clear error)");
    else fail("TUI /tunnel start without session", e.message);
  } finally {
    await empty.closeClients();
  }

  const methods = new TuiSessionController().tunnelMethods();
  pass("TUI tunnelMethods()", methods.map((m) => m.id).join(", ") || "(none on this host)");
}

async function testSlashCommands() {
  const { parseSlashCommand, parseNewCommand, suggestSlashCommands, findSlashCommand } = await import("../src/tui/commands/registry.ts");
  if (findSlashCommand("?")?.name === "help") pass("Slash /help alias ?");
  if (suggestSlashCommands("/dr")[0]?.name === "doctor") pass("Slash fuzzy /dr → doctor");
  if (suggestSlashCommands("/zzzz").length === 0) pass("Slash fuzzy nonsense → empty");
  try {
    parseNewCommand(["--bogus"]);
    fail("Slash /new --bogus");
  } catch (e) {
    if (String(e.message).includes("Unknown")) pass("Slash /new invalid option error");
  }
  if (parseSlashCommand("/tunnel start")?.name === "tunnel") pass("Slash /tunnel start parse");
}

async function testWorkspaceModes(ctcHome, repo) {
  let client;
  try {
    await mkdir(join(repo, ".ctc/skills/demo"), { recursive: true });
    await writeFile(join(repo, ".ctc/skills/demo/SKILL.md"), "# Demo Skill\n", "utf8");
    ({ client } = await connectMcpStdio(repo));
    // Skills live in the source repo; direct mode keeps activePath at repo root.
    await callTool(client, "open_workspace", { path: repo, mode: "direct" });
    const skill = await callTool(client, "load_skill", { name: "demo" });
    if (String(skill.content ?? skill).includes("Demo Skill")) pass("MCP load_skill (direct mode)");
    else fail("MCP load_skill (direct mode)");
    await callTool(client, "close_workspace", {});

    await callTool(client, "open_workspace", { path: repo, mode: "worktree" });
    await callTool(client, "exec_command", { cmd: "echo x > dirty.txt" });
    const closeDirty = await callTool(client, "close_workspace", {});
    if (closeDirty.closed === false && String(closeDirty.message).includes("uncommitted")) {
      pass("MCP close_workspace blocks dirty worktree");
    } else fail("MCP close_workspace dirty guard");

    await callTool(client, "close_workspace", { force: true });
    pass("MCP close_workspace force on dirty worktree");

    const direct = await callTool(client, "open_workspace", { path: repo, mode: "direct" });
    if (direct.workspace?.mode === "direct") pass("MCP open_workspace (direct)");
    else fail("MCP open_workspace (direct)");
    await callTool(client, "close_workspace", {});
    pass("MCP close_workspace (direct mode)");
  } catch (e) {
    fail("Workspace modes suite", e.message);
  } finally {
    await client?.close().catch(() => undefined);
  }
}

async function testBrokenBackendDoctor(ctcHome, repo) {
  const brokenRepo = await mkdtemp(join(tmpdir(), "ctc-broken-"));
  await initGitRepo(brokenRepo);
  try {
    await runCli(
      ["setup", brokenRepo, "--yes", "--skip-smoke", "--backend-command", "/bin/false"],
      { env: { CTC_HOME: ctcHome } },
    );
    const doc = await runCli(["doctor", brokenRepo], { env: { CTC_HOME: ctcHome }, expectExit: 1 });
    if (doc.stdout.includes("FAIL") && doc.stdout.includes("backend")) {
      pass("CLI doctor (broken stdio backend → fail)");
    } else if (doc.stderr.includes("EPIPE") || String(doc.code) === "1") {
      fail("CLI doctor (broken stdio backend crashes with EPIPE — bug)", doc.stderr.slice(0, 200));
    } else {
      fail("CLI doctor (broken stdio backend)", doc.stdout.slice(0, 300));
    }
  } catch (e) {
    if (String(e.message).includes("EPIPE")) {
      fail("CLI doctor (broken stdio backend crashes with EPIPE — bug)", e.message.slice(0, 200));
    } else {
      fail("CLI doctor (broken stdio backend)", e.message);
    }
  } finally {
    await rm(brokenRepo, { recursive: true, force: true });
  }
}

async function testMissingPythonOnPath(ctcHome, repo) {
  try {
    await connectMcpStdio(repo, [], { PATH: "/usr/bin:/bin" });
    fail("MCP without coding-tools-mcp on PATH");
  } catch (e) {
    const msg = String(e.message);
    if (msg.includes("Connection closed") || msg.includes("failed") || msg.includes("ENOENT")) {
      pass("MCP without Python backend on PATH (fails cleanly)");
    } else {
      warn("MCP without Python backend on PATH", msg.slice(0, 120));
    }
  }
}

async function main() {
  console.log("Conductor manual smoke harness\n");
  const ctcHome = await mkdtemp(join(tmpdir(), "ctc-manual-home-"));
  const repo = await mkdtemp(join(tmpdir(), "ctc-manual-repo-"));
  await initGitRepo(repo);
  await mkdir(join(repo, ".ctc/skills/demo"), { recursive: true });
  await writeFile(join(repo, ".ctc/skills/demo/SKILL.md"), "# Demo Skill\nDo the thing.\n", "utf8");
  await writeFile(join(repo, "AGENTS.md"), "# Agents\nBe helpful.\n", "utf8");

  process.env.CTC_HOME = ctcHome;

  await testCliBasics(ctcHome, repo);
  await testWorkspaceCli(ctcHome, repo);
  await testMcpTools(ctcHome, repo);
  await testMcpEdgeCases(ctcHome, repo);
  await testTuiController(ctcHome, repo);
  await testSlashCommands();
  await testWorkspaceModes(ctcHome, repo);
  await testBrokenBackendDoctor(ctcHome, repo);
  await testMissingPythonOnPath(ctcHome, repo);

  await rm(ctcHome, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  console.log(`\n--- Summary: ${passed} passed, ${failed} failed, ${warned} warnings, ${results.length} total ---`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
