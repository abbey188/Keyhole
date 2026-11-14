#!/bin/sh
set -eu
case "${1:-release}" in
  release) cd /app/services/release && exec npx tsx src/main.ts ;;
  node) cd /app/services/node && exec npx tsx src/main.ts ;;
  *) echo "usage: release | node" >&2; exit 2 ;;
esac
