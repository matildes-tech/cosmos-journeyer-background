#!/usr/bin/env bash
#
#  Copies the overlay back out of a working checkout into this repository.
#
#  Day-to-day editing happens in the checkout, where the thing actually runs.
#  The file list is taken from the overlay tree itself, so adding a file here
#  once is enough for it to keep being synced afterwards.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$HOME/Desktop/CJ-BG}"

if [ ! -d "$WORK" ]; then
  echo "No checkout at $WORK — pass its path, or run ./bootstrap.sh first." >&2
  exit 1
fi

count=0
missing=0
while IFS= read -r file; do
  rel="${file#"$HERE/overlay/"}"
  if [ -f "$WORK/$rel" ]; then
    cp "$WORK/$rel" "$file"
    count=$((count + 1))
  else
    echo "  missing in checkout: $rel" >&2
    missing=$((missing + 1))
  fi
done < <(find "$HERE/overlay" -type f)

echo "Synced $count file(s) from $WORK${missing:+, $missing missing}."
git -C "$HERE" status --short
