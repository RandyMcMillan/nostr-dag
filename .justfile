# Keep this file aligned with Makefile for shared build/site targets.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just --list

build:
    TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" cargo build --features native

test:
    just test-native
    just test-js

test-all:
    just test-native
    just test-js

test-native:
    TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" cargo test --features native

test-js:
    node --test test/*.test.mjs

build-relay:
    TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release --bin relay --bin federation --features relay

build-server:
    TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" cargo build --bin nostr-dag-server --features native

ensure-wasm-target:
    rm -rf ./site
    if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then rustup target add wasm32-unknown-unknown; fi

wasm: ensure-wasm-target
    if ! command -v wasm-pack >/dev/null 2>&1; then cargo install wasm-pack --locked; fi
    if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && brew --prefix llvm >/dev/null 2>&1 && [ -x "$(brew --prefix llvm)/bin/clang" ] && [ -x "$(brew --prefix llvm)/bin/llvm-ar" ]; then LLVM_PATH=$(brew --prefix llvm); CC="$LLVM_PATH/bin/clang"; AR="$LLVM_PATH/bin/llvm-ar"; fi; if [ -z "${CC:-}" ]; then CC=$(command -v clang || xcrun --sdk macosx --find clang); AR=$(command -v llvm-ar || xcrun --sdk macosx --find llvm-ar || command -v ar); fi; TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" CC="$CC" AR="$AR" wasm-pack build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
    mkdir -p site
    cp demo/index.html site/index.html
    cp demo/shared/favicon.ico site/favicon.ico
    mkdir -p site/shared
    cp demo/shared/favicon.ico site/shared/favicon.ico
    cp demo/shared/page.css site/shared/
    cp demo/shared/*.js demo/shared/*.mjs site/shared/
    mkdir -p site/git
    cp demo/git/index.html site/git/index.html
    cp demo/git/blame.html site/git/blame.html
    mkdir -p site/dag
    cp demo/dag/index.html site/dag/index.html
    # Keep this in sync with Makefile so /dag/ keeps its action module after site rebuilds.
    cp demo/dag/*.mjs site/dag/
    mkdir -p site/bridge
    cp demo/bridge/*.html site/bridge/

demo:
    ./demo/run.sh

server: build-server site
    TARGET_DIR="${CARGO_TARGET_DIR:-$(cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)}"; CARGO_TARGET_DIR="$TARGET_DIR" "$TARGET_DIR/debug/nostr-dag-server"

clean:
    cargo clean
    rm -rf pkg site

deploy:
    branch=$(git branch --show-current) && gh workflow run "Deploy to GitHub Pages" --ref "$branch"
