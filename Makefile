# The gate: `make check` must pass before anything merges to main. CI runs the same target.
COMPOSE := docker compose -f deploy/compose.dev.yml --env-file .env
SERVICES := edge accounts board agent runner markets connections models audit

.PHONY: check typecheck lint gen gen-check contracts e2e rust images install dev-secrets infra-up infra-down fakes health stop-fakes containment containment-local valkey-test web web-e2e engine-image engine-image-check audit-test s3-test nft-check deploy-image-check shellcheck deploy-dry-run

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
# real edge, accounts and board, the rest as fakes). Not part of `make check`: it needs Docker and `make dev-secrets`.
web-e2e: web
	web/dev/stack.sh up
	npx vitest run --project web; s=$$?; web/dev/stack.sh down; exit $$s

# Real Chromium sandboxes behind the real proxy (Docker needed). E2E_SANDBOX=stub runs it without Docker.
e2e: rust images engine-image
	npx vitest run --project e2e

# The sandbox images. Docker's cache makes this a no-op when sandbox/images is unchanged.
images:
	docker build -q --target browse -t vha-browse:dev sandbox/images/browse
	docker build -q --target probe -t vha-probe:dev sandbox/images/browse

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
ENGINE_IMAGE := vha-engine-compute
engine-image:
	DOCKER_BUILDKIT=1 docker build -q -f engine/Dockerfile --build-arg GIT_HASH=$$(git rev-parse --short=12 HEAD) \
	  -t $(ENGINE_IMAGE):$$(git rev-parse --short=12 HEAD) -t $(ENGINE_IMAGE):dev .
	@docker image inspect $(ENGINE_IMAGE):dev --format '$(ENGINE_IMAGE):dev {{.Id}} {{.Size}} bytes'

engine-image-check: engine-image
	engine/image-check.sh $(ENGINE_IMAGE):dev
