# Release Process

This document describes how to cut a new version of `nostr-dag`.

## 1. Version Bump

Update the version in `Cargo.toml`:

```toml
[package]
version = "X.Y.Z"
```

Also regenerate the JS version module so the web UI stays in sync:

```bash
make version  # or ./scripts/generate-version.mjs
```

## 2. Update CHANGELOG

Summarise the user-visible changes since the last tag:

- Rust crate changes
- Web UI changes (`demo/`)
- Protocol changes (NIP-PIP, bridge, libp2p)
- Breaking changes

## 3. Run Full Test Suite

```bash
make test-all
```

This runs:
- `cargo test --lib`
- `cargo test --features p2p,wasm`
- `node --test test/*.test.mjs`

All tests must pass before tagging.

## 4. Tag the Release

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "nostr-dag vX.Y.Z"
git push origin master --tags
```

## 5. Verify CI and GitHub Pages

- Check <https://github.com/RandyMcMillan/nostr-dag/actions> for green CI.
- Verify the GitHub Pages deployment at <https://randymcmillan.github.io/nostr-dag/>.
- Spot-check `/git/`, `/bridge/`, and `/dag/` endpoints.

## 6. Post-Release Checks

- Confirm `cargo publish --dry-run` passes (if publishing to crates.io).
- Verify the deterministic libp2p peer ID appears on the Bridge peers list.
- Ensure the fallback CORS proxy is reachable from GH Pages.
