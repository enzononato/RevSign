#!/usr/bin/env bash

# Exit on error.
set -e

SCRIPT_DIR="$(readlink -f "$(dirname "$0")")"
WEB_APP_DIR="$SCRIPT_DIR/.."

# Store the original directory
ORIGINAL_DIR=$(pwd)

# Set up trap to ensure we return to original directory
trap 'cd "$ORIGINAL_DIR"' EXIT

cd "$WEB_APP_DIR"

start_time=$(date +%s)

echo "[Build]: Extracting and compiling translations"
# REVALLE: extract, overlay pt-BR + validação, compile (em vez de `npm run translate`)
npm run translate:extract --prefix ../../
node ../../scripts/revalle/i18n/apply-overlay.mjs
node ../../scripts/revalle/i18n/check-po.mjs --locale pt-BR --warn-missing
npm run translate:compile --prefix ../../

echo "[Build]: Building app"
npm run build:app

echo "[Build]: Building server"
npm run build:server

# Copy over the entry point for the server.
cp server/main.js build/server/main.js

# Copy over all web.js translations
cp -r ../../packages/lib/translations build/server/hono/packages/lib/translations

# Time taken
end_time=$(date +%s)

echo "[Build]: Done in $((end_time - start_time)) seconds"