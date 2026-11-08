# The compute sandbox image: the engine binary alone, static, on an empty filesystem.
# A plan plus numbers on stdin, the result plus receipts on stdout. No shell, no network code.
#
#   make engine-image          # builds vha-engine-compute:<worktree>-<git hash> (what make's tests run) and :dev (manual runs)
#   make engine-image-check    # runs it with --network none and the sandbox limits
#
# Run it the way the sandbox manager does:
#   docker run --rm -i --network none --read-only --cap-drop ALL \
#     --security-opt no-new-privileges --pids-limit 8 --memory 64m --cpus 0.5 \
#     vha-engine-compute:dev < input.json
#
# Build context: the repo root (`docker build -f engine/Dockerfile .`).
# engine/Dockerfile.dockerignore keeps everything but the Rust workspace out.

# rust:1.99-alpine, pinned by digest.
FROM rust:1.99-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383 AS build
WORKDIR /src
# The whole Rust workspace: cargo needs every member's manifest to read Cargo.lock.
COPY Cargo.toml Cargo.lock ./
COPY engine engine
COPY sandbox/manager sandbox/manager
COPY sandbox/proxy sandbox/proxy
# There is no .git in the image, so the git hash comes in as a build arg.
ARG GIT_HASH=unknown
ENV ENGINE_GIT_HASH=${GIT_HASH} \
    CARGO_PROFILE_RELEASE_LTO=true \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_STRIP=true
RUN --mount=type=cache,id=vha-engine-cargo,target=/usr/local/cargo/registry \
    cargo build --release --locked -p engine --bin engine \
 && cp target/release/engine /engine \
 && /engine --version

FROM scratch
ARG GIT_HASH=unknown
LABEL org.opencontainers.image.title="vha-engine-compute" \
      org.opencontainers.image.description="The fixed math engine: plan and numbers in, numbers and receipts out. No network." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_HASH}"
COPY --from=build /engine /engine
# nobody:nogroup. The image has no /etc/passwd, so the ids are numeric.
USER 65534:65534
ENTRYPOINT ["/engine"]
