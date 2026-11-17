# §7.3 multi-stage image: build web + install prod deps, run as non-root.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Behind a TLS-inspecting proxy, pass its CA as a build secret (never stored in the image):
#   docker compose build  with BUILD_CA_FILE=/path/to/ca.pem in deploy/.env  (see docs/deploy.md)
RUN --mount=type=secret,id=build_ca \
  if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
  bun install --frozen-lockfile
COPY . .
RUN cd apps/web && bun x vite build

# Docker CLI only (no daemon): the docker sandbox talks to the host's runtime (see docs/deploy.md).
FROM docker:29.0.4-cli AS dockercli

FROM oven/bun:1.4.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production ROLE=all PORT=3000 WEB_DIST=/app/apps/web/dist DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown -R bun:bun /data
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./
COPY --from=build --chown=bun:bun /app/packages ./packages
COPY --from=build --chown=bun:bun /app/apps/server ./apps/server
COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
USER bun
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/server/src/main.ts"]
