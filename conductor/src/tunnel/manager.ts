import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cloudflaredCommand, type TunnelCommand } from "./install.js";

export interface TunnelState {
  running: boolean;
  provider: "cloudflared" | "wrangler";
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

  async start(originUrl: string, command: TunnelCommand = cloudflaredCommand(this.binary)): Promise<TunnelState> {
    if (this.process && this.state.running) return this.status();
    const token = randomBytes(24).toString("base64url");
    const child = spawn(command.command, [...command.baseArgs, originUrl], { stdio: "pipe", env: process.env });
    this.process = child;

    const publicUrl = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for a tunnel URL from ${command.label}.`));
      }, command.startupTimeoutMs);
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
        reject(new Error(spawnFailureMessage(command.label, error)));
      };
      const onExit = (): void => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(`${command.label} exited before producing a tunnel URL.`));
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
        this.state = { running: false, provider: command.provider, message: "tunnel:off" };
      }
    });
    this.state = {
      running: true,
      provider: command.provider,
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
    this.state = { running: false, provider: this.state.provider, message: "tunnel:off" };
    return Promise.resolve(this.status());
  }
}

export function parseCloudflaredUrl(text: string): string | undefined {
  return /https:\/\/[-a-zA-Z0-9.]+\.trycloudflare\.com/.exec(text)?.[0];
}

export function spawnFailureMessage(label: string, error: Error): string {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return `${label} was not found — it is not installed or not on PATH.`;
  }
  return `${label} failed to start: ${error.message}`;
}
