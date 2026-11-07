/**
 * The containment scoreboard for the slides: `npx tsx sandbox/test/scoreboard.ts <vitest.json> <score.json>`.
 * Reads vitest's JSON report (which checks passed) and the numbers the checks measured, and prints one Markdown table.
 * `make containment` runs it after the checks.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

const [reportPath, scorePath] = process.argv.slice(2);
if (!reportPath || !scorePath) {
  process.stderr.write('usage: scoreboard.ts <vitest.json> <score.json>\n');
  process.exit(2);
}
type Assertion = { title: string; status: string; duration?: number };
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { testResults: { assertionResults: Assertion[] }[] };
let score: Record<string, number | string | boolean> = {};
try {
  score = JSON.parse(readFileSync(scorePath, 'utf8'));
} catch {
  // No numbers (the run stopped early): the table still shows which checks passed.
}
const checks = report.testResults.flatMap((f) => f.assertionResults);
const passed = checks.filter((c) => c.status === 'passed').length;
const v = (k: string, unit = '') => (score[k] === undefined ? 'not measured' : `${score[k]}${unit}`);

const rows: [string, string][] = [
  ['Containment checks passed', `${passed} / ${checks.length}`],
  ['Backend', `${v('backend')} (Chromium's own sandbox: ${v('chromium_sandbox')})`],
  ['Fork bomb held at', `${v('forkbomb_peak')} processes (cap ${v('forkbomb_cap')})`],
  ['Memory hog stopped at', `${v('memhog_mb', ' MB')} (cap ${v('memhog_cap_mb', ' MB')}; OOM-killed: ${v('memhog_oom_killed')}, exit ${v('memhog_exit')})`],
  ['Infinite loop killed after', `${v('loop_kill_ms', ' ms')} (cap ${v('loop_cap_ms', ' ms')})`],
  ['Direct routes out blocked', `${v('routes_blocked')} of 6 tried (public IP, public DNS, metadata, 10/8, 192.168/16, the proxy's other ports); no DNS inside`],
  ['Poisoned page: callouts refused', `${v('poisoned_callouts_refused')} of ${v('poisoned_callouts')} (${v('poisoned_requests_refused')} requests refused in all)`],
  ['Poisoned page: create to page read', v('create_to_read_ms', ' ms')],
  ['Kill answered in', v('kill_answer_ms', ' ms')],
  ['Kill to sandbox.destroyed in the trust log', v('kill_to_destroyed_row_ms', ' ms')],
];
const out = [
  `# Containment scoreboard`,
  '',
  `Host ${hostname()}, ${new Date().toISOString()}.`,
  '',
  '| Number | Value |',
  '|---|---|',
  ...rows.map(([a, b]) => `| ${a} | ${b} |`),
  '',
  '| Check | Result | ms |',
  '|---|---|---|',
  ...checks.map((c) => `| ${c.title} | ${c.status === 'passed' ? 'PASS' : c.status.toUpperCase()} | ${Math.round(c.duration ?? 0)} |`),
  '',
];
process.stdout.write(out.join('\n'));
process.exit(passed === checks.length && checks.length > 0 ? 0 : 1);
