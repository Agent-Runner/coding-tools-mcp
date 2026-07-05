# run-ctc

Name alias for [`coding-tools-conductor`](https://www.npmjs.com/package/coding-tools-conductor), the Coding Tools Conductor CLI/TUI (`ctc`).

Both packages install the same `ctc` command; this one simply delegates to the canonical package. Install one or the other, not both:

```bash
npm install -g coding-tools-conductor   # canonical
# or
npm install -g run-ctc                  # this alias
ctc --help
```

No install needed for a one-off run — npx resolves the package's sole `bin` entry regardless of the package name:

```bash
npx run-ctc --help
```

Source, documentation, and issues live in the [coding-tools-mcp repository](https://github.com/xyTom/coding-tools-mcp/tree/main/conductor).
