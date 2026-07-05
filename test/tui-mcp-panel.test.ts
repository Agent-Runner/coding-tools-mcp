import { describe, expect, it } from "vitest";
import { mcpPanelLines } from "../src/tui/components/Panels.js";
import type { McpServerStatusSnapshot } from "../src/tui/state.js";

function textOf(lines: { text: string }[]): string {
  return lines.map((line) => line.text).join("\n");
}

describe("mcpPanelLines", () => {
  it("explains how to configure servers when none exist", () => {
    const text = textOf(mcpPanelLines([], { hosted: true }));
    expect(text).toContain("No additional MCP servers configured.");
    expect(text).toContain(".ctc/mcp.json");
  });

  it("renders aligned rows with per-state details for hosted sessions", () => {
    const servers: McpServerStatusSnapshot[] = [
      { name: "github", state: "connected", source: "profile", toolCount: 12 },
      { name: "playwright", state: "error", source: "workspace", lastError: "spawn npx ENOENT" },
      { name: "docs", state: "disabled", source: "workspace", untrusted: true },
      { name: "muted", state: "disabled", source: "profile", lastError: "disabled in config" },
    ];
    const lines = mcpPanelLines(servers, { hosted: true });
    const text = textOf(lines);
    expect(lines[0]?.text).toMatch(/NAME\s+STATE\s+TOOLS\s+SOURCE\s+DETAIL/);
    expect(text).toMatch(/github\s+connected\s+12\s+profile/);
    expect(text).toContain("spawn npx ENOENT");
    expect(text).toContain("/mcp trust docs");
    expect(text).toContain("disabled in config");
    expect(text).toContain("/mcp enable|disable|reconnect|trust <name>");
  });

  it("marks external sessions read-only", () => {
    const servers: McpServerStatusSnapshot[] = [{ name: "github", state: "connected", toolCount: 1 }];
    const text = textOf(mcpPanelLines(servers, { hosted: false }));
    expect(text).toContain("read-only");
    expect(text).not.toContain("/mcp enable");
  });
});
