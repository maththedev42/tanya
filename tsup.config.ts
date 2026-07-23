import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "tsup";

// Build identity compiled into the bundle + written to a sidecar, so a
// long-lived `tanya serve` process can detect that dist/ was rebuilt under it
// (see src/agent/buildInfo.ts). A fresh id per build; overridable for
// reproducible builds via TANYA_BUILD_ID.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const buildId = process.env.TANYA_BUILD_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const builtAt = new Date().toISOString();

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: true,
  external: ["ink", "react", "react/jsx-runtime", "yoga-layout"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __TANYA_BUILD_ID__: JSON.stringify(buildId),
    __TANYA_BUILT_AT__: JSON.stringify(builtAt),
    __TANYA_VERSION__: JSON.stringify(pkg.version),
  },
  async onSuccess() {
    // The running binary compares its compiled-in id against this file to spot a
    // mid-session upgrade. `clean` wipes dist before the build; onSuccess runs
    // after, so this survives.
    writeFileSync(
      join("dist", "BUILD_ID.json"),
      `${JSON.stringify({ buildId, builtAt, version: pkg.version }, null, 2)}\n`,
    );
  },
});
