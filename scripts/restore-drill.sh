#!/usr/bin/env bash
# Restore drill (§8.6, S8): seed → backup → restore into an empty database and data dir → migrate →
# audit chain verify → row counts and artifacts match → server starts and the owner can sign in.
#
#   PG_URL=postgres://user:pass@127.0.0.1:5432/postgres scripts/restore-drill.sh [results.json]
#
# Uses throwaway databases on PG_URL's server (dropped at the end) and a temp data dir.
set -euo pipefail
: "${PG_URL:?set PG_URL (any database on the server; used to create/drop the drill databases)}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-}"
work="$(mktemp -d)"
src_db="ap_drill_src_$$"
dst_db="ap_drill_dst_$$"
url_for() { echo "${PG_URL%/*}/$1"; }
SRC="$(url_for "$src_db")"
DST="$(url_for "$dst_db")"
export MASTER_KEY="drill-master-key-0123456789abcdef0123"
export SEED_PASSWORD="Drill-Password-42"
# A bootstrap model provider gives the seed an encrypted credential to carry through the restore.
export LLM_BASE_URL="http://127.0.0.1:9/v1" LLM_MODEL="drill-model" LLM_API_KEY="sk-drill-credential-0000000042"
cleanup() {
  [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true
  psql "$PG_URL" -qc "drop database if exists $src_db with (force)" -qc "drop database if exists $dst_db with (force)" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
step() { echo "== $*"; }
counts() { psql "$1" -Atc "select string_agg(t || '=' || n, ' ' order by t) from (
  select 'audit_log' t, count(*) n from audit_log union all select 'event', count(*) from event union all
  select 'project', count(*) from project union all select 'task', count(*) from task union all
  select 'credential', count(*) from credential union all select 'agent', count(*) from agent union all
  select 'repo', count(*) from repo) x"; }

step "source database + seed"
psql "$PG_URL" -qc "create database $src_db" >/dev/null
mkdir -p "$work/src-data"
(cd "$root" && DATABASE_URL="$SRC" bun run migrate >/dev/null)
(cd "$root/apps/server" && DATABASE_URL="$SRC" DATA_DIR="$work/src-data" bun src/cli/seed.ts --owner owner@drill.test >/dev/null)
# Bootstrap model provider → one encrypted credential in the database.
(cd "$root/apps/server" && DATABASE_URL="$SRC" DATA_DIR="$work/src-data" bun -e '
  const { createConfig } = await import("./src/config"); const { loadEnv } = await import("./src/env"); const { createServices } = await import("./src/services");
  const s = createServices(createConfig(loadEnv()), { owner: "drill" });
  const [t] = await s.db.root.execute("select id from tenant limit 1").then((r) => r.rows);
  await s.llm.ensureDefaults(t.id); await s.db.close();')
mkdir -p "$work/src-data/artifacts/drill" && echo "evidence" > "$work/src-data/artifacts/drill/sample.log"
(cd "$root" && DATABASE_URL="$SRC" bun run audit:verify)
before="$(counts "$SRC")"
echo "source: $before"

step "backup"
DATABASE_URL="$SRC" ARTIFACTS_DIR="$work/src-data/artifacts" LOCAL_SCM_DIR="$work/src-data/local-scm" BACKUP_DIR="$work/backups" "$root/deploy/backup.sh"
bk="$(ls -d "$work"/backups/20* | head -1)"

step "restore into an empty database and data dir"
psql "$PG_URL" -qc "create database $dst_db" >/dev/null
psql "$DST" -qc "create extension if not exists vector" >/dev/null
DATABASE_URL="$DST" ARTIFACTS_DIR="$work/dst-data/artifacts" LOCAL_SCM_DIR="$work/dst-data/local-scm" "$root/deploy/restore.sh" "$bk"

step "migrate → audit verify → compare"
(cd "$root" && DATABASE_URL="$DST" bun run migrate >/dev/null)
(cd "$root" && DATABASE_URL="$DST" bun run audit:verify)
after="$(counts "$DST")"
echo "restored: $after"
[ "$before" = "$after" ] || { echo "row counts differ"; exit 1; }
case "$after" in *credential=0*) echo "no credential carried through the restore"; exit 1 ;; esac
# The restored credentials decrypt with the same master key (kept outside the backup): rekey with a
# second key version decrypts every one of them first, and fails on any it cannot read.
(cd "$root" && DATABASE_URL="$DST" MASTER_KEY_V2="drill-master-key-v2-0123456789abcdef" bun run rekey)
cmp "$work/src-data/artifacts/drill/sample.log" "$work/dst-data/artifacts/drill/sample.log"
src_arts=$(find "$work/src-data/artifacts" -type f | wc -l)
dst_arts=$(find "$work/dst-data/artifacts" -type f | wc -l)
[ "$src_arts" = "$dst_arts" ] || { echo "artifacts differ: $src_arts vs $dst_arts"; exit 1; }

step "smoke: server on the restored data, owner signs in, sees the seeded projects"
port=$((20000 + RANDOM % 10000))
(cd "$root/apps/server" && DATABASE_URL="$DST" DATA_DIR="$work/dst-data" PORT="$port" HOST=127.0.0.1 LOG_LEVEL=error bun src/main.ts >"$work/server.log" 2>&1) &
server_pid=$!
for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$port/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -fs "http://127.0.0.1:$port/readyz"; echo
token=$(curl -fs -H 'content-type: application/json' -d "{\"email\":\"owner@drill.test\",\"password\":\"$SEED_PASSWORD\"}" "http://127.0.0.1:$port/api/v1/auth/sign-in" | sed -E 's/.*"token":"([^"]+)".*/\1/')
projects=$(curl -fs -H "authorization: Bearer $token" "http://127.0.0.1:$port/api/v1/projects" | grep -o '"key":"[A-Z]*"' | tr '\n' ' ')
echo "projects after restore: $projects"
[ -n "$projects" ] || { echo "no projects visible after restore"; exit 1; }

echo "RESTORE DRILL PASSED"
if [ -n "$out" ]; then
  printf '{\n  "at": "%s",\n  "backup": "%s",\n  "counts": "%s",\n  "artifacts": %s,\n  "projects": "%s",\n  "steps": ["seed", "backup", "restore to empty db + data dir", "migrate", "audit verify", "counts + artifacts match", "server ready, owner signs in"],\n  "result": "passed"\n}\n' \
    "$(date -u +%FT%TZ)" "$(basename "$bk")" "$after" "$dst_arts" "$(echo "$projects" | xargs)" > "$out"
fi
