# The gate: `make check` must pass before anything merges to main. CI runs the same target.
COMPOSE := docker compose -f deploy/compose.dev.yml --env-file .env
SERVICES := edge accounts board agent runner markets connections models audit

.PHONY: check typecheck lint gen gen-check contracts e2e rust install dev-secrets infra-up infra-down fakes health stop-fakes containment valkey-test

check: rust gen-check typecheck lint contracts e2e
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

lint:
	npx eslint . --max-warnings 0

# Every fake's requests and responses validate against packages/contracts.
contracts:
	npx vitest run --project contracts

e2e: rust
	npx vitest run --project e2e

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
