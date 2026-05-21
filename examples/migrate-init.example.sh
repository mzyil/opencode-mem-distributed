#!/bin/sh
# examples/migrate-init.example.sh
# Reusable init wrapper. Runs migrate idempotently; safe for `restart: on-failure`.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

exec npx --yes opencode-mem-migrate --to postgres --url "$DATABASE_URL"
