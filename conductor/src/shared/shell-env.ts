import { execFile } from "node:child_process";
import { basename, delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

/**
 * PATH as the user's login shell sees it, resolved once per process.
 *
 * MCP hosts launched outside a terminal (desktop apps, IDEs) spawn ctc with a
 * minimal PATH, so version managers initialized in shell rc files — nvm,
 * pyenv, rbenv, asdf — are invisible and exec_command resolves `node` & co to
 * the system toolchain. The industry fix (VS Code shell-environment
 * resolution, and what Codex-style CLIs inherit by running inside the shell)
 * is to ask the login shell for its environment once and reuse the answer.
 *
 * Returns undefined on Windows, when CTC_NO_LOGIN_SHELL_PATH is set, or when
 * the shell cannot answer within the timeout; callers fall back to
 * process.env.PATH unchanged.
 */
export function loginShellPath(): Promise<string | undefined> {
  cachedLoginShellPath ??= resolveLoginShellPath().catch(() => undefined);
  return cachedLoginShellPath;
}

/** Environment for spawning stdio MCP backends: process.env with the merged PATH. */
export async function spawnEnvWithLoginShellPath(): Promise<NodeJS.ProcessEnv> {
  const login = await loginShellPath();
  const merged = mergePathWithLoginShell(process.env.PATH, login);
  return merged ? { ...process.env, PATH: merged } : { ...process.env };
}

/**
 * Combine the process PATH with the login-shell PATH.
 *
 * When every current entry also appears in the login PATH, the process was
 * started with a default/minimal environment: adopt the login PATH's order so
 * version-manager shims stay in front of system toolchains. When the current
 * PATH carries custom entries (the user or host prepended something on
 * purpose), keep its order and only append login-shell entries it lacks.
 */
export function mergePathWithLoginShell(current: string | undefined, login: string | undefined): string | undefined {
  const currentEntries = splitPath(current);
  const loginEntries = splitPath(login);
  if (!loginEntries.length) return current;
  if (!currentEntries.length) return login;
  const hasCustomEntries = currentEntries.some((entry) => !loginEntries.includes(entry));
  const ordered = hasCustomEntries ? [...currentEntries, ...loginEntries] : [...loginEntries, ...currentEntries];
  return [...new Set(ordered)].join(delimiter);
}

/** Reset the per-process cache (tests only). */
export function resetLoginShellPathCache(): void {
  cachedLoginShellPath = undefined;
}

let cachedLoginShellPath: Promise<string | undefined> | undefined;

async function resolveLoginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32" || process.env.CTC_NO_LOGIN_SHELL_PATH) return undefined;
  const shell = process.env.SHELL || "/bin/sh";
  // Random-ish markers isolate the answer from rc-file noise (motd, echo).
  const marker = `__ctc_${String(process.pid)}_${Date.now().toString(36)}__`;
  const { command, args } = loginShellProbe(shell, marker);
  const { stdout } = await execFileAsync(command, args, {
    timeout: LOGIN_SHELL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    // Guard var so shell profiles can detect (and skip work during) the probe.
    env: { ...process.env, CTC_RESOLVING_LOGIN_SHELL: "1" },
  });
  const start = stdout.indexOf(marker);
  const end = stdout.lastIndexOf(marker);
  if (start === -1 || end <= start) return undefined;
  const path = stdout.slice(start + marker.length, end).trim();
  return path || undefined;
}

function loginShellProbe(shell: string, marker: string): { command: string; args: string[] } {
  const name = basename(shell);
  if (name === "fish") {
    // fish joins "$PATH" with spaces; string join emits the colon form.
    return { command: shell, args: ["-l", "-c", `printf '%s' '${marker}'; string join : $PATH; printf '%s' '${marker}'`] };
  }
  if (name === "csh" || name === "tcsh") {
    // (t)csh rejects -l combined with other flags; -ic still loads ~/.cshrc.
    return { command: shell, args: ["-ic", `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`] };
  }
  // -l loads login profiles, -i loads interactive rc files — nvm and friends
  // usually initialize in ~/.bashrc / ~/.zshrc, which need both.
  const flags = name === "bash" || name === "zsh" ? ["-ilc"] : ["-l", "-c"];
  return { command: shell, args: [...flags, `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`] };
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).filter(Boolean);
}
