import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ctcHome } from "../profiles/config.js";

const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

export type CloudflaredInstallPlan =
  | { method: "brew" }
  | { method: "download"; url: string; archive: "raw" | "tgz" }
  | { method: "unsupported"; reason: string };

export interface CloudflaredResolution {
  binary: string;
  installed: boolean;
}

export interface InstallDeps {
  download(url: string, dest: string): Promise<void>;
  run(command: string, args: string[]): Promise<void>;
  onLog?(line: string): void;
}

export function cloudflaredBinDir(): string {
  return join(ctcHome(), "bin");
}

export function managedCloudflaredPath(platform: NodeJS.Platform = process.platform): string {
  return join(cloudflaredBinDir(), platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/** Locate an executable on PATH without spawning anything. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const candidates = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * Resolve the cloudflared binary to spawn: a copy ctc installed under
 * ~/.ctc/bin wins, then anything on PATH; otherwise the bare name so the
 * caller can surface an install prompt.
 */
export function resolveCloudflared(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CloudflaredResolution {
  const managed = managedCloudflaredPath(platform);
  if (existsSync(managed)) return { binary: managed, installed: true };
  const onPath = findOnPath("cloudflared", env, platform);
  if (onPath) return { binary: onPath, installed: true };
  return { binary: "cloudflared", installed: false };
}

export function cloudflaredInstallPlan(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  hasBrew: boolean = Boolean(findOnPath("brew")),
): CloudflaredInstallPlan {
  if (platform === "darwin" && hasBrew) return { method: "brew" };
  const asset = cloudflaredAsset(platform, arch);
  if (!asset) return { method: "unsupported", reason: `No cloudflared build is published for ${platform}/${arch}.` };
  return { method: "download", url: `${RELEASE_BASE}/${asset.file}`, archive: asset.archive };
}

function cloudflaredAsset(platform: NodeJS.Platform, arch: string): { file: string; archive: "raw" | "tgz" } | undefined {
  const amd = arch === "x64" || arch === "amd64";
  const arm64 = arch === "arm64" || arch === "aarch64";
  if (platform === "linux") {
    if (amd) return { file: "cloudflared-linux-amd64", archive: "raw" };
    if (arm64) return { file: "cloudflared-linux-arm64", archive: "raw" };
    if (arch === "arm") return { file: "cloudflared-linux-arm", archive: "raw" };
  }
  if (platform === "darwin") {
    if (arm64) return { file: "cloudflared-darwin-arm64.tgz", archive: "tgz" };
    if (amd) return { file: "cloudflared-darwin-amd64.tgz", archive: "tgz" };
  }
  if (platform === "win32" && amd) return { file: "cloudflared-windows-amd64.exe", archive: "raw" };
  return undefined;
}

export function describeInstallPlan(plan: CloudflaredInstallPlan): string {
  switch (plan.method) {
    case "brew":
      return "run `brew install cloudflared`";
    case "download":
      return `download the official cloudflared binary to ${managedCloudflaredPath()}`;
    case "unsupported":
      return plan.reason;
  }
}

/** A ready-to-spawn tunnel provider command. */
export interface TunnelCommand {
  provider: "cloudflared" | "wrangler";
  command: string;
  baseArgs: string[];
  startupTimeoutMs: number;
  label: string;
}

export function cloudflaredCommand(binary: string): TunnelCommand {
  return { provider: "cloudflared", command: binary, baseArgs: ["tunnel", "--url"], startupTimeoutMs: 20_000, label: "cloudflared" };
}

/**
 * `wrangler tunnel quick-start <url>` runs the same free try.cloudflare.com
 * tunnel without a separate install: a wrangler on PATH is used directly,
 * otherwise `npx` fetches it on demand (slower on first run).
 */
export function wranglerCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): TunnelCommand {
  const direct = findOnPath("wrangler", env, platform);
  if (direct) {
    return { provider: "wrangler", command: direct, baseArgs: ["tunnel", "quick-start"], startupTimeoutMs: 90_000, label: "wrangler" };
  }
  return {
    provider: "wrangler",
    command: "npx",
    baseArgs: ["-y", "wrangler", "tunnel", "quick-start"],
    startupTimeoutMs: 90_000,
    label: "npx wrangler",
  };
}

export function wranglerAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return Boolean(findOnPath("wrangler", env, platform) ?? findOnPath("npx", env, platform));
}

export type TunnelMethod =
  | { id: "cloudflared"; kind: "run"; label: string; command: TunnelCommand; note?: string }
  | { id: "wrangler"; kind: "run"; label: string; command: TunnelCommand; note?: string }
  | { id: "install-cloudflared"; kind: "install"; label: string; plan: CloudflaredInstallPlan; note?: string };

/**
 * Ordered tunnel start options for the current host: an already-usable
 * cloudflared first, then the zero-install wrangler path, then installing
 * cloudflared. Empty only when nothing is available and nothing can be built.
 */
export function availableTunnelMethods(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TunnelMethod[] {
  const methods: TunnelMethod[] = [];
  const resolved = resolveCloudflared(env, platform);
  if (resolved.installed) {
    methods.push({ id: "cloudflared", kind: "run", label: "Use cloudflared", command: cloudflaredCommand(resolved.binary) });
  }
  if (wranglerAvailable(env, platform)) {
    const command = wranglerCommand(env, platform);
    methods.push({
      id: "wrangler",
      kind: "run",
      label: "Use wrangler (no install)",
      note: command.command === "npx" ? "Runs `npx wrangler`; the first run downloads wrangler and can take a minute." : undefined,
      command,
    });
  }
  const plan = cloudflaredInstallPlan(platform, arch, Boolean(findOnPath("brew", env, platform)));
  if (plan.method !== "unsupported") {
    methods.push({ id: "install-cloudflared", kind: "install", label: "Install cloudflared", note: describeInstallPlan(plan), plan });
  }
  return methods;
}

/**
 * Install cloudflared per the plan and return the path to run. Network and
 * subprocess access are injected so the orchestration is unit-testable.
 */
export async function installCloudflared(
  plan: CloudflaredInstallPlan,
  deps: InstallDeps = defaultInstallDeps(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (plan.method === "unsupported") throw new Error(plan.reason);
  if (plan.method === "brew") {
    deps.onLog?.("Running brew install cloudflared…");
    await deps.run("brew", ["install", "cloudflared"]);
    const resolved = findOnPath("cloudflared");
    if (!resolved) throw new Error("brew finished but cloudflared is still not on PATH.");
    return resolved;
  }

  const target = managedCloudflaredPath(platform);
  await mkdir(cloudflaredBinDir(), { recursive: true });
  const scratch = join(tmpdir(), `ctc-cloudflared-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    if (plan.archive === "tgz") {
      const archivePath = join(scratch, "cloudflared.tgz");
      deps.onLog?.(`Downloading ${plan.url}…`);
      await deps.download(plan.url, archivePath);
      deps.onLog?.("Extracting cloudflared…");
      await deps.run("tar", ["-xzf", archivePath, "-C", scratch]);
      await rename(join(scratch, "cloudflared"), target);
    } else {
      deps.onLog?.(`Downloading ${plan.url}…`);
      await deps.download(plan.url, target);
    }
    if (platform !== "win32") await chmod(target, 0o755);
    deps.onLog?.("Install complete.");
    return target;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export function defaultInstallDeps(onLog?: (line: string) => void): InstallDeps {
  return {
    onLog,
    async download(url, dest) {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`Download failed (${String(response.status)} ${response.statusText}) for ${url}`);
      const body = await response.arrayBuffer();
      await writeFile(dest, Buffer.from(body));
    },
    run: runCommand,
  };
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(`${command} is not installed or not on PATH.`) : error);
    });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${String(code ?? "null")}.`));
    });
  });
}
