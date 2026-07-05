#!/usr/bin/env node
// ctc-conductor is a published name alias: it installs the same `ctc` command
// and delegates to the canonical coding-tools-conductor package in-process,
// so argv, stdio, and the TTY behave exactly as if that package were run
// directly.
import("coding-tools-conductor/dist/index.js").catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ctc-conductor could not load coding-tools-conductor: ${message}\n`);
  process.exit(1);
});
