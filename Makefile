.DEFAULT_GOAL := help

CARGO ?= cargo
WASM_PACK ?= wasm-pack
WASM_TARGET ?= wasm32-unknown-unknown
GH ?= gh
BRANCH ?= $(shell git branch --show-current)
CARGO_TARGET_DIR ?= target

.PHONY: help build test test-all test-native test-js build-relay build-server ensure-wasm-target wasm site demo server clean deploy

help:
	@printf '%s\n' \
		'Targets:' \
		'  build       Build native library/binaries' \
		'  test        Run all tests' \
		'  test-all    Run all tests' \
		'  test-native Run native tests' \
		'  test-js     Run JS tests' \
		'  build-relay Build relay + federation release binaries' \
		'  build-server Build the nostr-dag server binary' \
		'  wasm        Build the WASM package into site/pkg' \
		'  site        Build the GitHub Pages site' \
		'  demo        Run the local demo launcher' \
		'  server      Run the nostr-dag server' \
		'  clean       Remove build artifacts' \
		'  deploy      Build the site and trigger the Pages workflow'

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --features native

test: test-native test-js

test-all: test-native test-js

test-native:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) test --features native

test-js:
	node --test test/*.test.mjs

build-relay:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --release --bin relay --bin federation --features relay

build-server:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --bin nostr-dag-server --features native

ensure-wasm-target:
	@rustup target list --installed | grep -qx "$(WASM_TARGET)" || rustup target add "$(WASM_TARGET)"

wasm: ensure-wasm-target
	rm -rf ./site
	@if ! command -v $(WASM_PACK) >/dev/null 2>&1; then \
		curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh; \
	fi
	@set -e; \
	if [ "$$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then \
		if ! brew --prefix llvm >/dev/null 2>&1 || [ ! -x "$$(brew --prefix llvm)/bin/clang" ] || [ ! -x "$$(brew --prefix llvm)/bin/llvm-ar" ]; then \
			brew install llvm; \
		fi; \
		LLVM_PATH="$$(brew --prefix llvm)"; \
		CC="$$LLVM_PATH/bin/clang"; \
		AR="$$LLVM_PATH/bin/llvm-ar"; \
	fi; \
	if [ -z "$${CC:-}" ]; then \
		CC="$$(command -v clang || xcrun --sdk macosx --find clang)"; \
		AR="$$(command -v llvm-ar || xcrun --sdk macosx --find llvm-ar || command -v ar)"; \
	fi; \
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) CC="$$CC" AR="$$AR" $(WASM_PACK) build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
	mkdir -p site
	printf '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta http-equiv="refresh" content="0; url=./dag/"/><title>nostr-dag</title></head><body><p>Redirecting to <a href="./dag/">dag</a>…</p></body></html>' > site/index.html
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
	mkdir -p site/bridge
	cp demo/bridge/*.html site/bridge/

demo:
	./demo/run.sh

server: build-server site
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) run --bin nostr-dag-server --features native

clean:
	$(CARGO) clean
	rm -rf pkg site

deploy:
	$(GH) workflow run "Deploy to GitHub Pages" --ref "$(BRANCH)"
