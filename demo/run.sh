#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/federation.toml}"
PORT="${PORT:-8080}"

PIDS=()

cleanup() {
    echo ""
    echo "Shutting down..."
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    wait 2>/dev/null || true
    echo "Done."
}

trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"

echo "Building..."
cargo build --release --bin relay --features relay 2>&1 | grep -E "Compiling|Finished" || true
cargo build --release --bin federation --features native 2>&1 | grep -E "Compiling|Finished" || true

# Build WASM package if missing so the DAG page can load it.
if [ ! -f "$SCRIPT_DIR/pkg/nostr_dag.js" ]; then
    echo "Building WASM package..."
    cd "$PROJECT_DIR"
    make wasm 2>&1 | grep -E "Compiling|Finished|Installing|warn" || true
    if [ -d "$PROJECT_DIR/site/pkg" ]; then
        mkdir -p "$SCRIPT_DIR/pkg"
        cp -r "$PROJECT_DIR/site/pkg/"* "$SCRIPT_DIR/pkg/"
        echo "WASM package copied to demo/pkg/"
    fi
    cd "$PROJECT_DIR"
fi

echo ""
echo "Reading federation config from $CONFIG_FILE..."

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    echo "Generate one with: cargo run --bin keygen"
    exit 1
fi

SECRETS=($(grep 'secret_key' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)".*/\1/'))
PUBKEYS=($(grep 'public_key' "$CONFIG_FILE" | sed 's/.*"\([^"]*\)".*/\1/'))

if [ ${#SECRETS[@]} -lt 1 ] || [ ${#PUBKEYS[@]} -lt 1 ]; then
    echo "Error: Failed to parse config file"
    exit 1
fi

FEDERATION_PUBKEYS=$(IFS=,; echo "${PUBKEYS[*]}")

echo ""
echo "Starting relay on port $PORT..."
PORT="$PORT" cargo run --release -q --bin relay --features relay &
PIDS+=($!)
sleep 1

RELAY_URL="ws://localhost:$PORT"
echo "Relay running at $RELAY_URL"

echo ""
echo "Starting ${#SECRETS[@]} federation daemons..."
for i in "${!SECRETS[@]}"; do
    FEDERATION_KEY="${SECRETS[$i]}" \
    RELAY_URL="$RELAY_URL" \
    FEDERATION_PUBKEYS="$FEDERATION_PUBKEYS" \
    RUST_LOG=federation=info \
    cargo run --release -q --bin federation --features native &
    PIDS+=($!)
    LAST_PID="${PIDS[$((${#PIDS[@]} - 1))]}"
    echo "  Started daemon $((i+1)) (pid ${LAST_PID}, pubkey ${PUBKEYS[$i]:0:8}...)"
done

echo ""
echo "=== Demo Ready ==="
echo ""
echo "Relay: $RELAY_URL"
echo ""
echo "Open in browser: file://$SCRIPT_DIR/index.html"
echo ""
echo "Press Ctrl+C to stop"
echo ""

wait
