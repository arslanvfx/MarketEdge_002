import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, ".test-build");
const outputFile = join(outputDir, "kalshi-scalper-service.integration.mjs");
globalThis.require = createRequire(import.meta.url);

await mkdir(outputDir, { recursive: true });
try {
  await build({
    entryPoints: [join(here, "src/lib/kalshi-scalper-service.integration.ts")],
    outdir: outputDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["*.node", "pg-native"],
    sourcemap: "inline",
    logLevel: "warning",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __testCreateRequire } from "node:module";
globalThis.require = __testCreateRequire(import.meta.url);`,
    },
  });
  const result = spawnSync(process.execPath, ["--test", outputFile], {
    cwd: here,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}