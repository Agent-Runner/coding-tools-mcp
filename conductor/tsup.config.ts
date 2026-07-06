import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  splitting: false,
  // Never ship sourcemaps: with sourcesContent they embed the full TypeScript
  // source in the npm tarball. Minify so the published bundle is not
  // readable-as-source either.
  sourcemap: false,
  minify: true,
});
