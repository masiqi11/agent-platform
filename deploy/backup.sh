#!/usr/bin/env bash
# Backup (§8.6): database (pg_dump, custom format) + artifacts directory, into BACKUP_DIR/<UTC time>/.
# Old backups beyond BACKUP_KEEP_DAYS (default 30) are removed after a successful run.
#
#   DATABASE_URL=postgres://… ARTIFACTS_DIR=/data/artifacts BACKUP_DIR=/backups deploy/backup.sh
#
# NOT included, on purpose:
#   - MASTER_KEY / MASTER_KEY_V2 and the other secrets: keep them separately (lose the master key =
#     every stored credential is unrecoverable).
#   - Workspaces and the repo mirror cache: rebuilt from the Git server on demand.
#   - S3 object storage (OBJECT_STORE=s3): use bucket versioning / replication instead.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
: "${BACKUP_DIR:?set BACKUP_DIR}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${DATA_DIR:-/data}/artifacts}"
KEEP="${BACKUP_KEEP_DAYS:-30}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$stamp"
tmp="$BACKUP_DIR/.incomplete-$stamp"
mkdir -p "$tmp"

pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$tmp/db.dump"
if [ -d "$ARTIFACTS_DIR" ]; then
  tar -C "$ARTIFACTS_DIR" -czf "$tmp/artifacts.tgz" .
fi
# Demo deployments keep their Git repos in LOCAL_SCM_DIR (not for production): include it when set.
if [ -n "${LOCAL_SCM_DIR:-}" ] && [ -d "$LOCAL_SCM_DIR" ]; then
  tar -C "$LOCAL_SCM_DIR" -czf "$tmp/local-scm.tgz" .
fi
(cd "$tmp" && sha256sum ./* > SHA256SUMS)
{
  echo "created_at=$stamp"
  echo "pg_dump=$(pg_dump --version | head -1)"
  psql "$DATABASE_URL" -Atc "select 'migration=' || name from ap_schema_version limit 1" 2>/dev/null || true
} > "$tmp/MANIFEST"
mv "$tmp" "$dest"
echo "backup written: $dest"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP" -print -exec rm -rf {} +
