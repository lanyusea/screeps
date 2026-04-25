#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/root/screeps"
cd "$REPO_DIR"

# Stage project artifacts that should be archived.
git add docs .hermes prod 2>/dev/null || true

# Exit quietly if nothing changed.
if git diff --cached --quiet; then
  echo "No changes to archive."
  exit 0
fi

STAMP="$(date +%Y-%m-%d_%H%M%S)"
git commit -m "chore: archive Screeps updates ${STAMP}"
git push origin HEAD
