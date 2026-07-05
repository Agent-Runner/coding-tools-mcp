import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BackendClient } from "../proxy/client.js";
import { ExtraMcpClient } from "../proxy/extra-client.js";
import { profilePathForRepo, readProfileForPath, resolveProfileTargetPath } from "../profiles/config.js";
import { mergeMcpServers, readWorkspaceMcpServers, WORKSPACE_MCP_FILE } from "../profiles/mcp.js";
import type { ResolvedMcpServer, WorkspaceProfile } from "../shared/types.js";

const execFileAsync = promisify(execFile);
const EXPECTED_LOWER_TOOLS = ["server_info", "set_default_cwd", "exec_command"];

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  skipBackend?: boolean;
}

export async function runDoctor(path: string | undefined, options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const repoPath = resolve(path ?? process.cwd());
  const checks: DoctorCheck[] = [];
  let profile: WorkspaceProfile | undefined;

  try {
    profile = await readProfileForPath(repoPath);
    if (!profile) {
      checks.push({ name: "profile", status: "fail", detail: `No profile found at ${profilePathForRepo(repoPath)}.` });
    } else {
      checks.push({ name: "profile", status: "pass", detail: `Loaded ${profilePathForRepo(repoPath)}.` });
    }
  } catch (error) {
    checks.push({ name: "profile", status: "fail", detail: errorMessage(error) });
  }

  if (!profile) {
    checks.push(await checkGitVersion());
    checks.push(await checkWorktreeDirectory(repoPath));
    checks.push(...(await checkMcpServers(repoPath, undefined, options.skipBackend === true)));
    return checks;
  }

  checks.push(checkTokenReference(profile));
  checks.push(await checkGitVersion());
  checks.push(await checkWorktreeDirectory(repoPath));

  if (options.skipBackend) {
    checks.push({ name: "backend", status: "warn", detail: "Skipped by --skip-backend." });
  } else {
    checks.push(await checkBackend(profile));
  }

  checks.push(...(await checkMcpServers(repoPath, profile, options.skipBackend === true)));

  return checks;
}

export async function printDoctor(path: string | undefined, options: DoctorOptions = {}): Promise<void> {
  const checks = await runDoctor(path, options);
  const width = Math.max(...checks.map((check) => check.name.length), "check".length);
  process.stdout.write(`${pad("status", 6)}  ${pad("check", width)}  detail\n`);
  for (const check of checks) {
    process.stdout.write(`${pad(check.status.toUpperCase(), 6)}  ${pad(check.name, width)}  ${check.detail}\n`);
  }
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

function checkTokenReference(profile: WorkspaceProfile): DoctorCheck {
  if (profile.backend.type !== "http" || !profile.backend.tokenRef) {
    return { name: "token", status: "pass", detail: "No bearer token reference required." };
  }
  if (!profile.backend.tokenRef.startsWith("env:")) {
    return { name: "token", status: "fail", detail: "Only env:<NAME> token references are supported." };
  }
  const envName = profile.backend.tokenRef.slice("env:".length);
  if (!process.env[envName]) return { name: "token", status: "fail", detail: `Environment variable ${envName} is not set.` };
  return { name: "token", status: "pass", detail: `Environment variable ${envName} is set.` };
}

async function checkBackend(profile: WorkspaceProfile): Promise<DoctorCheck> {
  const client = new BackendClient(profile.backend);
  try {
    await client.start();
    const tools = client.tools().map((tool) => tool.name);
    const missing = EXPECTED_LOWER_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length) {
      return { name: "backend", status: "fail", detail: `Reachable, but missing tools: ${missing.join(", ")}.` };
    }
    return { name: "backend", status: "pass", detail: `Reachable with ${String(tools.length)} tools.` };
  } catch (error) {
    return { name: "backend", status: "fail", detail: errorMessage(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkMcpServers(
  repoPath: string,
  profile: WorkspaceProfile | undefined,
  skipConnect: boolean,
): Promise<DoctorCheck[]> {
  const targetPath = await resolveProfileTargetPath(repoPath);
  const workspace = await readWorkspaceMcpServers(targetPath);
  const merged = mergeMcpServers({
    profileServers: profile?.mcpServers,
    workspaceServers: workspace.servers,
    trustedWorkspaceMcp: profile?.trustedWorkspaceMcp,
  });
  const checks: DoctorCheck[] = [];
  for (const issue of [...workspace.issues, ...merged.issues]) {
    checks.push({ name: `mcp:${issue.name ?? WORKSPACE_MCP_FILE}`, status: "fail", detail: issue.message });
  }
  for (const server of merged.servers) {
    const name = `mcp:${server.name}`;
    if (server.untrusted) {
      checks.push({
        name,
        status: "warn",
        detail: `Declared in ${WORKSPACE_MCP_FILE} but not trusted; approve with /mcp trust ${server.name} or run with --trust-workspace-mcp.`,
      });
      continue;
    }
    if (!server.enabled) {
      checks.push({ name, status: "warn", detail: "Disabled in config." });
      continue;
    }
    if (skipConnect) {
      checks.push({ name, status: "warn", detail: "Skipped by --skip-backend." });
      continue;
    }
    checks.push(await checkMcpConnectivity(server));
  }
  return checks;
}

async function checkMcpConnectivity(server: ResolvedMcpServer): Promise<DoctorCheck> {
  const client = new ExtraMcpClient(server);
  const name = `mcp:${server.name}`;
  try {
    await client.connect();
    return { name, status: "pass", detail: `Reachable with ${String(client.tools().length)} tools.` };
  } catch (error) {
    return { name, status: "fail", detail: errorMessage(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function checkWorktreeDirectory(repoPath: string): Promise<DoctorCheck> {
  // Managed worktrees live inside the repository at .ctc/worktrees so the
  // workspace-confined backend can reach them with relative paths.
  const ctcDir = join(repoPath, ".ctc");
  const dir = join(ctcDir, "worktrees");
  const probe = join(dir, ".doctor-write-test");
  const preexisting = existsSync(dir);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok\n", "utf8");
    await rm(probe, { force: true });
    if (!preexisting) {
      await rmdir(dir).catch(() => undefined);
      await rmdir(ctcDir).catch(() => undefined);
    }
    return { name: "worktrees", status: "pass", detail: `${dir} is writable.` };
  } catch (error) {
    return { name: "worktrees", status: "fail", detail: errorMessage(error) };
  }
}

async function checkGitVersion(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const version = parseGitVersion(stdout);
    if (!version) return { name: "git", status: "fail", detail: `Could not parse version from ${stdout.trim()}.` };
    const ok = version.major > 2 || (version.major === 2 && version.minor >= 38);
    return {
      name: "git",
      status: ok ? "pass" : "fail",
      detail: `${stdout.trim()}${ok ? "" : "; ctc requires git >= 2.38."}`,
    };
  } catch (error) {
    return { name: "git", status: "fail", detail: errorMessage(error) };
  }
}

function parseGitVersion(output: string): { major: number; minor: number } | undefined {
  const match = /git version\s+(\d+)\.(\d+)/u.exec(output);
  if (!match?.[1] || !match[2]) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function profileExists(path: string): boolean {
  return existsSync(profilePathForRepo(resolve(path)));
}
