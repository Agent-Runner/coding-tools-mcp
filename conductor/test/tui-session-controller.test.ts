import { describe, expect, it } from "vitest";
import { TuiSessionController } from "../src/tui/session-controller.js";

describe("TuiSessionController tunnel guard", () => {
  it("refuses to start a tunnel when no live session is registered", async () => {
    const controller = new TuiSessionController();
    await expect(
      controller.startTunnel({
        provider: "cloudflared",
        command: "cloudflared-not-a-real-binary",
        baseArgs: ["tunnel", "--url"],
        startupTimeoutMs: 1000,
        label: "cloudflared",
      }),
    ).rejects.toThrow(/No live session to expose/);
    await controller.closeClients();
  });
});
