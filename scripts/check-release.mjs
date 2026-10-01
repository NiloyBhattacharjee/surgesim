// Usage: node scripts/check-release.mjs v1.2.3      (or: pnpm release:check v1.2.3)
// Exits 1 with the reasons if the tag is not safe to publish. With GITHUB_OUTPUT set, writes version and npm_tag.
import { appendFileSync } from "node:fs";
import { checkRelease } from "./release-lib.mjs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: pnpm release:check <tag>   for example: pnpm release:check v0.1.1");
  process.exit(2);
}
const result = checkRelease(process.cwd(), tag);
if (!result.ok) {
  console.error(`Release ${tag} is not ready:\n${result.problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Release ${tag} is ready: ${result.packages.length} packages at ${result.version}, npm tag "${result.npmTag}".`);
for (const name of result.packages) console.log(`  ${name}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\nnpm_tag=${result.npmTag}\n`);
