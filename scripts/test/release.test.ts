import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript on purpose (the release job runs it with only node); no declarations
import { checkRelease, isVersion, npmTagFor, publishablePackages, setVersion, versionFromTag, workspacePackages } from "../release-lib.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Pkg {
  dir: string;
  json: Record<string, unknown>;
}
/** A throwaway workspace: a root package plus the given packages. */
function workspace(pkgs: Pkg[], rootVersion = "1.0.0"): string {
  const root = mkdtempSync(join(tmpdir(), "surgesim-release-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", private: true, version: rootVersion }, null, 2) + "\n");
  for (const p of pkgs) {
    mkdirSync(join(root, p.dir), { recursive: true });
    writeFileSync(join(root, p.dir, "package.json"), JSON.stringify(p.json, null, 2) + "\n");
  }
  return root;
}
const pub = (name: string, version = "1.0.0", extra: Record<string, unknown> = {}) => ({
  name,
  version,
  publishConfig: { access: "public" },
  ...extra,
});

describe("tags and versions", () => {
  it("reads the version from a release tag", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("v0.1.0")).toBe("0.1.0");
    expect(versionFromTag("v10.20.30")).toBe("10.20.30");
    expect(versionFromTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(versionFromTag("v1.0.0-beta")).toBe("1.0.0-beta");
  });

  it("rejects things that are not release tags", () => {
    for (const bad of ["1.2.3", "v1.2", "v1.2.3.4", "vX.Y.Z", "release-1", "v1.2.3+build", "v01.2.3x", "", "v1.2.3-", "main"]) {
      expect(versionFromTag(bad), bad).toBeNull();
    }
  });

  it("publishes prereleases under 'next' so they never become the default install", () => {
    expect(npmTagFor("1.2.3")).toBe("latest");
    expect(npmTagFor("1.2.3-rc.1")).toBe("next");
    expect(npmTagFor("2.0.0-beta")).toBe("next");
  });

  it("isVersion accepts plain and prerelease versions only", () => {
    expect(isVersion("1.2.3")).toBe(true);
    expect(isVersion("1.2.3-rc.1")).toBe(true);
    expect(isVersion("v1.2.3")).toBe(false);
    expect(isVersion("1.2")).toBe(false);
    expect(isVersion(undefined)).toBe(false);
  });
});

describe("finding packages", () => {
  it("lists workspace packages and skips the private ones when publishing", () => {
    const root = workspace([
      { dir: "packages/a", json: pub("@x/a") },
      { dir: "packages/b", json: pub("@x/b") },
      { dir: "apps/cli", json: pub("@x/cli") },
      { dir: "apps/demo", json: { name: "@x/demo", version: "1.0.0", private: true } },
    ]);
    expect(workspacePackages(root).map((p: { dir: string }) => p.dir)).toEqual(["packages/a", "packages/b", "apps/cli", "apps/demo"]);
    expect(publishablePackages(root).map((p: { json: { name: string } }) => p.json.name)).toEqual(["@x/a", "@x/b", "@x/cli"]);
  });

  it("ignores folders without a package.json and workspaces that do not exist", () => {
    const root = workspace([{ dir: "packages/a", json: pub("@x/a") }]);
    mkdirSync(join(root, "packages", "empty"));
    expect(workspacePackages(root)).toHaveLength(1);
    expect(workspacePackages(mkdtempSync(join(tmpdir(), "surgesim-none-")))).toEqual([]);
  });
});

describe("setVersion", () => {
  it("sets every package, the private ones and the root, and reports what changed", () => {
    const root = workspace([
      { dir: "packages/a", json: pub("@x/a") },
      { dir: "apps/demo", json: { name: "@x/demo", version: "1.0.0", private: true } },
    ]);
    const changed = setVersion(root, "1.1.0");
    expect(changed).toHaveLength(3);
    for (const f of ["package.json", "packages/a/package.json", "apps/demo/package.json"]) {
      expect(JSON.parse(readFileSync(join(root, f), "utf8")).version).toBe("1.1.0");
    }
  });

  it("changes nothing else: other fields, indentation and the trailing newline are preserved", () => {
    const root = workspace([{ dir: "packages/a", json: pub("@x/a", "1.0.0", { dependencies: { "@x/b": "workspace:*" } }) }]);
    const before = readFileSync(join(root, "packages/a/package.json"), "utf8");
    setVersion(root, "2.0.0");
    const after = readFileSync(join(root, "packages/a/package.json"), "utf8");
    expect(after).toBe(before.replace('"version": "1.0.0"', '"version": "2.0.0"'));
    expect(after.endsWith("\n")).toBe(true);
    expect(JSON.parse(after).dependencies["@x/b"]).toBe("workspace:*"); // pnpm rewrites this on publish
  });

  it("is idempotent, and refuses a version that is not a version", () => {
    const root = workspace([{ dir: "packages/a", json: pub("@x/a", "3.0.0") }], "3.0.0");
    expect(setVersion(root, "3.0.0")).toEqual([]);
    for (const bad of ["v3.0.0", "3", "latest", "", "1.2.3+x"]) expect(() => setVersion(root, bad), bad).toThrow(/not a version/);
  });
});

describe("checkRelease", () => {
  it("is ready when every publishable package is at the tag's version", () => {
    const root = workspace([
      { dir: "packages/a", json: pub("@x/a", "1.4.0") },
      { dir: "apps/cli", json: pub("@x/cli", "1.4.0") },
      { dir: "apps/demo", json: { name: "@x/demo", version: "0.0.1", private: true } }, // private: its number does not matter
    ]);
    const r = checkRelease(root, "v1.4.0");
    expect(r).toMatchObject({ ok: true, version: "1.4.0", npmTag: "latest", packages: ["@x/a", "@x/cli"], problems: [] });
  });

  it("refuses a tag that disagrees with any package, naming each one and how to fix it", () => {
    const root = workspace([
      { dir: "packages/a", json: pub("@x/a", "1.4.0") },
      { dir: "packages/b", json: pub("@x/b", "1.3.0") },
      { dir: "apps/cli", json: pub("@x/cli", "1.3.0") },
    ]);
    const r = checkRelease(root, "v1.4.0");
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.join("\n")).toContain("@x/b is at 1.3.0, but the tag is v1.4.0");
    expect(r.problems.join("\n")).toContain("pnpm release:version 1.4.0");
  });

  it("refuses a malformed tag, and a prerelease tag is published under 'next'", () => {
    const root = workspace([{ dir: "packages/a", json: pub("@x/a", "2.0.0-rc.1") }]);
    expect(checkRelease(root, "release-2").ok).toBe(false);
    expect(checkRelease(root, "release-2").problems[0]).toContain("not a release tag");
    expect(checkRelease(root, "v2.0.0-rc.1")).toMatchObject({ ok: true, npmTag: "next" });
  });

  it("refuses a scoped package that npm would treat as private", () => {
    const root = workspace([{ dir: "packages/a", json: { name: "@x/a", version: "1.0.0" } }]);
    const r = checkRelease(root, "v1.0.0");
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('publishConfig.access is not "public"');
  });

  it("refuses a workspace with nothing to publish, and a package without a name", () => {
    expect(checkRelease(workspace([]), "v1.0.0").problems.join()).toContain("no publishable packages");
    const root = workspace([{ dir: "packages/a", json: { version: "1.0.0" } }]);
    expect(checkRelease(root, "v1.0.0").problems.join()).toContain("has no name");
  });
});

describe("the real repository is releasable", () => {
  const packages = publishablePackages(repoRoot) as { dir: string; json: { name: string; version: string; publishConfig?: { access?: string } } }[];

  it("all seven published packages share one version, so one tag can release them together", () => {
    expect(packages.map((p) => p.json.name).sort()).toEqual([
      "@surgesim/calibrate",
      "@surgesim/cli",
      "@surgesim/engine",
      "@surgesim/importer",
      "@surgesim/platform",
      "@surgesim/report",
      "@surgesim/sdk",
    ]);
    expect(new Set(packages.map((p) => p.json.version)).size).toBe(1);
    const version = packages[0]!.json.version;
    expect(checkRelease(repoRoot, `v${version}`)).toMatchObject({ ok: true, version });
  });

  it("the command-line wrappers work: check-release succeeds for the current version and fails for another", () => {
    const version = packages[0]!.json.version;
    const run = (script: string, arg: string) => spawnSync(process.execPath, [join(repoRoot, "scripts", script), arg], { cwd: repoRoot, encoding: "utf8" });
    const good = run("check-release.mjs", `v${version}`);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("7 packages");
    const bad = run("check-release.mjs", "v999.0.0");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("pnpm release:version 999.0.0");
    expect(run("set-version.mjs", "not-a-version").status).toBe(2);
    expect(spawnSync(process.execPath, [join(repoRoot, "scripts", "check-release.mjs")], { cwd: repoRoot, encoding: "utf8" }).status).toBe(2);
  });
});
