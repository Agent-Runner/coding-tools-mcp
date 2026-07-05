import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface TunnelState {
  running: boolean;
  provider: "cloudflared";
  originUrl?: string;
  publicUrl?: string;
  token?: string;
  message: string;
}

export class TunnelManager {
  private readonly binary: string;
  private process?: ChildProcessWithoutNullStreams;
  private state: TunnelState = { running: false, provider: "cloudflared", message: "tunnel:off" };

  constructor(options: { binary?: string } = {}) {
    this.binary = options.binary ?? "cloudflared";
  }

  status(): TunnelState {
    return { ...this.state };
  }

  async start(originUrl: string): Promise<TunnelState> {
    if (this.process && this.state.running) return this.status();
    const token = randomBytes(24).toString("base64url");
    const child = spawn(this.binary, ["tunnel", "--url", originUrl], { stdio: "pipe", env: process.env });
    this.process = child;

    const publicUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for cloudflared tunnel URL."));
      }, 15_000);
      const onData = (chunk: Buffer): void => {
        const url = parseCloudflaredUrl(chunk.toString("utf8"));
        if (!url) return;
        clearTimeout(timeout);
        cleanup();
        resolve(url);
      };
      const onError = (error: Error): void => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(spawnFailureMessage(this.binary, error)));
      };
      const onExit = (): void => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error("cloudflared exited before producing a tunnel URL."));
      };
      const cleanup = (): void => {
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    }).catch(async (error: unknown) => {
      await this.stop();
      throw error;
    });

    child.once("exit", () => {
      if (this.process === child) {
        this.process = undefined;
        this.state = { running: false, provider: "cloudflared", message: "tunnel:off" };
      }
    });
    this.state = {
      running: true,
      provider: "cloudflared",
      originUrl,
      publicUrl,
      token,
      message: `tunnel:on ${publicUrl}`,
    };
    return this.status();
  }

  stop(): Promise<TunnelState> {
    const child = this.process;
    this.process = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    this.state = { running: false, provider: "cloudflared", message: "tunnel:off" };
    return Promise.resolve(this.status());
  }
}

export function parseCloudflaredUrl(text: string): string | undefined {
  return /https:\/\/[-a-zA-Z0-9.]+\.trycloudflare\.com/.exec(text)?.[0];
}

export function spawnFailureMessage(binary: string, error: Error): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return (
      `${binary} is not installed or not on PATH. ` +
      "Install cloudflared (macOS: brew install cloudflared; other platforms: " +
      "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) " +
      "and run /tunnel start again, or disable tunnels with /config tunnel none."
    );
  }
  return `${binary} failed to start: ${error.message}`;
}
