// A stdio backend that stays alive but never answers any JSON-RPC request —
// exercises the per-request timeout path in LineDelimitedStdioBackendConnection.
import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", () => {
  // Swallow everything; reply to nothing.
});
