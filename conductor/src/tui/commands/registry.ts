export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
  aliases?: string[];
}

export interface SlashCommandGroup {
  title: string;
  commands: SlashCommand[];
}

export interface ParsedSlashCommand {
  raw: string;
  name: string;
  args: string[];
}

export interface ParsedNewCommand {
  path?: string;
  mode?: "direct" | "worktree";
  resume?: string;
}

export interface ParsedCloseCommand {
  force: boolean;
}

export interface ParsedCleanCommand {
  /** Remove dirty worktrees too; implies no confirmation prompt. */
  force: boolean;
  /** Skip the confirmation prompt but still skip dirty worktrees. */
  yes: boolean;
}

export interface ParsedTunnelCommand {
  action: "start" | "stop" | "status";
}

export interface ParsedMcpCommand {
  action: "status" | "enable" | "disable" | "reconnect" | "trust";
  server?: string;
}

export const slashCommandGroups: SlashCommandGroup[] = [
  {
    title: "Sessions",
    commands: [
      {
        name: "new",
        usage: "/new [path] [--direct|--worktree] [--resume <wt>]",
        description: "Open a workspace session for model clients.",
      },
      {
        name: "close",
        usage: "/close [--force]",
        description: "Close the current workspace session.",
      },
      {
        name: "merge",
        usage: "/merge",
        description: "Merge worktree changes back into the source repo.",
      },
      {
        name: "clean",
        usage: "/clean [--force|--yes]",
        description: "Remove idle managed worktrees and stale records.",
      },
      {
        name: "switch",
        usage: "/switch [n|session]",
        description: "Switch to another attached session tab.",
      },
    ],
  },
  {
    title: "Review",
    commands: [
      {
        name: "diff",
        usage: "/diff",
        description: "Show the latest review checkpoint for this session.",
      },
      {
        name: "baton",
        usage: "/baton",
        description: "Show the session baton plan, status, and report.",
      },
      {
        name: "approvals",
        usage: "/approvals",
        description: "List pending approvals across attached sessions.",
      },
    ],
  },
  {
    title: "Configure",
    commands: [
      {
        name: "mcp",
        usage: "/mcp [status|enable|disable|reconnect|trust <name>]",
        description: "Show and manage extra MCP servers for the session.",
      },
      {
        name: "tunnel",
        usage: "/tunnel [start|stop|status]",
        description: "Manage the public MCP tunnel (cloudflared/wrangler).",
      },
      {
        name: "config",
        usage: "/config [mode|permission|tunnel] ...",
        description: "View or update the current repo profile.",
      },
      {
        name: "doctor",
        usage: "/doctor",
        description: "Run profile, git, worktree, and backend checks.",
      },
    ],
  },
  {
    title: "Interface",
    commands: [
      {
        name: "help",
        usage: "/help",
        description: "Show TUI commands and key bindings.",
        aliases: ["?"],
      },
      {
        name: "inspect",
        usage: "/inspect",
        description: "Open the event inspector (Ctrl+O).",
      },
      {
        name: "clear",
        usage: "/clear",
        description: "Clear the transcript and start a fresh screen.",
      },
      {
        name: "quit",
        usage: "/quit",
        description: "Exit the TUI.",
        aliases: ["q"],
      },
    ],
  },
];

export const slashCommands: SlashCommand[] = slashCommandGroups.flatMap((group) => group.commands);

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const parts = tokenizeArgs(trimmed.slice(1));
  const name = parts[0]?.toLowerCase();
  if (!name) return undefined;
  return { raw: trimmed, name, args: parts.slice(1) };
}

export function parseNewCommand(args: string[]): ParsedNewCommand {
  const parsed: ParsedNewCommand = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--direct") {
      parsed.mode = "direct";
    } else if (arg === "--worktree") {
      parsed.mode = "worktree";
    } else if (arg === "--resume") {
      const resume = args[index + 1];
      if (!resume) throw new Error("/new --resume requires a worktree path or session id.");
      parsed.resume = resume;
      index += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown /new option ${arg}.`);
    } else if (!parsed.path) {
      parsed.path = arg;
    } else {
      throw new Error(`Unexpected /new argument ${arg}.`);
    }
  }
  return parsed;
}

export function parseCloseCommand(args: string[]): ParsedCloseCommand {
  const parsed: ParsedCloseCommand = { force: false };
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") parsed.force = true;
    else throw new Error(`Unknown /close option ${arg}.`);
  }
  return parsed;
}

export function parseCleanCommand(args: string[]): ParsedCleanCommand {
  const parsed: ParsedCleanCommand = { force: false, yes: false };
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") parsed.force = true;
    else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else throw new Error(`Unknown /clean option ${arg}.`);
  }
  return parsed;
}

export function parseTunnelCommand(args: string[]): ParsedTunnelCommand {
  const action = args[0] ?? "status";
  if (args.length > 1) throw new Error("/tunnel accepts at most one action.");
  if (action !== "start" && action !== "stop" && action !== "status") {
    throw new Error("/tunnel action must be start, stop, or status.");
  }
  return { action };
}

export function parseMcpCommand(args: string[]): ParsedMcpCommand {
  const action = args[0] ?? "status";
  if (args.length > 2) throw new Error("/mcp accepts an action and a server name at most.");
  if (action === "status") {
    if (args.length > 1) throw new Error("/mcp status takes no server name.");
    return { action };
  }
  if (action !== "enable" && action !== "disable" && action !== "reconnect" && action !== "trust") {
    throw new Error("/mcp action must be enable, disable, reconnect, or trust.");
  }
  const server = args[1];
  if (action === "trust" && !server) throw new Error("/mcp trust requires a server name.");
  return { action, server };
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  const normalized = name.toLowerCase();
  return slashCommands.find((command) => command.name === normalized || command.aliases?.includes(normalized));
}

export interface FuzzyMatch {
  positions: number[];
  score: number;
}

/**
 * Subsequence fuzzy match (à la Codex CLI / OpenCode): every query character must
 * appear in order within the target. Returns the matched indices for highlighting
 * plus a score that rewards contiguous runs and early/leading matches. Longer
 * targets are nudged down so the tightest command wins ties.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | undefined {
  if (!query) return { positions: [], score: 0 };
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  const positions: number[] = [];
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return undefined;
    positions.push(found);
    if (found === previous + 1) score += 4;
    if (found === 0) score += 6;
    score += Math.max(0, 3 - (found - Math.max(previous, 0)));
    previous = found;
    cursor = found + 1;
  }
  score -= target.length * 0.05;
  return { positions, score };
}

function commandScore(query: string, command: SlashCommand): number | undefined {
  let best: number | undefined;
  for (const candidate of [command.name, ...(command.aliases ?? [])]) {
    const match = fuzzyMatch(query, candidate);
    if (match && (best === undefined || match.score > best)) best = match.score;
  }
  return best;
}

export function suggestSlashCommands(input: string): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const parsed = parseSlashCommand(input);
  const query = (parsed?.name ?? input.slice(1)).toLowerCase();
  if (!query) return slashCommands;
  return slashCommands
    .map((command, index) => ({ command, index, score: commandScore(query, command) }))
    .filter((entry): entry is { command: SlashCommand; index: number; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command);
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? "";
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (quote) throw new Error("Unclosed quote in slash command.");
  if (current) tokens.push(current);
  return tokens;
}
