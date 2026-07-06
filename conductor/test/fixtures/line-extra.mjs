// Parameterized fake third-party MCP server speaking newline-delimited
// JSON-RPC over stdio (the framing StdioClientTransport uses natively).
//
//   node line-extra.mjs [--tools echo,search] [--label alpha]
//                       [--crash-marker <path>] [--require-env NAME]
//                       [--mutating-descriptions]
//
// --crash-marker: the first tools/call exits 42 after writing the marker;
//   restarts succeed, which exercises reconnect loops.
// --require-env: exit 1 at startup unless the variable is set, proving that
//   configured env (env:<NAME> references) reaches the child process.
// --rev-file: every tools/list bumps a counter persisted at this path and revs
//   each tool's description while names stay stable, exercising schema-change
//   (not name-change) detection across restarts.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const options = { tools: ["echo"], label: "extra", crashMarker: undefined, requireEnv: undefined, revFile: undefined };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--tools") options.tools = (args[++index] ?? "echo").split(",").filter(Boolean);
  else if (arg === "--label") options.label = args[++index] ?? "extra";
  else if (arg === "--crash-marker") options.crashMarker = args[++index];
  else if (arg === "--require-env") options.requireEnv = args[++index];
  else if (arg === "--rev-file") options.revFile = args[++index];
}

if (options.requireEnv && !process.env[options.requireEnv]) {
  process.stderr.write(`missing required env ${options.requireEnv}\n`);
  process.exit(1);
}

function nextRevSuffix() {
  if (!options.revFile) return "";
  const current = existsSync(options.revFile) ? Number(readFileSync(options.revFile, "utf8")) || 0 : 0;
  writeFileSync(options.revFile, String(current + 1), "utf8");
  return ` rev${current + 1}`;
}

const toolList = () => {
  const suffix = nextRevSuffix();
  return options.tools.map((name) => ({
    name,
    description: `fake ${options.label} tool ${name}${suffix}`,
    inputSchema: { type: "object", properties: {} },
  }));
};

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof request.method !== "string") return;
  if (request.method.startsWith("notifications/")) return; // ignore all notifications
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: `fake-${options.label}`, version: "0" },
    });
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, { tools: toolList() });
    return;
  }
  if (request.method === "tools/call") {
    if (options.crashMarker && !existsSync(options.crashMarker)) {
      writeFileSync(options.crashMarker, "failed-once", "utf8");
      process.exit(42);
    }
    const name = request.params?.name;
    send(request.id, {
      content: [{ type: "text", text: `${options.label}:${name}:ok` }],
      structuredContent: { label: options.label, tool: name },
      isError: false,
    });
    return;
  }
  if (request.id !== undefined) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } })}\n`,
    );
  }
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
