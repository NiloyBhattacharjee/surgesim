// Usage: node scripts/set-version.mjs 1.2.3     (or: pnpm release:version 1.2.3)
import { setVersion } from "./release-lib.mjs";

const version = process.argv[2];
if (!version) {
  console.error("usage: pnpm release:version <version>   for example: pnpm release:version 0.1.1");
  process.exit(2);
}
try {
  const changed = setVersion(process.cwd(), version);
  console.log(changed.length === 0 ? `Everything is already at ${version}.` : `Set ${version} in ${changed.length} file(s).`);
  console.log(`\nNext:\n  git commit -am "Release v${version}"\n  git tag v${version}\n  git push origin main v${version}`);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
