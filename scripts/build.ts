/**
 * Build script: bundles the server and TUI plugin entries into dist/.
 *
 * Uses the bun build API with outdir (the `outfile` option doesn't persist to
 * disk reliably for ESM). The TUI entry is emitted as `plugin.js` from its
 * basename, so we rename it to `tui.js` to match the package's `./tui` export.
 *
 * OpenCode packages are kept external so the plugin resolves them from the host
 * OpenCode installation; everything else is bundled for easy local loading.
 */

import { build } from "bun";
import { rm, mkdir, rename } from "node:fs/promises";
import { execSync } from "node:child_process";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const external = [
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/tool",
  "@opencode-ai/plugin/tui",
  "@opencode-ai/sdk",
  "@opencode-ai/sdk/v2",
  "@opentui/core",
  "@opentui/solid",
];

async function bundle(entrypoints: string[], outdir: string) {
  const result = await build({
    entrypoints,
    outdir,
    format: "esm",
    target: "node",
    platform: "node",
    external,
    sourcemap: "external",
    minify: false,
  });
  if (!result.success) {
    console.error(result.logs);
    throw new Error(`build failed for ${entrypoints.join(", ")}`);
  }
  for (const o of result.outputs ?? []) {
    console.log(`built ${o.path}`);
  }
}

await bundle(["src/index.ts"], "dist");
await bundle(["src/tui/plugin.tsx"], "dist");

// The TUI entry is emitted as plugin.js (from the .tsx basename); rename to tui.js.
await rename("dist/plugin.js", "dist/tui.js").catch((e) => {
  console.warn("rename plugin.js -> tui.js failed:", e.message);
});

// Emit type declarations referenced by package.json `exports.types`
// (dist/index.d.ts, dist/tui.d.ts).
try {
  execSync("bunx tsc --emitDeclarationOnly", { stdio: "inherit" });
  // tsc mirrors src/ -> dist/, so the TUI declaration lands at
  // dist/tui/plugin.d.ts. Move it to the exported dist/tui.d.ts path.
  await rename("dist/tui/plugin.d.ts", "dist/tui.d.ts");
  await rm("dist/tui", { recursive: true, force: true }).catch(() => {});
  console.log("declarations emitted");
} catch (e) {
  console.warn("declaration emit failed (skipping):", (e as Error).message);
}

console.log("done");
