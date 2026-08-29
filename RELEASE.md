# Release Process

## Versioning

This project follows [Semantic Versioning](https://semver.org/).

- **MAJOR**: Breaking changes to the NIP-PIP protocol, libp2p wire format, or storage schema.
- **MINOR**: New features (git mirror mode, transport layers, relay support).
- **PATCH**: Bug fixes, test improvements, documentation updates.

## Steps to Cut a Release

1. **Ensure tests pass**
   ```bash
   make test-all
   ```
   All tests must be green before tagging.

2. **Update version**
   Edit `Cargo.toml` and bump `version`:
   ```toml
   [package]
   version = "x.y.z"
   ```

3. **Update generated version file**
   ```bash
   node -e "require('fs').writeFileSync('demo/shared/app-version.generated.mjs', \`export const APP_VERSION = '\${require('./package.json').version}'\n\`)"
   ```

4. **Commit version bump**
   ```bash
   git add Cargo.toml Cargo.lock demo/shared/app-version.generated.mjs
   git commit -m "release: bump version to vX.Y.Z"
   ```

5. **Create annotated tag**
   ```bash
   git tag -a vX.Y.Z -m "nostr-dag vX.Y.Z"
   ```

6. **Push tag**
   ```bash
   git push origin master
   git push origin vX.Y.Z
   ```

7. **Verify CI and GitHub Pages**
   - Check Actions run: https://github.com/RandyMcMillan/nostr-dag/actions
   - Verify GitHub Pages deployment of `/git/` and `/dag/` endpoints.

## Post-Release Checks

- [ ] `http://127.0.0.1:3000/git/` loads without 404s
- [ ] `http://127.0.0.1:3000/dag/` Create Event logs to footer
- [ ] `http://127.0.0.1:3000/git/?repo=nostr-dag&branch=master` shows current tags
- [ ] Native P2P test suite passes: `node --test test/p2p-node-integration.test.mjs`
- [ ] WASM NIP-PIP test passes: `node --test test/nip-pip-wasm.test.mjs`

## Notes

- The `demo/shared/app-version.generated.mjs` file is checked in so GitHub Pages builds reflect the correct version without needing a Node build step.
- GitHub Pages deployments can take 1–2 minutes to propagate after the Actions workflow completes.
- If a release is broken, delete the tag locally and remotely, fix, and re-tag:
  ```bash
  git tag -d vX.Y.Z
  git push --delete origin vX.Y.Z
  ```
