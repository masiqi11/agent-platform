#!/usr/bin/env bash
# Local GitLab CE + Runner for the S6 real-GitLab scenario (apps/server/test/gitlab/s6-gitlab.ts).
# Needs docker, ~4 GB RAM, ~8 GB disk, and `gitlab` resolving to 127.0.0.1 (this script adds it to
# /etc/hosts when run as root). Writes tokens to $STATE (default .gitlab-local/, git-ignored).
#
#   scripts/gitlab-local.sh up      # start GitLab + Runner, create pay/payments-e2e, print env to run the test
#   scripts/gitlab-local.sh down    # remove containers
set -euo pipefail
STATE=${STATE:-.gitlab-local}
IMG=${GITLAB_IMAGE:-gitlab/gitlab-ce:17.11.4-ce.0}
RUNNER_IMG=${RUNNER_IMAGE:-gitlab/gitlab-runner:v17.11.3}
G=http://gitlab/api/v4
json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

if [ "${1:-}" = down ]; then docker rm -f gitlab gl-runner >/dev/null 2>&1 || true; exit 0; fi
mkdir -p "$STATE/runner"
grep -q " gitlab$" /etc/hosts || echo "127.0.0.1 gitlab" >>/etc/hosts
docker network create gl >/dev/null 2>&1 || true
ROOT_PW=$(cat "$STATE/root-pw" 2>/dev/null || { p="Zq$(openssl rand -hex 10)Kx"; echo "$p" >"$STATE/root-pw"; echo "$p"; })
if ! docker ps --format '{{.Names}}' | grep -qx gitlab; then
  docker run -d --name gitlab --network gl --hostname gitlab -p 80:80 --shm-size 256m \
    -e GITLAB_OMNIBUS_CONFIG="external_url 'http://gitlab'; puma['worker_processes']=0; sidekiq['concurrency']=5; prometheus_monitoring['enable']=false; registry['enable']=false; gitlab_kas['enable']=false; gitlab_rails['initial_root_password']='$ROOT_PW'" \
    "$IMG" >/dev/null
fi
echo "waiting for GitLab…"
until [ "$(curl -s -o /dev/null -w '%{http_code}' http://gitlab/users/sign_in)" = 200 ]; do sleep 10; done

# Admin token (only used by this script).
if [ ! -s "$STATE/root-pat" ]; then
  PAT="glpat-$(openssl rand -hex 12)"
  docker exec gitlab gitlab-rails runner "t=User.find_by_username('root').personal_access_tokens.create!(name:'e2e-admin', scopes:['api','create_runner'], expires_at: 30.days.from_now); t.set_token('$PAT'); t.save!"
  echo "$PAT" >"$STATE/root-pat"
fi
A="PRIVATE-TOKEN: $(cat "$STATE/root-pat")"

if [ ! -s "$STATE/project-token" ]; then
  GID=$(curl -sf -H "$A" -X POST $G/groups -d name=pay -d path=pay | json '["id"]')
  PID=$(curl -sf -H "$A" -X POST $G/projects -d name=payments-e2e -d "namespace_id=$GID" | json '["id"]')
  SEED=$(mktemp -d)
  (cd apps/server && bun test/gitlab/s6-gitlab.ts --print-seed "$SEED")
  (cd "$SEED" && git init -q -b main && git add -A && git -c user.name=root -c user.email=root@gitlab commit -qm "演示仓库：支付服务" &&
    git push -q "http://root:$(cat "$OLDPWD/$STATE/root-pat")@gitlab/pay/payments-e2e.git" main) || true
  # The platform's token is a Developer: it must not push main, but must be allowed to merge into it.
  curl -sf -o /dev/null -H "$A" -X DELETE "$G/projects/$PID/protected_branches/main" || true
  curl -sf -o /dev/null -H "$A" -X POST "$G/projects/$PID/protected_branches?name=main&push_access_level=40&merge_access_level=30"
  curl -sf -H "$A" -X POST "$G/projects/$PID/access_tokens" -H 'content-type: application/json' \
    -d "{\"name\":\"platform\",\"scopes\":[\"api\"],\"access_level\":30,\"expires_at\":\"$(date -d '+30 days' +%F)\"}" | json '["token"]' >"$STATE/project-token"
  RT=$(curl -sf -H "$A" -X POST $G/user/runners -d runner_type=project_type -d "project_id=$PID" -d run_untagged=true | json '["token"]')
  cat >"$STATE/runner/config.toml" <<TOML
concurrent = 2
check_interval = 3
[[runners]]
  name = "e2e-docker"
  url = "http://gitlab"
  clone_url = "http://gitlab"
  token = "$RT"
  executor = "docker"
  [runners.docker]
    image = "oven/bun:1.4.4-alpine"
    pull_policy = ["if-not-present"]
    network_mode = "gl"
    volumes = ["/cache"]
TOML
fi
docker ps --format '{{.Names}}' | grep -qx gl-runner ||
  docker run -d --name gl-runner --network gl -v /var/run/docker.sock:/var/run/docker.sock -v "$(pwd)/$STATE/runner:/etc/gitlab-runner" "$RUNNER_IMG" >/dev/null
echo
echo "GitLab ready. Run the scenario with:"
echo "  cd apps/server && GITLAB_URL=http://gitlab/pay/payments-e2e GITLAB_TOKEN=\$(cat ../../$STATE/project-token) TEST_DATABASE_URL=… bun test/gitlab/s6-gitlab.ts"
