#!/usr/bin/env bash
#
#  Builds a working checkout from upstream Cosmos Journeyer plus this overlay.
#
#  This repository holds only the background: the flight, the ship, the nebulae
#  and the page around them. The engine and its assets belong to upstream, are
#  large, and are already published — so they are fetched rather than vendored.
set -euo pipefail

UPSTREAM="https://github.com/BarthPaleologue/CosmosJourneyer.git"
SHA="$(tr -d '[:space:]' < "$(dirname "$0")/UPSTREAM")"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/Desktop/CJ-BG}"

if [ -e "$TARGET" ]; then
  echo "Refusing to overwrite existing $TARGET — pass a different path." >&2
  exit 1
fi

echo "==> Cloning upstream into $TARGET"
git clone "$UPSTREAM" "$TARGET"

# Pinned, because this overlay reaches into upstream internals (StarSystemView,
# the post-process manager, the chunk forge). A later upstream commit may well
# work, but it is not something this repository can promise.
echo "==> Checking out pinned $SHA"
git -C "$TARGET" checkout --quiet "$SHA"

echo "==> Restoring Git LFS objects"
node "$HERE/tools/fix-lfs.mjs" "$TARGET" "BarthPaleologue/CosmosJourneyer" "$SHA"

echo "==> Applying overlay"
cp -R "$HERE/overlay/." "$TARGET/"

echo "==> Installing dependencies"
cd "$TARGET"
pnpm install

cat <<'DONE'

Done. From the checkout:

  pnpm --filter game dev      # http://localhost:8080/background.html
  pnpm --filter game build    # dist/

DONE
