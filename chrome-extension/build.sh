#!/bin/bash
# Build chrome extension — copies only required dist files

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DIR")"

# SKIP_BUILD=1 lets the release orchestrator build the player once and reuse it
# across every target instead of rebuilding here (3× otherwise).
if [ -z "$SKIP_BUILD" ]; then
  echo "Building movi-player dist..."
  cd "$ROOT"
  npm run build:ts
else
  echo "Reusing existing dist/element.slim.js (SKIP_BUILD set)"
fi

echo "Copying required files to extension..."
rm -rf "$DIR/dist"
mkdir -p "$DIR/dist"

# The slim bundle plus the engine beside it, NOT the 11.8MB all-in-one: AMO's
# linter will not parse a JS file over 5MB, and both add-ons load the same
# player.js. The bundle finds the engine with `new URL("movi.wasm",
# import.meta.url)`, so the pair only has to stay in one directory.
cp "$ROOT/dist/element.slim.js" "$ROOT/dist/movi.wasm" "$DIR/dist/"

echo "Done! Extension size: $(du -sh "$DIR/dist" | cut -f1)"
echo "Load extension from: $DIR"
echo "  → chrome://extensions → Developer mode → Load unpacked"
