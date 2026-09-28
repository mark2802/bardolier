#!/usr/bin/env bash
# Build the menu-bar app from source and drop it into /Applications, without
# opening Xcode. The Mac-only half of phase 28 — Claude never runs this
# (CLAUDE.md's environment boundary: no xcodebuild in the dev container).
#
#   npm run setup:app
#   bash scripts/build-app.sh [--configuration Debug]
#
# Everything checked and reported before anything is built: this is meant to
# fail with a clear reason on the first run of a fresh clone, not partway
# through a ten-minute build.
set -euo pipefail

CONFIGURATION="Release"
if [ "${1:-}" = "--configuration" ]; then
  CONFIGURATION="${2:?--configuration needs a value}"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/app/bardolier/bardolier.xcodeproj"
SCHEME="bardolier"
PRODUCT_NAME="bardolier.app"
DEST="/Applications/Bardolier.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-app.sh: this builds a macOS app and only runs on macOS (found $(uname -s))." >&2
  echo "  The CLI half of setup (\`npm run setup\`) has no such restriction." >&2
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "build-app.sh: xcodebuild is not on PATH. Install Xcode (or the Command Line Tools) first." >&2
  exit 1
fi

if [ ! -d "$PROJECT" ]; then
  echo "build-app.sh: no project at $PROJECT." >&2
  exit 1
fi

if [ ! -w "/Applications" ]; then
  echo "build-app.sh: /Applications is not writable by $(whoami)." >&2
  exit 1
fi

DERIVED="$(mktemp -d)"
trap 'rm -rf "$DERIVED"' EXIT

echo "Building $SCHEME ($CONFIGURATION)…"
# Unsigned: a clone has no Apple Developer Team configured, and a locally
# built app carries no quarantine flag (that's a download's doing), so an
# unsigned app dragged straight into /Applications launches fine.
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  build

BUILT="$DERIVED/Build/Products/$CONFIGURATION/$PRODUCT_NAME"
if [ ! -d "$BUILT" ]; then
  echo "build-app.sh: build succeeded but $BUILT is missing — the product name or scheme may have changed." >&2
  exit 1
fi

rm -rf "$DEST"
cp -R "$BUILT" "$DEST"
echo "Installed $DEST"
echo "Launch it from Finder or \`open $DEST\` — it finds \`bardolier\` the same way \`bardolier doctor\` checks for it."
