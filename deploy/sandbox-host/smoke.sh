#!/usr/bin/env bash
# On the sandbox machine, as root, after setup.sh: one browse job through the INSTALLED services (the production proxy,
# no dev flags; the manager as vha-sandbox), on the real internet. An allowed page must load; the metadata address
# and an off-list host must be refused; the sandbox must be destroyed. Usage: smoke.sh [allowed-url]
set -euo pipefail
URL=${1:-https://example.com/}
HOST_=$(echo "$URL" | sed -E 's|^https://([^/:]+).*|\1|')
T=$(tr -d '\n' < /etc/vha/runner-token); API=http://$(sed -n 's/^SANDBOX_MANAGER_ADDR=//p' /etc/vha/sandbox-manager.env); J=smoke-$(date +%s)
call() { curl -fsS -H "authorization: Bearer $T" -H 'content-type: application/json' "$@"; }
call -X POST "$API/jobs" -d "{\"job_id\":\"$J\",\"run_id\":\"run_smoke\",\"widget_id\":\"wid_smoke\",\"kind\":\"browse\",\"browse\":{\"urls\":[\"$URL\",\"https://169.254.169.254/latest/meta-data/\",\"https://evil.example/x\"],\"allowlist\":[\"$HOST_\"],\"screenshot\":false,\"hold\":false}}" >/dev/null
for _ in $(seq 120); do
  s=$(call "$API/jobs/$J")
  case $s in *'"action":"sandbox.destroyed"'*) break;; esac
  sleep 0.5
done
echo "$s" | /opt/vha/node/bin/node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
const [, host] = process.argv;
const refused = (h, r) => j.proxy_log.some((e) => e.host === h && !e.allowed && e.reason === r);
const checks = {
  "allowed page loaded through the proxy": j.pages[0]?.status === 200,
  "169.254.169.254 refused (ip_literal)": refused("169.254.169.254", "ip_literal"),
  "evil.example refused (not_on_allowlist)": refused("evil.example", "not_on_allowlist"),
  "allowed host logged as allowed": j.proxy_log.some((e) => e.host === host && e.allowed),
  "trust log ends with sandbox.destroyed": j.trust_log?.at(-1)?.action === "sandbox.destroyed",
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"}  ${k}`);
console.log(`backend ${j.backend}, state ${j.state}, page ${j.pages[0]?.url} ${j.pages[0]?.status}, trust ${(j.trust_log ?? []).map((r) => r.action).join(" ")}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
' "$HOST_"
