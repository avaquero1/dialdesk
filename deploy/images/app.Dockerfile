# syntax=docker/dockerfile:1
# The control VM's images, built ON the control VM by deploy/scripts/deploy.sh (never on a dev PC).
# Build context: the repo root.
#
#   docker build -f deploy/images/app.Dockerfile --target app   -t vha/app:<git hash>   .   # the 9 TypeScript services
#   docker build -f deploy/images/app.Dockerfile --target caddy -t vha/caddy:<git hash> .   # Caddy + the web bundle
#
# One `app` image holds every service; Compose picks the service with the command
# (`node --env-file=/run/secrets/env --import tsx services/<name>/src/main.ts`) and the user id (one per service).
# Bases are pinned by digest (read with `docker image inspect` on 2026-11-07).

FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS app
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
# Lockfiles first, so a code change doesn't reinstall every package.
COPY package.json package-lock.json ./
COPY packages packages
COPY services services
# tsx runs the TypeScript at start (the services import .ts files); it is a dev dependency, so keep dev deps.
RUN --mount=type=cache,id=vha-npm,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund --ignore-scripts \
 && { find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true; }
COPY tsconfig.json ./
COPY fixtures fixtures
COPY deploy/prod-secrets.ts deploy/egress-hosts.ts deploy/s3-bucket.ts deploy/
ARG GIT_HASH=unknown
LABEL org.opencontainers.image.title="vha-app" org.opencontainers.image.licenses="MIT" org.opencontainers.image.revision="${GIT_HASH}"
ENV GIT_HASH=${GIT_HASH}
# Compose sets the real user per service; this is the fallback.
USER 65534:65534
CMD ["node", "--version"]

# The web bundle. web/ is its own package (not a workspace). Until it has a build, a placeholder page is served.
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages packages
COPY services services
COPY web web
RUN --mount=type=cache,id=vha-npm,target=/root/.npm \
    mkdir -p /out \
 && if [ -f web/package.json ]; then \
      npm ci --include=dev --no-audit --no-fund --ignore-scripts \
      && (cd web && { [ -f package-lock.json ] && npm ci --no-audit --no-fund || true; } && npm run build) \
      && cp -r web/dist/. /out/; \
    else \
      printf '<!doctype html><meta charset="utf-8"><title>Coming up</title><p>The app is being deployed.</p>\n' > /out/index.html; \
    fi

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS caddy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /out /srv/web
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
