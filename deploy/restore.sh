#!/usr/bin/env bash
# Restore (§8.6): database + artifacts from a backup directory made by backup.sh.
# Stop the app first (or point DATABASE_URL at a fresh database). Then: migrate → audit verify →
# smoke test, as in docs/runbook.md.
#
#   DATABASE_URL=postgres://… ARTIFACTS_DIR=/data/artifacts deploy/restore.sh /backups/20261117T020000Z
set -euo pipefail
src="${1:?usage: restore.sh <backup-dir>}"
: "${DATABASE_URL:?set DATABASE_URL}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${DATA_DIR:-/data}/artifacts}"

(cd "$src" && sha256sum --check --quiet SHA256SUMS)
echo "checksums ok: $src"

# The target must exist (CREATE DATABASE … beforehand); objects in it are replaced.
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" "$src/db.dump"
echo "database restored"

if [ -f "$src/artifacts.tgz" ]; then
  mkdir -p "$ARTIFACTS_DIR"
  tar -C "$ARTIFACTS_DIR" -xzf "$src/artifacts.tgz"
  echo "artifacts restored to $ARTIFACTS_DIR"
fi
if [ -f "$src/local-scm.tgz" ] && [ -n "${LOCAL_SCM_DIR:-}" ]; then
  mkdir -p "$LOCAL_SCM_DIR"
  tar -C "$LOCAL_SCM_DIR" -xzf "$src/local-scm.tgz"
  echo "local scm restored to $LOCAL_SCM_DIR"
fi
echo "next: run migrations (bun run migrate), then bun run audit:verify, then the smoke test in docs/runbook.md"
