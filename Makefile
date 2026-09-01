# Keep this file aligned with .justfile for shared build/site targets.

.DEFAULT_GOAL := help

CARGO ?= cargo
WASM_PACK ?= wasm-pack
WASM_TARGET ?= wasm32-unknown-unknown
GH ?= gh
BRANCH ?= $(shell git branch --show-current)
ifndef CARGO_TARGET_DIR
CARGO_TARGET_DIR := $(shell cargo metadata --format-version 1 --no-deps | grep -o '"target_directory":"[^"]*"' | cut -d'"' -f4)
endif

.PHONY: help build test test-all test-native test-js test-p2p test-p2p-native-wasm test-pip-bare-repo build-relay build-server ensure-wasm-target wasm site demo server clean deploy githooks

help:
	@printf '%s\n' \
		'Targets:' \
		'  build       Build native library/binaries' \
		'  test        Run all tests' \
		'  test-all    Run all tests' \
		'  test-native Run native tests' \
		'  test-js     Run JS tests' \
		'  test-p2p    Run P2P integration tests' \
		'  test-p2p-native-wasm Run native↔wasm PIP test' \
		'  test-pip-bare-repo Run bare-repo PIP transfer tests' \
		'  build-relay Build relay + federation release binaries' \
		'  build-server Build the nostr-dag server binary' \
		'  wasm        Build the WASM package into site/pkg' \
		'  site        Build the GitHub Pages site' \
		'  demo        Run the local demo launcher' \
		'  server      Run the nostr-dag server' \
		'  githooks    Symlink ./githooks into .git/hooks' \
		'  clean       Remove build artifacts' \
		'  deploy      Build the site and trigger the Pages workflow'

build:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --features native

test: test-native test-js

test-all: test-native test-js

test-native:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) RUST_BACKTRACE=full RUST_TEST_THREADS=1 CARGO_TERM_VERBOSE=true $(CARGO) test --features native -- --nocapture

test-js:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) cargo check --quiet
	@echo "Starting nostr-dag-server for JS tests (P2P enabled)..."
	@pkill -f 'nostr-dag-server' 2>/dev/null || true
	@sleep 1
	@CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) P2P_ENABLE=1 $(CARGO) build --bin nostr-dag-server --features p2p,native >/dev/null 2>&1
	@P2P_ENABLE=1 ./target/debug/nostr-dag-server > /tmp/nostr-dag-server.$$.log 2>&1 &
	SERVER_PID=$$!; \
	SERVER_URL=""; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		SERVER_URL=$$(grep -o 'SERVER_URL=http://[^ ]*' /tmp/nostr-dag-server.$$.log 2>/dev/null | tail -1 | cut -d= -f2-); \
		if [ -n "$$SERVER_URL" ]; then break; fi; \
		sleep 1; \
	done; \
	if [ -z "$$SERVER_URL" ]; then echo "Server failed to start"; kill $$SERVER_PID 2>/dev/null; rm -f /tmp/nostr-dag-server.$$.log; exit 1; fi; \
	TEST_URL=$$(echo "$$SERVER_URL" | sed 's/0\.0\.0\.0/127.0.0.1/'); \
	echo "Server ready at $$SERVER_URL (tests use $$TEST_URL)"; \
	sleep 3; \
	for f in test/*.test.mjs; do \
		case "$$f" in \
			*p2p-native-wasm*) continue ;; \
		esac; \
		echo "=== running $$f ==="; \
		SERVER_URL=$$TEST_URL NODE_OPTIONS=--trace-uncaught node --test "$$f" || { kill $$SERVER_PID 2>/dev/null; rm -f /tmp/nostr-dag-server.$$.log; exit 1; }; \
	done; \
	kill $$SERVER_PID 2>/dev/null; \
	rm -f /tmp/nostr-dag-server.$$.log; \
	echo "Server stopped."

test-p2p:
	NODE_OPTIONS=--trace-uncaught node --test test/p2p-wasm.test.mjs test/pip-js-rust-parity.test.mjs test/nip-pip-wasm.test.mjs test/pip-git-bare-transfer.test.mjs

test-p2p-native-wasm:
	NODE_OPTIONS=--trace-uncaught node --test test/p2p-native-wasm-chromium.mjs

test-pip-bare-repo:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) RUST_BACKTRACE=full RUST_TEST_THREADS=1 CARGO_TERM_VERBOSE=true $(CARGO) test --features p2p git_bare_pip_transfer_verbose_trace -- --nocapture
	NODE_OPTIONS=--trace-uncaught node --test test/pip-git-bare-transfer.test.mjs

build-relay:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --release --bin relay --bin federation --features relay

build-server:
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) $(CARGO) build --bin nostr-dag-server --features native,p2p

ensure-wasm-target:
	@rustup target list --installed | grep -qx "$(WASM_TARGET)" || rustup target add "$(WASM_TARGET)"

wasm: ensure-wasm-target
	rm -rf ./site
	@if ! command -v $(WASM_PACK) >/dev/null 2>&1; then \
		cargo install wasm-pack --locked; \
	fi
	@set -e; \
	if [ "$$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1 && brew --prefix llvm >/dev/null 2>&1 && [ -x "$$(brew --prefix llvm)/bin/clang" ] && [ -x "$$(brew --prefix llvm)/bin/llvm-ar" ]; then \
		LLVM_PATH="$$(brew --prefix llvm)"; \
		CC="$$LLVM_PATH/bin/clang"; \
		AR="$$LLVM_PATH/bin/llvm-ar"; \
	fi; \
	if [ -z "$${CC:-}" ]; then \
		if [ "$$(uname -s)" = Darwin ]; then \
			CC="$$(command -v clang || xcrun --sdk macosx --find clang)"; \
			AR="$$(command -v llvm-ar || xcrun --sdk macosx --find llvm-ar || command -v ar)"; \
		else \
			CC="$$(command -v clang || echo clang)"; \
			AR="$$(command -v llvm-ar || command -v ar || echo ar)"; \
		fi; \
	fi; \
	CARGO_TARGET_DIR=$(CARGO_TARGET_DIR) CC="$$CC" AR="$$AR" $(WASM_PACK) build --target web --release --out-dir site/pkg -- --no-default-features --features wasm

site: wasm
	mkdir -p site
	cp demo/index.html site/index.html
	cp demo/shared/favicon.ico site/favicon.ico
	cp demo/.nojekyll site/.nojekyll
	mkdir -p site/.well-known
	cp demo/.well-known/nostr.json site/.well-known/nostr.json
	mkdir -p site/shared
	cp demo/shared/favicon.ico site/shared/favicon.ico
	cp demo/shared/page.css site/shared/
	cp demo/shared/*.js demo/shared/*.mjs site/shared/
	mkdir -p site/git
	cp demo/git/index.html site/git/index.html
	cp demo/git/blame.html site/git/blame.html
	cp demo/nip-pip-example.html site/nip-pip-example.html
	mkdir -p site/dag
	cp demo/dag/index.html site/dag/index.html
	# Keep this in sync with .justfile so /dag/ keeps its action module after site rebuilds.
	cp demo/dag/*.mjs site/dag/
	mkdir -p site/bridge
	cp demo/bridge/*.html site/bridge/
	mkdir -p site/vendor
	cp demo/vendor/*.mjs site/vendor/
	mkdir -p site/examples
	cp examples/*.html site/examples/
	cp demo/network_time.html site/network_time.html

demo:
	./demo/run.sh

server: build-server site
	P2P_ENABLE=1 cargo run --bin nostr-dag-server --features p2p,native

githooks:
	@mkdir -p .git/hooks
	@for hook in githooks/*; do \
		name=$$(basename "$$hook"); \
		target=".git/hooks/$$name"; \
		if [ -e "$$target" ] && [ ! -L "$$target" ]; then \
			echo "Backing up existing .git/hooks/$$name"; \
			mv "$$target" "$$target.backup"; \
		fi; \
		ln -sf "../../$$hook" "$$target"; \
		echo "Linked $$name"; \
	done

clean:
	$(CARGO) clean
	rm -rf pkg site

deploy:
	$(GH) workflow run "Deploy to GitHub Pages" --ref "$(BRANCH)"
