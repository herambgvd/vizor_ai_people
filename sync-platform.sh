#!/usr/bin/env bash
# Re-vendor the shared platform (edge backend + web frontend) into this repo.
# Point PLATFORM_SRC at the canonical scenarios/platform dir (or a checkout of it).
#   PLATFORM_SRC=/path/to/scenarios/platform ./sync-platform.sh
set -euo pipefail
SRC="${PLATFORM_SRC:-../scenarios/platform}"
if [ ! -d "$SRC/edge" ]; then
  echo "platform source not found at: $SRC"
  echo "set PLATFORM_SRC=/path/to/scenarios/platform and re-run."
  exit 1
fi
echo "syncing platform from $SRC -> ./platform ..."
rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' --exclude '*.pyc' \
  --exclude 'web/node_modules' --exclude '.next' \
  "$SRC/" ./platform/
echo "done. rebuild: docker compose up -d --build"
