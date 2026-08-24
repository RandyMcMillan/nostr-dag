set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    just --list

build:
    CARGO_TARGET_DIR=target cargo build --features native

test:
    just test-native
    just test-js

test-all:
    just test-native
    just test-js

test-native:
    CARGO_TARGET_DIR=target cargo test --features native

test-js:
    node --test test/*.test.mjs

build-relay:
    CARGO_TARGET_DIR=target cargo build --release --bin relay --bin federation --features relay

build-server:
    CARGO_TARGET_DIR=target cargo build --bin nostr-dag-server --features native

ensure-wasm-target:
    if ! rustup target list --installed | grep -qx wasm32-unknown-unknown; then rustup target add wasm32-unknown-unknown; fi

wasm: ensure-wasm-target
    if ! command -v wasm-pack >/dev/null 2>&1; then curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh; fi
    if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then if ! brew --prefix llvm >/dev/null 2>&1 || [ ! -x "$(brew --prefix llvm)/bin/clang" ] || [ ! -x "$(brew --prefix llvm)/bin/llvm-ar" ]; then brew install llvm; fi; LLVM_PATH=$(brew --prefix llvm); CC="$LLVM_PATH/bin/clang"; AR="$LLVM_PATH/bin/llvm-ar"; fi; if [ -z "${CC:-}" ]; then CC=$(command -v clang || xcrun --sdk macosx --find clang); AR=$(command -v llvm-ar || xcrun --sdk macosx --find llvm-ar || command -v ar); fi; CARGO_TARGET_DIR=target CC="$CC" AR="$AR" wasm-pack build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

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
    mkdir -p site/bridge
    cp demo/bridge/index.html site/bridge/index.html

demo:
    ./demo/run.sh

server: build-server site
    CARGO_TARGET_DIR=target cargo run --bin nostr-dag-server --features native

clean:
    cargo clean
    rm -rf pkg site

deploy:
    branch=$(git branch --show-current) && gh workflow run "Deploy to GitHub Pages" --ref "$branch"
