# Release Process

This document describes how to cut a new versioned release of `nostr-dag`.

## 1. Bump the version

Edit `Cargo.toml` and update the `version` field under `[package]`:

```toml
[package]
name = "nostr-dag"
version = "0.18.2"
```

The `build.rs` script automatically regenerates `demo/shared/app-version.generated.mjs` from this value on the next `cargo check`.

## 2. Run the full test suite

```bash
make test-all
```

This runs:
- Native Rust tests (`cargo test --features native`)
- JavaScript/Node tests (`node --test test/*.test.mjs`)

Ensure everything passes before tagging.

## 3. Commit the version bump

```bash
git add Cargo.toml Cargo.lock demo/shared/app-version.generated.mjs
git commit -m "chore(release): bump version to 0.18.2"
```

## 4. Tag the release

Use an annotated tag:

```bash
git tag -a v0.18.2 -m "Release v0.18.2"
```

## 5. Push to trigger CI and GitHub Pages

```bash
git push origin master --follow-tags
```

Pushing to `master` triggers:
- `.github/workflows/ci.yml` — builds and tests
- `.github/workflows/pages.yml` — builds the WASM package and deploys to GitHub Pages

## 6. Verify the deployment

1. Check the CI run: `gh run list --workflow=ci.yml`
2. Check the Pages deployment: `gh run list --workflow=pages.yml`
3. Visit the live site: `https://randymcmillan.github.io/nostr-dag/`
4. Verify the version in the footer/header matches the new tag.

## 7. (Optional) Trigger Pages manually

If the Pages workflow does not auto-trigger, run:

```bash
make deploy
```

Or via `gh`:

```bash
gh workflow run "Deploy to GitHub Pages" --ref master
```

## Versioning policy

- We follow [SemVer](https://semver.org/).
- Patch bumps (`0.17.1 -> 0.17.2`) for bug fixes and small features.
- Minor bumps (`0.17.x -> 0.18.0`) for new capabilities or breaking demo changes.
- Major bumps (`0.x -> 1.0.0`) when the NIP-PIP wire protocol or public API stabilizes.
