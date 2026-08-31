# Release Process

This document describes how to cut a new release of `nostr-dag`.

## Steps

1. **Bump version in `Cargo.toml`**
   ```bash
   # Edit version = "x.y.z" in Cargo.toml
   ```

2. **Build to regenerate version file**
   ```bash
   cargo build
   ```
   This updates `demo/shared/app-version.generated.mjs` via `build.rs`.

3. **Stage the generated version file**
   ```bash
   git add demo/shared/app-version.generated.mjs Cargo.toml
   ```
   `build.rs` auto-stages `app-version.generated.mjs` on successful builds, but
   verify it is included so the GitHub Pages deployment reports the correct
   version.

4. **Commit**
   ```bash
   git commit -m "chore(release): bump version to x.y.z"
   ```

5. **Tag**
   ```bash
   git tag -a vx.y.z -m "Release vx.y.z"
   ```

6. **Push**
   ```bash
   git push origin master --follow-tags
   ```

7. **Verify CI**
   - Check GitHub Actions for green builds.
   - Check GitHub Pages deployment shows the new version.

## Versioning

We follow [SemVer](https://semver.org/):
- **MAJOR** — breaking protocol or API changes
- **MINOR** — new features, backward compatible
- **PATCH** — bug fixes, backward compatible

## Hotfixes

For urgent fixes on an already-tagged release:
1. Branch from the tag: `git checkout -b hotfix/vx.y.z+1 vx.y.z`
2. Apply fix, bump patch version, commit, tag, and push.
