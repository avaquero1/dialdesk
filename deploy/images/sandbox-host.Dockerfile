# syntax=docker/dockerfile:1
# The sandbox VM's host processes: sandbox-manager and egress-proxy (Rust, static musl), built ON the sandbox VM by
# deploy/scripts/deploy.sh. Build context: the repo root.
#
#   docker build -f deploy/images/sandbox-host.Dockerfile -t vha/sandbox-host:<git hash> .
#
# The sandboxes themselves are other images: sandbox/images/browse (Chromium) and engine/Dockerfile (compute).
# The manager drives Docker with the docker CLI, so the image carries it; the socket is mounted by Compose.

FROM rust:1.99-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS build
WORKDIR /src
RUN apk add --no-cache musl-dev
COPY Cargo.toml Cargo.lock ./
COPY engine engine
COPY sandbox/manager sandbox/manager
COPY sandbox/proxy sandbox/proxy
ARG GIT_HASH=unknown
ENV ENGINE_GIT_HASH=${GIT_HASH} CARGO_PROFILE_RELEASE_STRIP=true CARGO_BUILD_JOBS=2
RUN --mount=type=cache,id=vha-sbx-cargo,target=/usr/local/cargo/registry \
    --mount=type=cache,id=vha-sbx-target,target=/src/target \
    cargo build --release --locked -p sandbox-manager -p egress-proxy \
 && cp target/release/sandbox-manager target/release/egress-proxy /usr/local/bin/

FROM alpine:3.22@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034
RUN apk add --no-cache docker-cli ca-certificates \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true
COPY --from=build /usr/local/bin/sandbox-manager /usr/local/bin/egress-proxy /usr/local/bin/
ARG GIT_HASH=unknown
LABEL org.opencontainers.image.title="vha-sandbox-host" org.opencontainers.image.licenses="MIT" org.opencontainers.image.revision="${GIT_HASH}"
USER 10002:10002
ENTRYPOINT ["/usr/local/bin/sandbox-manager"]
CMD ["serve"]
