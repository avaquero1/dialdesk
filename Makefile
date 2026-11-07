# The gate: `make check` must pass before anything merges to main. CI runs the same target.
COMPOSE := docker compose -f deploy/compose.dev.yml --env-file .env
SERVICES := edge accounts board agent runner markets connections models audit

.PHONY: check typecheck lint gen gen-check contracts e2e rust images install dev-secrets infra-up infra-down fakes health stop-fakes containment containment-local valkey-test web web-e2e engine-image engine-image-check audit-test

check: rust gen-check typecheck lint contracts web e2e
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
# Pub/sub, the log stream and its consumer group, BullMQ with retries, and every service's ACL allow and deny.
VALKEY_TEST_PORT ?= 56393
VALKEY_TEST := VALKEY_DEV_PORT=$(VALKEY_TEST_PORT) docker compose -p vha-valkey-test -f deploy/compose.dev.yml --env-file .env
valkey-test:
	$(VALKEY_TEST) up -d --wait valkey
	VALKEY_TEST=1 VALKEY_TEST_PORT=$(VALKEY_TEST_PORT) npx vitest run --project contracts packages/service-kit/test/valkey.test.ts; \
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

containment:
	@echo "make containment runs on the real sandbox machine (Phase 3). Not built yet." && exit 1

# The compute sandbox image (engine/Dockerfile): the static engine binary alone, run with --network none.
ENGINE_IMAGE := vha-engine-compute
engine-image:
	DOCKER_BUILDKIT=1 docker build -q -f engine/Dockerfile --build-arg GIT_HASH=$$(git rev-parse --short=12 HEAD) \
	  -t $(ENGINE_IMAGE):$$(git rev-parse --short=12 HEAD) -t $(ENGINE_IMAGE):dev .
	@docker image inspect $(ENGINE_IMAGE):dev --format '$(ENGINE_IMAGE):dev {{.Id}} {{.Size}} bytes'

engine-image-check: engine-image
	engine/image-check.sh $(ENGINE_IMAGE):dev
