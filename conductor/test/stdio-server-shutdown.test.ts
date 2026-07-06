import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `ctc start` is spawned by an MCP host; when the host exits (closing our
 * stdin) both the conductor process and the lower backend it spawned must go
 * away instead of lingering in the background.
 */
describe("ctc start shutdown", { timeout: 30_000 }, () => {
  it("exits and tears down the spawned backend when the host closes stdin", async () => {
    const home = await mkdtemp(join(tmpdir(), "ctc-stdio-shutdown-"));
    // A unique marker in the backend's argv makes its process discoverable.
    const backendMarker = join(home, "backend-marker");
    const child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/cli/index.ts",
        "start",
        home,
        "--backend-command",
        process.execPath,
        "test/fixtures/line-backend.mjs",
        backendMarker,
      ],
      { cwd: process.cwd(), env: { ...process.env, CTC_HOME: home }, stdio: "pipe" },
    );

    try {
      await waitForBanner(child);
      await initializeOverStdio(child);
      // The marker shows up in the conductor's own argv too; at least the
      // backend process must be live on top of it.
      expect((await backendPids(backendMarker)).length).toBeGreaterThanOrEqual(2);

      // Host quits: stdin EOF must end the conductor and its backend child.
      child.stdin.end();
      const code = await waitForExit(child);
      expect(code).toBe(0);
      await eventually(async () => {
        const pids = await backendPids(backendMarker);
        if (pids.length) throw new Error(`backend still running: ${pids.join(", ")}`);
      });
    } finally {
      child.kill("SIGKILL");
    }
  });
});

function waitForBanner(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      reject(new Error(`ctc start did not boot. stderr: ${stderr}`));
    }, 20_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes("[ctc] session")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`ctc start exited early with ${String(code)}. stderr: ${stderr}`));
    });
  });
}

async function initializeOverStdio(child: ChildProcessWithoutNullStreams): Promise<void> {
  const response = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("no initialize response from ctc start"));
    }, 10_000);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes('"serverInfo"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shutdown-test", version: "0" } },
    })}\n`,
  );
  await response;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve(code);
    });
    setTimeout(() => {
      resolve(-1);
    }, 15_000).unref();
  });
}

/** PIDs of line-backend fixtures whose argv carries this test's unique marker. */
async function backendPids(marker: string): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", marker], (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(stdout.split("\n").filter(Boolean));
    });
  });
}

async function eventually(operation: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
