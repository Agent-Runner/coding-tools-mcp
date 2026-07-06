import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { runSetupCli } from "../src/cli/setup.js";
import { profilePathForRepo, readProfileForPath, resolveRuntimeOptions, writeProfileForPath } from "../src/profiles/config.js";
import { mcpServerFingerprint } from "../src/profiles/mcp.js";
import type { WorkspaceProfile } from "../src/shared/types.js";
import { createGitRepo } from "./git-fixtures.js";

describe("profile setup and doctor", () => {
  it("writes and reads workspace profiles", async () => {
    const repo = await createGitRepo("ctc-profile-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const profile: WorkspaceProfile = {
      repoPath: repo,
      backend: { type: "http", url: "http://127.0.0.1:1/mcp", tokenRef: "env:CTC_TEST_TOKEN" },
      defaultMode: "worktree",
      toolPolicy: { deny: ["kill_session"] },
      tunnel: { provider: "none" },
      adapters: ["chatgpt"],
    };

    await writeProfileForPath(repo, profile);
    await expect(readProfileForPath(repo)).resolves.toMatchObject(profile);
    await expect(resolveRuntimeOptions({ path: repo })).resolves.toMatchObject({ adapters: ["chatgpt"] });
  });

  it("configures a profile from non-interactive setup options and diagnoses it", async () => {
    const repo = await createGitRepo("ctc-setup-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    process.env.CTC_TEST_TOKEN = "test-token";

    await runSetupCli(repo, {
      yes: true,
      skipSmoke: true,
      backend: "http",
      backendUrl: "http://127.0.0.1:1/mcp",
      backendTokenEnv: "CTC_TEST_TOKEN",
      defaultMode: "direct",
      deny: ["kill_session"],
      tunnel: "none",
      adapter: ["chatgpt"],
    });

    await expect(readProfileForPath(repo)).resolves.toMatchObject({
      repoPath: repo,
      backend: { type: "http", url: "http://127.0.0.1:1/mcp", tokenRef: "env:CTC_TEST_TOKEN" },
      defaultMode: "direct",
      toolPolicy: { deny: ["kill_session"] },
      adapters: ["chatgpt"],
    });

    const checks = await runDoctor(repo, { skipBackend: true });
    expect(checks).toContainEqual(expect.objectContaining({ name: "profile", status: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "token", status: "pass" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "backend", status: "warn" }));
  });

  it("round-trips mcpServers and trust fields and keeps old profiles readable", async () => {
    const repo = await createGitRepo("ctc-profile-mcp-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const profile: WorkspaceProfile = {
      repoPath: repo,
      backend: { type: "stdio", command: ["coding-tools-mcp", "--stdio"] },
      mcpServers: { github: { command: "docker", args: ["run"], env: { TOKEN: "env:GH" } } },
      trustedWorkspaceMcp: { docs: "fingerprint" },
    };
    await writeProfileForPath(repo, profile);
    await expect(readProfileForPath(repo)).resolves.toMatchObject({
      mcpServers: { github: { command: "docker" } },
      trustedWorkspaceMcp: { docs: "fingerprint" },
    });
    const runtime = await resolveRuntimeOptions({ path: repo });
    expect(runtime.mcpServers).toEqual([
      expect.objectContaining({ name: "github", source: "profile", enabled: true }),
    ]);

    // Regression: a pre-M6 profile without the new fields still parses, and
    // unknown future fields survive a read (passthrough).
    const legacy = { repoPath: repo, backend: { type: "stdio", command: ["coding-tools-mcp"] }, futureField: 1 };
    await writeFile(profilePathForRepo(repo), `${JSON.stringify(legacy)}\n`, "utf8");
    const reread = await readProfileForPath(repo);
    expect(reread?.mcpServers).toBeUndefined();
    expect((reread as Record<string, unknown> | undefined)?.futureField).toBe(1);
  });

  it("diagnoses workspace mcp servers: untrusted warns, trusted connects, broken fails", async () => {
    const repo = await createGitRepo("ctc-doctor-mcp-");
    process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-home-"));
    const alphaEntry = {
      command: process.execPath,
      args: [join(process.cwd(), "test/fixtures/line-extra.mjs"), "--tools", "echo", "--label", "alpha"],
    };
    await mkdir(join(repo, ".ctc"), { recursive: true });
    await writeFile(
      join(repo, ".ctc", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: alphaEntry,
          broken: { command: "ctc-definitely-not-a-real-mcp-server" },
          "bad name!": { command: "x" },
        },
      }),
      "utf8",
    );

    const untrusted = await runDoctor(repo, { skipBackend: true });
    expect(untrusted).toContainEqual(expect.objectContaining({ name: "mcp:alpha", status: "warn" }));
    expect(untrusted).toContainEqual(expect.objectContaining({ name: "mcp:bad name!", status: "fail" }));

    const profile: WorkspaceProfile = {
      repoPath: repo,
      backend: { type: "stdio", command: ["coding-tools-mcp", "--stdio"] },
      trustedWorkspaceMcp: {
        alpha: mcpServerFingerprint(alphaEntry),
        broken: mcpServerFingerprint({ command: "ctc-definitely-not-a-real-mcp-server" }),
      },
    };
    await writeProfileForPath(repo, profile);

    const checks = await runDoctor(repo, { skipBackend: false });
    expect(checks).toContainEqual(expect.objectContaining({ name: "mcp:alpha", status: "pass", detail: "Reachable with 1 tools." }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "mcp:broken", status: "fail" }));
    // sanity: the doctor read the same file we wrote
    expect(await readFile(join(repo, ".ctc", "mcp.json"), "utf8")).toContain("alpha");
  });
});
