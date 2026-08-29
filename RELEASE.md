# Release Process

This document describes how to cut a new release of `nostr-dag`.

## Steps

1. **Update `Cargo.toml`**
   ```bash
   # Edit the version field in Cargo.toml
   sed -i '' 's/^version = "X.Y.Z"/version = "NEW_VERSION"/' Cargo.toml
   ```

2. **Regenerate `app-version.generated.mjs`**
   The `build.rs` script automatically writes `demo/shared/app-version.generated.mjs`
   from `CARGO_PKG_VERSION` during compilation. Run a cargo command to trigger it:
   ```bash
   cargo check --quiet
   ```
   Verify the file updated:
   ```bash
   cat demo/shared/app-version.generated.mjs
   ```

3. **Commit the version bump**
   ```bash
   git add Cargo.toml demo/shared/app-version.generated.mjs
   git commit -m "chore: bump version to NEW_VERSION"
   ```

4. **Create an annotated tag**
   ```bash
   git tag -a vNEW_VERSION -m "Release vNEW_VERSION"
   ```

5. **Push to origin**
   ```bash
   git push origin master
   git push origin vNEW_VERSION
   ```

6. **Verify CI**
   Check the GitHub Actions run for the new tag and confirm all jobs pass:
   https://github.com/RandyMcMillan/nostr-dag/actions

## Notes

- The JS frontend imports `APP_VERSION` from `demo/shared/app-version.mjs`,
  which re-exports from `app-version.generated.mjs`. Do not edit the generated
  file by hand; always let `build.rs` produce it so it stays in sync with
  `Cargo.toml`.
- If `cargo check` does not update the generated file, it may already match.
  Make sure `Cargo.toml` was saved before running cargo.
