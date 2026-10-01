// Release helpers: list the publishable packages, keep their versions in step, and check a tag before publishing.
// Plain JavaScript on purpose: the release job runs these with `node` and nothing else installed.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A release tag such as v1.2.3 or v1.2.3-rc.1 (no build metadata). */
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The version a tag stands for (without the leading v), or null if the tag is not a release tag. */
export function versionFromTag(tag) {
  const m = TAG.exec(tag);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}`;
}

/** The npm dist-tag to publish under: prereleases must not become "latest". */
export function npmTagFor(version) {
  return version.includes("-") ? "next" : "latest";
}

/** True for a plain X.Y.Z or X.Y.Z-prerelease version. */
export function isVersion(v) {
  return typeof v === "string" && versionFromTag(`v${v}`) === v;
}

/** Every workspace package (packages/* and apps/*) as { dir, file, json }. */
export function workspacePackages(root) {
  const out = [];
  for (const group of ["packages", "apps"]) {
    let names = [];
    try {
      names = readdirSync(join(root, group));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const file = join(root, group, name, "package.json");
      try {
        if (!statSync(file).isFile()) continue;
        out.push({ dir: `${group}/${name}`, file, json: JSON.parse(readFileSync(file, "utf8")) });
      } catch {
        /* not a package */
      }
    }
  }
  return out;
}

/** The packages that get published: everything not marked private. */
export function publishablePackages(root) {
  return workspacePackages(root).filter((p) => p.json.private !== true);
}

/**
 * Set the version of every package (publishable ones, and the private workspace ones and the root so the repo shows
 * one number). Dependencies between packages use "workspace:*", which pnpm turns into the real version on publish,
 * so they need no edit. Returns the files changed.
 */
export function setVersion(root, version) {
  if (!isVersion(version)) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
  const changed = [];
  const files = [join(root, "package.json"), ...workspacePackages(root).map((p) => p.file)];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const json = JSON.parse(text);
    if (json.version === version) continue;
    json.version = version;
    // Keep the file's own indentation and trailing newline so diffs stay minimal.
    const indent = /^( +|\t)"/m.exec(text)?.[1] ?? 2;
    writeFileSync(file, JSON.stringify(json, null, indent) + (text.endsWith("\n") ? "\n" : ""));
    changed.push(file);
  }
  return changed;
}

/**
 * Check that a release tag is safe to publish. Returns { ok, version, npmTag, packages, problems }.
 * Every publishable package must be at exactly the tag's version, must be set to public access, and must not be
 * missing a name, so a tag can never publish half a release or a package at the wrong number.
 */
export function checkRelease(root, tag) {
  const problems = [];
  const version = versionFromTag(tag);
  if (version === null) {
    return { ok: false, version: null, npmTag: null, packages: [], problems: [`"${tag}" is not a release tag (expected v1.2.3 or v1.2.3-rc.1)`] };
  }
  const packages = publishablePackages(root);
  if (packages.length === 0) problems.push("no publishable packages were found");
  for (const p of packages) {
    const { name, version: have, publishConfig } = p.json;
    if (!name) problems.push(`${p.dir}/package.json has no name`);
    if (have !== version) problems.push(`${name ?? p.dir} is at ${have}, but the tag is ${tag}. Run: pnpm release:version ${version}`);
    if (name?.startsWith("@") && publishConfig?.access !== "public") problems.push(`${name} is scoped but publishConfig.access is not "public" (npm would refuse it as private)`);
  }
  return { ok: problems.length === 0, version, npmTag: npmTagFor(version), packages: packages.map((p) => p.json.name), problems };
}
