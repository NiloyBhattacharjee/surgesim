import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@chronon-sim/engine": src("./packages/engine/src/index.ts"),
      "@chronon-sim/platform": src("./packages/platform/src/index.ts"),
      "@chronon-sim/sdk": src("./packages/sdk/src/index.ts"),
      "@chronon-sim/report": src("./packages/report/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
