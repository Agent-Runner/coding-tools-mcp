import { describe, expect, it } from "vitest";
import {
  findSlashCommand,
  fuzzyMatch,
  parseCloseCommand,
  parseMcpCommand,
  parseNewCommand,
  parseSlashCommand,
  parseTunnelCommand,
  suggestSlashCommands,
} from "../src/tui/commands/registry.js";

describe("TUI slash command registry", () => {
  it("parses slash commands with arguments", () => {
    expect(parseSlashCommand("/switch 2")).toEqual({ raw: "/switch 2", name: "switch", args: ["2"] });
    expect(parseSlashCommand('/new "path with spaces" --worktree')).toEqual({
      raw: '/new "path with spaces" --worktree',
      name: "new",
      args: ["path with spaces", "--worktree"],
    });
    expect(parseSlashCommand("plain text")).toBeUndefined();
  });

  it("parses workspace slash command options", () => {
    expect(parseNewCommand(["/repo/api", "--worktree"])).toEqual({ path: "/repo/api", mode: "worktree" });
    expect(parseNewCommand(["--resume", "session-a"])).toEqual({ resume: "session-a" });
    expect(parseCloseCommand(["--force"])).toEqual({ force: true });
    expect(parseTunnelCommand(["start"])).toEqual({ action: "start" });
    expect(parseTunnelCommand([])).toEqual({ action: "status" });
  });

  it("rejects malformed slash command arguments", () => {
    expect(() => parseSlashCommand('/new "unterminated')).toThrow(/Unclosed quote/);
    expect(() => parseNewCommand(["--bogus"])).toThrow(/Unknown \/new option/);
    expect(() => parseCloseCommand(["--bogus"])).toThrow(/Unknown \/close option/);
    expect(() => parseTunnelCommand(["restart"])).toThrow(/action must be/);
  });

  it("parses /mcp actions with optional server names", () => {
    expect(parseMcpCommand([])).toEqual({ action: "status" });
    expect(parseMcpCommand(["enable"])).toEqual({ action: "enable", server: undefined });
    expect(parseMcpCommand(["disable", "github"])).toEqual({ action: "disable", server: "github" });
    expect(parseMcpCommand(["reconnect", "playwright"])).toEqual({ action: "reconnect", server: "playwright" });
    expect(parseMcpCommand(["trust", "docs"])).toEqual({ action: "trust", server: "docs" });
    expect(() => parseMcpCommand(["trust"])).toThrow(/requires a server name/);
    expect(() => parseMcpCommand(["restart"])).toThrow(/action must be/);
    expect(() => parseMcpCommand(["enable", "a", "b"])).toThrow(/at most/);
    expect(suggestSlashCommands("/mc")[0]?.name).toBe("mcp");
    expect(findSlashCommand("mcp")?.stage).toBe("available");
  });

  it("resolves aliases and suggestions", () => {
    expect(findSlashCommand("?")?.name).toBe("help");
    expect(findSlashCommand("tunnel")?.stage).toBe("available");
    expect(suggestSlashCommands("/sw").map((command) => command.name)).toContain("switch");
  });

  it("fuzzy-matches non-contiguous queries and ranks the best command first", () => {
    // "dr" is a subsequence of "doctor" but not a substring.
    expect(suggestSlashCommands("/dr")[0]?.name).toBe("doctor");
    expect(suggestSlashCommands("/cfg")[0]?.name).toBe("config");
    expect(suggestSlashCommands("/mrg")[0]?.name).toBe("merge");
    // An exact name still wins over incidental subsequence matches.
    expect(suggestSlashCommands("/diff")[0]?.name).toBe("diff");
    // Nonsense queries yield nothing rather than every command.
    expect(suggestSlashCommands("/zzzz")).toEqual([]);
  });

  it("reports matched character positions for highlighting", () => {
    expect(fuzzyMatch("dr", "doctor")?.positions).toEqual([0, 5]);
    expect(fuzzyMatch("", "doctor")?.positions).toEqual([]);
    expect(fuzzyMatch("xyz", "doctor")).toBeUndefined();
    expect((fuzzyMatch("diff", "diff")?.score ?? 0) > (fuzzyMatch("df", "diff")?.score ?? 0)).toBe(true);
  });
});
