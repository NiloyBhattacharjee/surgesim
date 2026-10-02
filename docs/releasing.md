# Releasing

Releases are automated: **push a version tag and GitHub publishes all seven packages to npm**, then creates a GitHub
release with generated notes. You never run `npm publish` by hand.

## One-time setup

The release job needs permission to publish as you, through an npm access token stored as a repository secret.

1. **Create the token.** On npmjs.com: your avatar, **Access Tokens**, **Generate New Token**, **Granular Access Token**.
   - Name: `surgesim release`
   - Expiration: the longest offered (you must create a new one before it expires)
   - **Packages and scopes: Read and write**, limited to the **`@surgesim`** scope
   - Tick **"Bypass two-factor authentication"** (a CI job has no way to type a code). This is why the token must be
     limited to this one scope and kept secret.
2. **Store it as a secret.** Either in the GitHub repository (Settings, Secrets and variables, Actions, New repository
   secret, name `NPM_TOKEN`) or with the command line, which keeps it out of your shell history:
   ```bash
   gh secret set NPM_TOKEN --repo NiloyBhattacharjee/surgesim
   ```
   and paste the token when asked.

   **The secret must contain only the token, with no trailing newline, space or carriage return.** A stray one makes the
   publish fail with `npm error *** is not a legal HTTP header value` (this is what stopped the first v0.1.1 attempt).
   On Windows PowerShell, copy the token and set the secret from the clipboard with the whitespace trimmed:
   ```powershell
   $t = (Get-Clipboard).Trim(); gh secret set NPM_TOKEN --repo NiloyBhattacharjee/surgesim --body $t; Remove-Variable t
   ```
   The release job checks the secret's format before publishing and says so if it is wrong.

The token is never printed in logs. If it leaks, revoke it on npmjs.com and create a new one.

## Making a release

```bash
git checkout main && git pull
pnpm release:version 0.1.1            # sets that version in every package (and the root)
git commit -am "Release v0.1.1"
git push origin main                  # wait for the normal CI to go green on this commit
git tag v0.1.1
git push origin v0.1.1                # this starts the release
```

Watch it under the **Actions** tab. A normal release takes a few minutes.

### What the release job does, in order

1. Refuses to publish unless the tag is `vX.Y.Z` (or a prerelease such as `v0.2.0-rc.1`) and the tagged commit is on
   `main`.
2. `pnpm release:check` verifies **every package is at exactly the tag's version**, so a tag can never publish half a
   release or the wrong number. Prereleases are published under the npm tag `next`, so they never become the default
   install.
3. Type checks, builds and runs the **full test suite** from scratch.
4. Publishes with `pnpm -r publish`. It skips any package whose version is already on npm.
5. Checks that all seven packages really appear on npm at that version.
6. Creates the GitHub release (marked as a prerelease for `-rc` and similar versions).

If any step fails, nothing after it runs.

## Rehearsing

In the **Actions** tab, choose **Release**, **Run workflow**, and leave **dry run** ticked. It runs every check, the build,
the tests and a publish dry run, and publishes nothing. Do this after changing the workflow, and whenever you are unsure.
A real release can only come from a tag.

## If a release stops half way

Fix the cause and **re-run the failed job** (or push the tag again after deleting it). Packages already published are
skipped, so only the missing ones are published. This is exactly what happens if npm briefly rejects one package.

## Things to know

- **A published version can never be replaced.** If a release is wrong, publish `0.1.2`. npm lets you `unpublish` within
  72 hours, but the version number is then gone for good.
- **Choosing the number.** While below 1.0, bump the last number for fixes and the middle one for new features or
  changes. From 1.0 use semantic versioning: a breaking change to the JSON model format or the public API is a major
  version, and the model file's own `version` field must change too.
- **All packages share one version.** That keeps the install simple (the command-line tool depends on the others) and is
  checked on every release.
- **The Python SDK is released separately.** It has its own version in `sdks/python/pyproject.toml` and goes to PyPI, not
  npm.
- **Provenance is off.** npm can show a badge proving a package was built by a specific GitHub run, but it only works for
  public repositories. Once the repository is public, add `--provenance` to the publish step and `id-token: write` to the
  workflow permissions.
