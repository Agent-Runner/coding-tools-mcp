import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  availableTunnelMethods,
  cloudflaredInstallPlan,
  describeInstallPlan,
  findOnPath,
  installCloudflared,
  managedCloudflaredPath,
  resolveCloudflared,
  wranglerAvailable,
  wranglerCommand,
  type CloudflaredInstallPlan,
  type InstallDeps,
} from "../src/tunnel/install.js";

function downloadPlan(plan: CloudflaredInstallPlan): Extract<CloudflaredInstallPlan, { method: "download" }> {
  if (plan.method !== "download") throw new Error(`expected a download plan, got ${plan.method}`);
  return plan;
}

const originalHome = process.env.CTC_HOME;
const originalPath = process.env.PATH;

beforeEach(async () => {
  process.env.CTC_HOME = await mkdtemp(join(tmpdir(), "ctc-install-home-"));
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CTC_HOME;
  else process.env.CTC_HOME = originalHome;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

describe("cloudflaredInstallPlan", () => {
  it("prefers brew on macOS when brew is available", () => {
    expect(cloudflaredInstallPlan("darwin", "arm64", true)).toEqual({ method: "brew" });
  });

  it("downloads the matching release asset per platform and arch", () => {
    const linuxAmd = downloadPlan(cloudflaredInstallPlan("linux", "x64", false));
    expect(linuxAmd.archive).toBe("raw");
    expect(linuxAmd.url).toContain("cloudflared-linux-amd64");
    expect(downloadPlan(cloudflaredInstallPlan("linux", "arm64", false)).url).toContain("cloudflared-linux-arm64");

    const darwin = downloadPlan(cloudflaredInstallPlan("darwin", "arm64", false));
    expect(darwin.archive).toBe("tgz");
    expect(darwin.url).toContain("cloudflared-darwin-arm64.tgz");

    expect(downloadPlan(cloudflaredInstallPlan("win32", "x64", false)).url).toContain("cloudflared-windows-amd64.exe");
  });

  it("reports unsupported platforms instead of guessing", () => {
    const plan = cloudflaredInstallPlan("freebsd", "x64", false);
    expect(plan.method).toBe("unsupported");
    expect(describeInstallPlan(plan)).toContain("freebsd");
  });
});

describe("findOnPath / resolveCloudflared", () => {
  it("finds an executable across PATH entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-path-"));
    await writeFile(join(dir, "cloudflared"), "#!/bin/sh\n");
    process.env.PATH = `/nonexistent:${dir}`;
    expect(findOnPath("cloudflared", process.env, "linux")).toBe(join(dir, "cloudflared"));
    expect(resolveCloudflared(process.env, "linux")).toEqual({ binary: join(dir, "cloudflared"), installed: true });
  });

  it("prefers the ctc-managed binary and falls back to the bare name", async () => {
    process.env.PATH = "/nonexistent";
    expect(resolveCloudflared(process.env, "linux")).toEqual({ binary: "cloudflared", installed: false });

    const managed = managedCloudflaredPath("linux");
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, "#!/bin/sh\n");
    expect(resolveCloudflared(process.env, "linux")).toEqual({ binary: managed, installed: true });
  });
});

describe("wrangler provider", () => {
  it("runs a wrangler on PATH directly, else falls back to npx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctc-wrangler-"));
    await writeFile(join(dir, "wrangler"), "#!/bin/sh\n");
    const withWrangler = { PATH: dir };
    const direct = wranglerCommand(withWrangler, "linux");
    expect(direct.command).toBe(join(dir, "wrangler"));
    expect(direct.baseArgs).toEqual(["tunnel", "quick-start"]);

    const npxDir = await mkdtemp(join(tmpdir(), "ctc-npx-"));
    await writeFile(join(npxDir, "npx"), "#!/bin/sh\n");
    const viaNpx = wranglerCommand({ PATH: npxDir }, "linux");
    expect(viaNpx.command).toBe("npx");
    expect(viaNpx.baseArgs).toEqual(["-y", "wrangler", "tunnel", "quick-start"]);

    expect(wranglerAvailable({ PATH: dir }, "linux")).toBe(true);
    expect(wranglerAvailable({ PATH: "/nonexistent" }, "linux")).toBe(false);
  });
});

describe("availableTunnelMethods", () => {
  it("offers wrangler (no install) and cloudflared install when the binary is missing", async () => {
    const npxDir = await mkdtemp(join(tmpdir(), "ctc-npx-only-"));
    await writeFile(join(npxDir, "npx"), "#!/bin/sh\n");
    const methods = availableTunnelMethods({ PATH: npxDir }, "linux", "x64");
    expect(methods.map((method) => method.id)).toEqual(["wrangler", "install-cloudflared"]);
    const wrangler = methods.find((method) => method.id === "wrangler");
    expect(wrangler?.note).toMatch(/npx wrangler/);
  });

  it("prefers an installed cloudflared and lists it first", async () => {
    const managed = managedCloudflaredPath("linux");
    await mkdir(dirname(managed), { recursive: true });
    await writeFile(managed, "#!/bin/sh\n");
    const methods = availableTunnelMethods({ PATH: "/nonexistent" }, "linux", "x64");
    expect(methods[0]?.id).toBe("cloudflared");
  });

  it("still offers wrangler on platforms without a cloudflared build", async () => {
    const npxDir = await mkdtemp(join(tmpdir(), "ctc-npx-freebsd-"));
    await writeFile(join(npxDir, "npx"), "#!/bin/sh\n");
    const methods = availableTunnelMethods({ PATH: npxDir }, "freebsd", "x64");
    expect(methods.map((method) => method.id)).toEqual(["wrangler"]);
  });
});

describe("installCloudflared", () => {
  it("downloads a raw binary to the managed path and marks it executable", async () => {
    const logs: string[] = [];
    const deps: InstallDeps = {
      onLog: (line) => logs.push(line),
      async download(url, dest) {
        await writeFile(dest, `binary from ${url}`);
      },
      run: () => Promise.reject(new Error("run should not be called for a raw download")),
    };

    const path = await installCloudflared({ method: "download", url: "https://example/cloudflared", archive: "raw" }, deps, "linux");
    expect(path).toBe(managedCloudflaredPath("linux"));
    await expect(readFile(path, "utf8")).resolves.toContain("https://example/cloudflared");
    expect(logs.at(-1)).toBe("Install complete.");
  });

  it("extracts a tgz via tar and moves cloudflared into place", async () => {
    const deps: InstallDeps = {
      async download(_url, dest) {
        await writeFile(dest, "tarball");
      },
      async run(command, args) {
        // Emulate `tar -xzf <archive> -C <scratch>` by materializing the binary.
        expect(command).toBe("tar");
        const dirFlag = args.indexOf("-C");
        const scratch = args[dirFlag + 1];
        await writeFile(join(scratch ?? "", "cloudflared"), "extracted binary");
      },
    };

    const path = await installCloudflared({ method: "download", url: "https://example/cf.tgz", archive: "tgz" }, deps, "darwin");
    expect(path).toBe(managedCloudflaredPath("darwin"));
    await expect(readFile(path, "utf8")).resolves.toBe("extracted binary");
  });

  it("rejects an unsupported plan", async () => {
    await expect(installCloudflared({ method: "unsupported", reason: "nope" })).rejects.toThrow(/nope/);
  });
});
