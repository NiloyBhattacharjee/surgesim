import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@surgesim/engine": src("./packages/engine/src/index.ts"),
      "@surgesim/platform": src("./packages/platform/src/index.ts"),
      "@surgesim/sdk": src("./packages/sdk/src/index.ts"),
      "@surgesim/report": src("./packages/report/src/index.ts"),
      "@surgesim/importer": src("./packages/importer/src/index.ts"),
      "@surgesim/calibrate": src("./packages/calibrate/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
