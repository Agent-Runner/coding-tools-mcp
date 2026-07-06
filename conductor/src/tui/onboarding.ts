import { defaultBackendForPath, readProfileForPath, resolveProfileTargetPath, writeProfileForPath } from "../profiles/config.js";
import type { BackendConfig, WorkspaceMode, WorkspaceProfile } from "../shared/types.js";

export type OnboardingStep = "backend" | "permissions";
export type PermissionMode = "safe" | "trusted";

export interface OnboardingState {
  repoPath: string;
  step: OnboardingStep;
  backend: BackendConfig;
  defaultMode: WorkspaceMode;
  permissionMode: PermissionMode;
  complete: boolean;
}

export async function loadOnboardingState(path: string | undefined): Promise<OnboardingState | undefined> {
  if (!path) return undefined;
  const repoPath = await resolveProfileTargetPath(path);
  const profile = await readProfileForPath(repoPath);
  if (profile) return undefined;
  return {
    repoPath,
    step: "backend",
    backend: defaultBackendForPath(repoPath),
    // Editing the repo in place is the default; /new --worktree opts into isolation.
    defaultMode: "direct",
    permissionMode: "safe",
    complete: false,
  };
}

export async function advanceOnboarding(state: OnboardingState, value: string): Promise<OnboardingState> {
  const input = value.trim();
  if (state.step === "backend") {
    return { ...state, backend: parseBackendInput(state.repoPath, input), step: "permissions" };
  }

  const complete = { ...state, permissionMode: parsePermissionMode(input), complete: true };
  await writeProfileForPath(complete.repoPath, profileFromOnboarding(complete));
  return complete;
}

export function onboardingPrompt(state: OnboardingState): string {
  if (state.step === "backend") return "Backend: stdio default, or paste an http(s) URL";
  return "Permission mode: safe default, or trusted";
}

export function onboardingDefault(state: OnboardingState): string {
  if (state.step === "backend") return backendLabel(state.backend);
  return state.permissionMode;
}

export function profileFromOnboarding(state: OnboardingState): WorkspaceProfile {
  return {
    repoPath: state.repoPath,
    backend: state.backend,
    defaultMode: state.defaultMode,
    permissionMode: state.permissionMode,
    tunnel: { provider: "none" },
    adapters: [],
  };
}

function parseBackendInput(repoPath: string, input: string): BackendConfig {
  if (!input || input === "stdio" || input === "docker") return defaultBackendForPath(repoPath);
  if (input === "remote") throw new Error("Paste the remote MCP HTTP URL, for example http://127.0.0.1:8765/mcp.");
  if (/^https?:\/\//u.test(input)) return { type: "http", url: input };
  throw new Error(`Unsupported backend ${input}. Use stdio, docker, or an http(s) URL.`);
}

function parsePermissionMode(input: string): PermissionMode {
  if (!input || input === "safe") return "safe";
  if (input === "trusted") return "trusted";
  throw new Error(`Unsupported permission mode ${input}. Use safe or trusted.`);
}

function backendLabel(backend: BackendConfig): string {
  return backend.type === "stdio" ? "stdio" : backend.url;
}
