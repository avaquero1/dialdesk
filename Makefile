# The gate: `make check` must pass before anything merges to main. CI runs the same target.
COMPOSE := docker compose -f deploy/compose.dev.yml --env-file .env
SERVICES := edge accounts board agent runner markets connections models audit

# The sandbox images each worktree builds and its tests run: tagged <worktree>-<HEAD>, so two worktrees' checks never
# run each other's images (a shared :dev tag can be retagged by another check mid-run). Set SANDBOX_*_IMAGE to override;
# every target here (images, engine-image, e2e, e2e-real, containment-local) and sandbox/dev/topology.ts use these.
IMAGE_WT := $(shell basename "$$(git rev-parse --show-toplevel)" | tr -c 'A-Za-z0-9_.\n-' '_')
IMAGE_TAG := $(IMAGE_WT)-$(shell git rev-parse --short=12 HEAD)
export SANDBOX_BROWSE_IMAGE ?= vha-browse:$(IMAGE_TAG)
export SANDBOX_PROBE_IMAGE ?= vha-probe:$(IMAGE_TAG)
export SANDBOX_COMPUTE_IMAGE ?= vha-engine-compute:$(IMAGE_TAG)
# $(call prune-tags,VAR,repo): after a build, untag this worktree's older <worktree>-<hash> tags of one image. Only when
# VAR is the Makefile's own tag; never :dev (manual runs still use it) and never another worktree's tag.
prune-tags = $(if $(filter file,$(origin $(1))),docker image ls --format '{{.Repository}}:{{.Tag}}' $(2) | \
  grep -x '$(2):$(IMAGE_WT)-[0-9a-f]\{12\}' | grep -vx '$($(1))' | xargs -r docker image rm || true,true)

.PHONY: check typecheck lint gen gen-check contracts e2e rust images install dev-secrets infra-up infra-down fakes health stop-fakes containment containment-local valkey-test web web-e2e engine-image engine-image-check audit-test s3-test nft-check deploy-image-check shellcheck deploy-dry-run e2e-real e2e-live agent-pg-test

check: rust gen-check typecheck lint shellcheck contracts web e2e
	@echo "make check: all green"

install:
	npm ci

rust:
	cargo fmt --check
	cargo clippy -q --all-targets -- -D warnings
	cargo test -q
	cargo build -q

# Fails when packages/contracts' generated files (Rust schemas, TS types, JSON Schema) are stale.
gen-check:
	npx tsx packages/contracts/scripts/gen.ts --check

gen:
	npx tsx packages/contracts/scripts/gen.ts

typecheck:
	npx tsc -p tsconfig.json
	npx tsc -p web/tsconfig.json

lint:
	npx eslint . --max-warnings 0

# Every fake's requests and responses validate against packages/contracts.
contracts:
	npx vitest run --project contracts

# The browser bundle Caddy serves (web/dist). Fails on an inline script or style, eval, or no themes.
web:
	npx tsx web/build.ts

# The web app in a real browser (system Chromium) on its own local stack (web/dev/stack.sh: Compose project vha-web,
# real edge, accounts, board, agent and audit; the agent runs on the models fake, so no model is called; runner,
# markets, connections and models are fakes). Not part of `make check`: it needs Docker and `make dev-secrets`.
web-e2e: web
	web/dev/stack.sh up
	npx vitest run --project web; s=$$?; web/dev/stack.sh down; exit $$s

# Real Chromium sandboxes behind the real proxy (Docker needed). E2E_SANDBOX=stub runs it without Docker.
e2e: rust images engine-image
	npx vitest run --project e2e

# The sandbox images. Docker's cache makes this a no-op when sandbox/images is unchanged.
images:
	docker build -q --target browse -t $(SANDBOX_BROWSE_IMAGE) -t vha-browse:dev sandbox/images/browse
	docker build -q --target probe -t $(SANDBOX_PROBE_IMAGE) -t vha-probe:dev sandbox/images/browse
	@$(call prune-tags,SANDBOX_BROWSE_IMAGE,vha-browse)
	@$(call prune-tags,SANDBOX_PROBE_IMAGE,vha-probe)

# The containment tests on this PC's Docker (runc): caps, network, secrets, fresh sandboxes, kill and release.
containment-local: rust images engine-image
	npx vitest run --project containment

dev-secrets:
	npx tsx scripts/dev-secrets.ts

# The bus on a real Valkey: its own Compose project and port (so it never touches vha-dev), removed afterwards.
# Pub/sub, the log stream and its consumer group, BullMQ with retries, every service's ACL allow and deny, and runner's
# real worker fed by the scheduler (on the fakes and sandbox-manager's stub backend, so it builds that binary first).
VALKEY_TEST_PORT ?= 56393
VALKEY_TEST := VALKEY_DEV_PORT=$(VALKEY_TEST_PORT) docker compose -p vha-valkey-test -f deploy/compose.dev.yml --env-file .env
valkey-test:
	cargo build -q -p sandbox-manager
	$(VALKEY_TEST) up -d --wait valkey
	VALKEY_TEST=1 VALKEY_TEST_PORT=$(VALKEY_TEST_PORT) npx vitest run --project contracts packages/service-kit/test/valkey.test.ts services/runner/test/valkey-worker.test.ts; \
	  s=$$?; $(VALKEY_TEST) down -v; exit $$s

# audit on a real Postgres 17 and Valkey 8.1, as svc_audit and svc-audit: the chain, signed heads, verify catching a
# tampered row, UPDATE/DELETE refused, XAUTOCLAIM and the trust numbers. Its own Compose project and ports, removed afterwards.
AUDIT_TEST_PG_PORT ?= 55434
AUDIT_TEST_VALKEY_PORT ?= 56394
AUDIT_TEST := PG_DEV_PORT=$(AUDIT_TEST_PG_PORT) VALKEY_DEV_PORT=$(AUDIT_TEST_VALKEY_PORT) docker compose -p vha-audit-test -f deploy/compose.dev.yml --env-file .env
audit-test:
	$(AUDIT_TEST) up -d --wait postgres valkey
	AUDIT_TEST=1 AUDIT_TEST_PG_PORT=$(AUDIT_TEST_PG_PORT) AUDIT_TEST_VALKEY_PORT=$(AUDIT_TEST_VALKEY_PORT) npx vitest run --project contracts services/audit/test/pg.test.ts; \
	  s=$$?; $(AUDIT_TEST) down -v; exit $$s

# The S3 client, board's screenshots and audit's write-once heads on a real S3 server (versitygw), with fresh credentials
# each run: put/get/list, a wrong signature refused, write-once, and a bucket with object lock. Its own Compose project
# and port, removed afterwards. Not part of `make check` (it needs Docker).
S3_TEST_PORT ?= 57070
S3_TEST_ENV := S3_TEST_PORT=$(S3_TEST_PORT) S3_TEST_ACCESS=vha$(shell openssl rand -hex 8) S3_TEST_SECRET=$(shell openssl rand -hex 20)
S3_TEST := docker compose -p vha-s3-test -f deploy/compose.s3-test.yml
s3-test:
	@$(S3_TEST_ENV) $(S3_TEST) up -d s3
	@$(S3_TEST_ENV) S3_TEST=1 npx vitest run --project contracts tests/deploy/s3.test.ts; \
	  s=$$?; $(S3_TEST_ENV) $(S3_TEST) down -v; exit $$s

# control.nft and sandbox.nft with `nft -c` in a private network namespace (never this machine's own firewall), then
# the egress refill for real in one (tests/deploy/egress-refresh.test.ts). Needs nft and unprivileged user namespaces.
nft-check:
	@d=$$(mktemp -d) && trap 'rm -rf "$$d"' EXIT && \
	  cp deploy/nftables/example-control-vars.nft $$d/control-vars.nft && \
	  cp deploy/nftables/example-sandbox-vars.nft $$d/sandbox-vars.nft && \
	  cp deploy/nftables/egress-enforce.nft $$d/control-egress-mode.nft && \
	  unshare -rn nft -c -I $$d -f deploy/nftables/control.nft && \
	  unshare -rn nft -c -I $$d -f deploy/nftables/sandbox.nft && \
	  echo "nft-check: control.nft and sandbox.nft pass nft -c"
	npx vitest run --project contracts tests/deploy/egress-refresh.test.ts

# Milestone V1.1's end-to-end check: build the app image, print the egress table in it, and run the prod-secrets dry
# run in it (exit 0, no value printed). Needs Docker; through build-slot on a dev PC.
deploy-image-check:
	deploy/images/check-app-image.sh

# The whole control deploy, printed, with the example settings (changes nothing; tests/deploy/deploy-script.test.ts checks it).
deploy-dry-run:
	deploy/scripts/deploy.sh control --dry-run --env-file deploy/deploy.env.example

# Every shell script in the repo (tracked or new), through the pinned shellcheck image (no network, the repo read-only):
# warnings and errors fail it everywhere; in the deploy kit's own folders (deploy/scripts, nftables, images: run as root
# on control) every note fails it too.
SHELLCHECK_IMAGE := koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d
shellcheck:
	@files=$$(git ls-files --cached --others --exclude-standard '*.sh') && \
	  deploy=$$(git ls-files --cached --others --exclude-standard 'deploy/scripts/*.sh' 'deploy/nftables/*.sh' 'deploy/images/*.sh') && \
	  sc="docker run --rm --network none -v $$PWD:/mnt:ro -w /mnt $(SHELLCHECK_IMAGE) --external-sources" && \
	  $$sc --severity=warning $$files && $$sc --severity=style $$deploy && \
	  echo "shellcheck: $$(echo $$files | wc -w) scripts pass (warning), $$(echo $$deploy | wc -w) in the deploy kit pass every note"

# Meeting point 1 on this machine: the whole journey (e2e/real/journey.test.ts) on the nine real services, only the model
# faked. Compose project vha-e2e-real (Postgres, Valkey, the fixture site on :8300); the test starts sandbox-manager on the
# docker backend and the services with tsx on :18440-18448 (e2e/real/stack.ts), after audit's migrations (as audit_owner).
# Everything is removed afterwards.
E2E_REAL_PG_PORT ?= 55441
E2E_REAL_VALKEY_PORT ?= 56441
E2E_REAL := PG_DEV_PORT=$(E2E_REAL_PG_PORT) VALKEY_DEV_PORT=$(E2E_REAL_VALKEY_PORT) docker compose -p vha-e2e-real -f deploy/compose.dev.yml --env-file .env
e2e-real: rust images engine-image
	$(E2E_REAL) up -d --wait postgres valkey fixtures
	@# audit never migrates itself (D1.1.2): its migrations run as audit_owner, from the admin login, before it starts.
	@AUDIT_MIGRATE_DATABASE_URL=postgres://postgres:$$(sed -n 's/^PG_SUPERUSER_PASSWORD=//p' .env)@127.0.0.1:$(E2E_REAL_PG_PORT)/app \
	  npm run -s migrate -w services/audit || { $(E2E_REAL) down -v; exit 1; }
	E2E_REAL_PG_PORT=$(E2E_REAL_PG_PORT) E2E_REAL_VALKEY_PORT=$(E2E_REAL_VALKEY_PORT) npx vitest run --project e2e-real; \
	  s=$$?; $(E2E_REAL) down -v; exit $$s

# Meeting point 2 (C2.1): the same journey on the real pieces (e2e/live/journey.test.ts): Vultr's models under the step's
# caps (E2E_LIVE_CAP_USD, at most 1.00, global and per account; the spend is kept in E2E_LIVE_USAGE across runs), the live
# Kalshi, Polymarket and feed APIs (Brave when MARKETS_BRAVE_KEY_FILE exists), real Chromium sandboxes whose proxy reaches
# the internet, and our own poisoned test page as one candidate of the E2E_LIVE_POISON_TEAM game's research run. It spends
# money and uses the internet: never part of `make check`. Compose project vha-e2e-live (Postgres :55461, Valkey :56461),
# services on :18460-18468. Each run's record goes to E2E_LIVE_OUT/E2E_LIVE_RUN.json.
E2E_LIVE_PG_PORT ?= 55461
E2E_LIVE_VALKEY_PORT ?= 56461
E2E_LIVE_CAP_USD ?= 1.00
E2E_LIVE_USAGE ?= $(CURDIR)/.logs/e2e-live/usage.json
E2E_LIVE_POISON_TEAM ?= kc
E2E_LIVE := PG_DEV_PORT=$(E2E_LIVE_PG_PORT) VALKEY_DEV_PORT=$(E2E_LIVE_VALKEY_PORT) docker compose -p vha-e2e-live -f deploy/compose.dev.yml --env-file .env
e2e-live: rust images engine-image
	@mkdir -p "$$(dirname "$(E2E_LIVE_USAGE)")"
	$(E2E_LIVE) up -d --wait postgres valkey
	@AUDIT_MIGRATE_DATABASE_URL=postgres://postgres:$$(sed -n 's/^PG_SUPERUSER_PASSWORD=//p' .env)@127.0.0.1:$(E2E_LIVE_PG_PORT)/app \
	  npm run -s migrate -w services/audit || { $(E2E_LIVE) down -v; exit 1; }
	E2E_REAL_PORT_BASE=18460 E2E_REAL_PG_PORT=$(E2E_LIVE_PG_PORT) E2E_REAL_VALKEY_PORT=$(E2E_LIVE_VALKEY_PORT) \
	  E2E_LIVE_CAP_USD=$(E2E_LIVE_CAP_USD) E2E_LIVE_USAGE=$(E2E_LIVE_USAGE) E2E_LIVE_POISON_TEAM=$(E2E_LIVE_POISON_TEAM) \
	  npx vitest run --project e2e-live; \
	  s=$$?; $(E2E_LIVE) down -v; exit $$s

# agent's Postgres conversation store (services/agent/test/pg-store.test.ts) on a throwaway Postgres 17: its own Compose
# project and port, removed afterwards.
AGENT_PG_TEST_PORT ?= 55436
AGENT_PG_TEST := PG_DEV_PORT=$(AGENT_PG_TEST_PORT) docker compose -p vha-agent-pg-test -f deploy/compose.dev.yml --env-file .env
agent-pg-test:
	$(AGENT_PG_TEST) up -d --wait postgres
	AGENT_TEST_DATABASE_URL=postgres://postgres:$$(sed -n 's/^PG_SUPERUSER_PASSWORD=//p' .env)@127.0.0.1:$(AGENT_PG_TEST_PORT)/app \
	  npx vitest run --project contracts services/agent/test/pg-store.test.ts; \
	  s=$$?; $(AGENT_PG_TEST) down -v; exit $$s

# Local infra only (Postgres, Valkey, fixtures). The services run natively with tsx.
infra-up:
	$(COMPOSE) up -d --wait

infra-down:
	$(COMPOSE) down -v

# Start all 9 services as fakes in the background (logs in .logs/), then `make health`.
fakes:
	@mkdir -p .logs
	@for s in $(SERVICES); do \
	  S=$$(echo $$s | tr a-z A-Z); \
	  env $${S}_FAKE=1 node --env-file-if-exists=.env --import tsx services/$$s/src/main.ts > .logs/$$s.log 2>&1 & echo $$! > .logs/$$s.pid; \
	done; sleep 4; $(MAKE) -s health

health:
	@for p in 8080 8101 8102 8103 8104 8105 8106 8107 8108; do \
	  printf "%s " $$p; curl -fsS http://127.0.0.1:$$p/health || echo "DOWN"; echo; \
	done

stop-fakes:
	@for f in .logs/*.pid; do kill $$(cat $$f) 2>/dev/null || true; rm -f $$f; done

# The containment tests on the sandbox machine (as root, after deploy/sandbox-host/setup.sh): the same checks as
# containment-local on gVisor, behind the host proxy and nftables. SANDBOX_BACKEND=gvisor must be set explicitly.
# The full output and the scoreboard go to CONTAINMENT_OUT.
CONTAINMENT_OUT ?= containment-out
containment:
	@test "$$SANDBOX_BACKEND" = gvisor || { echo "make containment: set SANDBOX_BACKEND=gvisor explicitly"; exit 2; }
	@mkdir -p $(CONTAINMENT_OUT)
	SANDBOX_TOPOLOGY=host CONTAINMENT_SCORE=$(CONTAINMENT_OUT)/score.json npx vitest run --project containment \
	  --reporter=default --reporter=json --outputFile.json=$(CONTAINMENT_OUT)/vitest.json; s=$$?; \
	  npx tsx sandbox/test/scoreboard.ts $(CONTAINMENT_OUT)/vitest.json $(CONTAINMENT_OUT)/score.json > $(CONTAINMENT_OUT)/scoreboard.md; b=$$?; \
	  cat $(CONTAINMENT_OUT)/scoreboard.md; [ $$s -eq 0 ] && [ $$b -eq 0 ]

# The compute sandbox image (engine/Dockerfile): the static engine binary alone, run with --network none.
# Tagged $(SANDBOX_COMPUTE_IMAGE) (this worktree's own, see the top) and :dev.
ENGINE_IMAGE := vha-engine-compute
engine-image:
	DOCKER_BUILDKIT=1 docker build -q -f engine/Dockerfile --build-arg GIT_HASH=$$(git rev-parse --short=12 HEAD) \
	  -t $(SANDBOX_COMPUTE_IMAGE) -t $(ENGINE_IMAGE):dev .
	@$(call prune-tags,SANDBOX_COMPUTE_IMAGE,$(ENGINE_IMAGE))
	@docker image inspect $(SANDBOX_COMPUTE_IMAGE) --format '$(SANDBOX_COMPUTE_IMAGE) {{.Id}} {{.Size}} bytes'

engine-image-check: engine-image
	engine/image-check.sh $(SANDBOX_COMPUTE_IMAGE)
