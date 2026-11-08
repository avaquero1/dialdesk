/**
 * The Safety app (inside: Trust) and "How we got this" (inside: Receipts), in plain words.
 *
 * Safety: today's numbers from audit's trust page through edge, the tricks blocked on this board (from the widgets'
 * results), the connected accounts, every consent the user gave (connecting an account, when, its scope; sharing its
 * numbers), the spend on AI per job, and the signed log with a "Check it" button (verify).
 * Counts: every sealed box is destroyed after its read, so "destroyed" already includes the killed ones; a killed box
 * is also a trick blocked.
 *
 * How we got this: one widget's result and its last run trace, as four plain steps (prices, articles, math, the safety
 * check), with a Details toggle for the technical receipt. It never quotes a page: a blocked page shows only its site
 * and the time its box was destroyed, and no fact's quote appears here at all.
 */
import type { RunTraceStep, Widget, WidgetResult } from '@app/contracts';
import { api, ApiError, type TrustPage, type Verify } from './api.ts';
import { esc, wait } from './dom.ts';
import { S } from './board.ts';
import { IC } from './icons.ts';
import { closeBtn, panel, rz, sheetHead, tileFrom, toast } from './surfaces.ts';
import { loadConnections } from './accounts.ts';
import { connections } from './conns.ts';
import { fmtNum, fmtTime, tileName } from './widgets.ts';

type Num = WidgetResult['numbers'][number];
type Receipt = WidgetResult['receipts'][number];

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const money = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EXCHANGE: Record<string, string> = { kalshi: 'Kalshi', polymarket: 'Polymarket' };
const exName = (e: string) => EXCHANGE[e] ?? e;
/** What each model does, for the spend list. */
const ROLE: Record<string, string> = {
  chat: 'Talking with you',
  planner: 'Planning the research',
  reader: 'Reading articles',
  summarizer: 'Writing the short line',
  guard: 'The safety check',
};
/** What each engine step works out, in plain words. */
const OP: Record<string, string> = {
  implied_probability: 'The chance, from the price',
  price_to_odds: 'The price as odds',
  odds_to_probability: 'The odds as a chance',
  expected_value: 'What it is worth at your number',
  movement: 'How far it moved',
  volatility: 'How much it swings',
  gap: 'How far apart the two exchanges are',
  base_rate: 'How often this happened before',
  base_rate_history: 'How often this happened before',
  position_value: 'What your position is worth',
  pnl: 'Your gain or loss',
};

/** Every blocked page on the board today, newest first: the widget, the site and the time its box was destroyed. */
function blockedOnBoard() {
  const out: { widget: string; domain: string; at: string }[] = [];
  for (const w of S.widgets.values()) for (const b of w.result?.blocked ?? []) out.push({ widget: tileName(w), domain: b.domain, at: b.killed_at });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

const stat = (n: number, words: string, i: number, key: string) =>
  `<div class="sf-stat${rz(i)} data-stat="${key}"><b class="num">${esc(n.toLocaleString('en-US'))}</b><span>${esc(words)}</span></div>`;
const section = (t: string, i: number) => `<h3 class="sf-h${rz(i)}>${esc(t)}</h3>`;
const line = (t: string, s: string, i: number, cls = '') => `<div class="rowitem${cls}${rz(i)}><div class="grow"><div class="t">${esc(t)}</div><div class="s">${esc(s)}</div></div></div>`;

type Counts = TrustPage['counts'];

/** Connected accounts: the log's scope checks, and the live list (a fake or a log that is a step behind). */
function connectedNow(logged: Counts['connected']) {
  const out = new Map(logged.map((a) => [a.connection_id, a]));
  for (const x of connections())
    if (!out.has(x.connection_id) && x.checked_at && (x.exchange === 'kalshi' ? x.scope_verified : true))
      out.set(x.connection_id, { connection_id: x.connection_id, exchange: x.exchange, scope: x.scope, checked_at: x.checked_at });
  return [...out.values()];
}

const dayTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${fmtTime(iso)}`;
};

/**
 * Every consent the user gave, newest first: each account they connected (when, and its scope) and each time they let
 * their widgets use its numbers or stopped (audit's consent.* rows). From the log, plus the live connections list.
 */
function consentsGiven(c: Counts) {
  const ex = new Map<string, string>();
  for (const a of c.connected) ex.set(a.connection_id, a.exchange);
  for (const x of connections()) ex.set(x.connection_id, x.exchange);
  const out: { at: string; kind: string; what: string; sub: string }[] = [];
  const seen = new Set<string>();
  const connect = (id: string, exchange: string, scope: string, at: string, label?: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const who = exchange === 'polymarket' ? `your Polymarket wallet${label ? ` ${label}` : ''}` : `Kalshi${label ? ` (key ${label})` : ''}`;
    const sc = scope === 'read' ? 'Read only: we can see your balance and positions, never trade or move money.' : `Only "${scope}".`;
    out.push({ at, kind: 'connect', what: `You connected ${who}`, sub: `${dayTime(at)}. ${sc}` });
  };
  for (const x of connections()) if (x.checked_at) connect(x.connection_id, x.exchange, x.scope, x.checked_at, x.label);
  for (const a of c.connected) connect(a.connection_id, a.exchange, a.scope, a.checked_at);
  for (const g of c.consents) {
    const name = exName(ex.get(g.subject_id ?? '') ?? 'your account');
    const what = g.action.endsWith('numbers_shared')
      ? `You let your widgets use ${name}'s numbers`
      : g.action.endsWith('numbers_withdrawn')
        ? `You stopped sharing ${name}'s numbers`
        : `You allowed: ${g.action.replace(/^consent\./, '').replace(/_/g, ' ')}`;
    out.push({ at: g.at, kind: g.action.replace(/^consent\./, ''), what, sub: `${dayTime(g.at)}. Balance and positions only, never a key.` });
  }
  // The live list says sharing is on but the log has no row for it yet: still show it.
  for (const x of connections())
    if (x.share_numbers && !c.consents.some((g) => g.subject_id === x.connection_id))
      out.push({ at: x.checked_at ?? '', kind: 'numbers_shared', what: `You let your widgets use ${exName(x.exchange)}'s numbers`, sub: 'Balance and positions only, never a key.' });
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function safetyHTML(t: TrustPage | null) {
  let i = 2;
  const head = sheetHead('Safety', 'Every article is read in a sealed box that is destroyed right after.');
  if (!t) return head + `<div class="stub-note${rz(i)}>Today's numbers didn't load. Close this and open Safety again.</div>`;
  const c = t.counts;
  const tricks = c.sandboxes_killed;
  const html = [head, section('Today', i++)];
  html.push(
    `<div class="sf-stats">` +
      stat(c.sandboxes_created, c.sandboxes_created === 1 ? 'article read in a sealed box' : 'articles read in sealed boxes', i++, 'read') +
      stat(c.sandboxes_destroyed, c.sandboxes_destroyed === 1 ? 'sealed box destroyed after use' : 'sealed boxes destroyed after use', i++, 'destroyed') +
      stat(c.proxy_refused, c.proxy_refused === 1 ? 'request stopped at the door' : 'requests stopped at the door', i++, 'stopped') +
      stat(tricks, tricks === 1 ? 'trick blocked' : 'tricks blocked', i++, 'tricks') +
      `</div>`,
  );
  if (tricks) html.push(`<p class="sf-note${rz(i++)}>A box that caught a trick is destroyed too, so it counts in both.</p>`);

  html.push(section('Tricks blocked', i++));
  const blocked = blockedOnBoard();
  if (blocked.length)
    for (const b of blocked)
      html.push(
        `<div class="rowitem sf-trick${rz(i++)}><span class="ic">${IC.blocked}</span><div class="grow"><div class="t">${esc(fmtTime(b.at))} · ${esc(b.domain)}</div>` +
          `<div class="s">${esc(`This page tried to trick the agent while it worked on ${b.widget}. Its sealed box was destroyed.`)}</div></div></div>`,
      );
  else html.push(line('None on your board', 'When a page tries to give the agent orders, it shows here with the time.', i++));

  html.push(section('Connected accounts', i++));
  const conns = connectedNow(c.connected);
  if (conns.length)
    for (const a of conns)
      html.push(
        `<div class="rowitem${rz(i++)}><span class="ic ok">${IC.check}</span><div class="grow"><div class="t">${esc(exName(a.exchange))}</div>` +
          `<div class="s">${esc(a.exchange === 'polymarket' ? 'Public wallet, read only. We can look, never trade.' : `${a.scope === 'read' ? 'Read only' : `Only "${a.scope}"`}, checked with ${exName(a.exchange)} at ${fmtTime(a.checked_at)}. We can look, never trade.`)}</div></div></div>`,
      );
  else html.push(line('No accounts connected', 'Connecting one is always read only: we can look, never trade.', i++));

  html.push(section('What you allowed', i++));
  const given = consentsGiven(c);
  if (given.length) for (const g of given) html.push(`<div class="rowitem sf-consent${rz(i++)} data-consent="${esc(g.kind)}"><span class="ic">${IC.check}</span><div class="grow"><div class="t">${esc(g.what)}</div><div class="s">${esc(g.sub)}</div></div></div>`);
  else html.push(line('Nothing yet', 'When you connect an account or let your widgets use its numbers, it shows here with the time.', i++));

  const sp = t.spend;
  html.push(section('Spent on AI today', i++));
  html.push(
    `<div class="sf-spend${rz(i++)}>` +
      Object.entries(sp.by_role)
        .map(([role, usd]) => `<div class="sf-sp"><span>${esc(ROLE[role] ?? role)}</span><b class="num">${esc(money(usd))}</b></div>`)
        .join('') +
      `<div class="sf-sp sf-sp--total"><span>Total, of a ${esc(money(sp.daily_cap_usd))} daily limit</span><b class="num">${esc(money(sp.total_usd))}</b></div></div>`,
  );
  if (sp.kill_switch) html.push(`<p class="sf-note${rz(i++)}>The daily limit is reached, so the AI is off until tomorrow.</p>`);

  html.push(section('The signed log', i++));
  html.push(
    `<div class="rowitem sf-log${rz(i++)}><span class="ic">${IC.shield}</span><div class="grow"><div class="t">Every step is written down and signed</div>` +
      `<div class="s" id="sf-log-s">${esc(`${plural(c.head.seq + 1, 'entry', 'entries')}, last signed at ${fmtTime(c.head.signed_at)}. Nobody can change one without it showing.`)}</div></div>` +
      `<button class="btn btn--accent sf-check" type="button" id="sf-check">Check it</button></div>` +
      `<p class="sf-result${rz(i)} id="sf-result" role="status" aria-live="polite"></p>`,
  );
  return html.join('');
}

function verifyWords(v: Verify) {
  return v.ok
    ? { ok: true, text: `Verified. All ${plural(v.checked, 'entry', 'entries')} are unchanged and the signature matches.` }
    : { ok: false, text: `Something changed at entry ${(v.first_bad_seq ?? 0) + 1}. We've flagged it.` };
}

export async function openSafety(id: string) {
  const [t] = await Promise.all([api.trust().catch(() => null), loadConnections()]);
  panel('sheet sheet--safety', safetyHTML(t), {
    w: 520,
    from: tileFrom(id),
    fromFn: () => tileFrom(id),
    after: (s) => {
      const btn = s.querySelector<HTMLButtonElement>('#sf-check');
      const out = s.querySelector<HTMLElement>('#sf-result');
      btn?.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Checking…';
        out!.className = out!.className.replace(/ is-(ok|bad)/g, '');
        api
          .auditVerify()
          .then((v) => {
            const r = verifyWords(v);
            out!.textContent = r.text;
            out!.classList.add(r.ok ? 'is-ok' : 'is-bad');
            btn.textContent = r.ok ? 'Verified' : 'Check again';
          })
          .catch((e: unknown) => {
            out!.textContent = e instanceof ApiError && e.status === 0 ? "Can't reach the server. Try again in a moment." : "The check didn't finish. Try again.";
            btn.textContent = 'Check it';
          })
          .finally(() => (btn.disabled = false));
      });
    },
  });
}

// ---------- How we got this ----------

const step = (n: number, title: string, body: string, i: number) =>
  `<section class="how-step${rz(i)} data-step="${n}"><span class="how-n num" aria-hidden="true">${n}</span><div class="grow"><h3>${esc(title)}</h3>${body}</div></section>`;
const p = (t: string) => `<p>${esc(t)}</p>`;

function pricesStep(w: Widget, r: WidgetResult | null) {
  const q = w.quotes ?? [];
  const ex = [...new Set(q.map((x) => exName(x.exchange)))];
  const from = ex.length ? ex.join(' and ') : 'the exchanges';
  const at = r?.as_of ?? q.map((x) => x.as_of).sort().at(-1) ?? null;
  const stale = r?.stale || q.some((x) => x.stale);
  const t = r?.kind === 'research' && !q.length ? 'Prices aren’t part of this one: it is about the news.' : `Prices from ${from}${at ? `, as of ${fmtTime(at)}` : ''}.`;
  return p(t) + (stale ? p("One exchange wasn't answering, so these are the last prices we had.") : '');
}

function articlesStep(r: WidgetResult | null, trace: RunTraceStep[]) {
  if (!r) return p('Nothing read yet. Until its first run, this widget shows the latest exchange prices only.');
  const reads = new Map(trace.filter((s) => s.step === 'read' && s.source).map((s) => [s.source!.candidate_id, s]));
  const out: string[] = [];
  for (const s of r.sources) {
    const tr = reads.get(s.candidate_id);
    const who = s.outlet ?? s.domain;
    if (s.status === 'read') out.push(`<li class="how-src is-read">${IC.check}<span><b>${esc(who)}</b> was read in a sealed box${tr ? ` at ${esc(fmtTime(tr.at))}` : ''}. The box was destroyed after.</span></li>`);
    else if (s.status === 'blocked') {
      const b = r.blocked.find((x) => x.candidate_id === s.candidate_id);
      out.push(
        `<li class="how-src is-blocked">${IC.blocked}<span><b>Blocked:</b> a page on ${esc(s.domain)} tried to trick the agent. Its sealed box was destroyed${b ? ` at ${esc(fmtTime(b.killed_at))}` : ''}. Nothing from it was used.</span></li>`,
      );
    } else out.push(`<li class="how-src">${IC.close}<span>${esc(who)} couldn't be read, so nothing from it was used.</span></li>`);
  }
  // A blocked page the sources list doesn't name (it never should): still say so, still without a quote.
  for (const b of r.blocked)
    if (!r.sources.some((s) => s.candidate_id === b.candidate_id))
      out.push(`<li class="how-src is-blocked">${IC.blocked}<span><b>Blocked:</b> a page on ${esc(b.domain)} tried to trick the agent. Its sealed box was destroyed at ${esc(fmtTime(b.killed_at))}.</span></li>`);
  if (!out.length) return p('No articles: this one is math on the prices only.');
  return `<ul class="how-srcs">${out.join('')}</ul>`;
}

function mathStep(r: WidgetResult | null) {
  if (!r || !r.numbers.length) return p('The chance is the price: a YES at 61¢ that pays $1 means about a 61% chance.');
  const rows = r.numbers.map((n: Num) => `<li><span>${esc(OP[n.op] ?? n.op.replace(/_/g, ' '))}</span><b class="num">${esc(fmtNum(n))}</b></li>`).join('');
  const v = r.receipts[0]?.engine_version;
  return `<ul class="how-math">${rows}</ul>` + p(`Worked out by our math engine${v ? ` (version ${v})` : ''}, never by the AI. The same prices always give the same answer.`);
}

function checkStep(r: WidgetResult | null, trace: RunTraceStep[]) {
  if (!r) return p('Prices go straight from the exchange to your board. Nothing is added.');
  const g = trace.filter((s) => s.step === 'guard' || s.step === 'publish').at(-1);
  return p(`Checked before it reached you${g ? ` at ${fmtTime(g.at)}` : ''}: every number came from the math, and nothing tells you what to trade.`);
}

const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd class="mono">${esc(v)}</dd></div>`;
function detailsHTML(r: WidgetResult | null, trace: RunTraceStep[]) {
  if (!r) return `<dl class="how-kv">${kv('result', 'none yet (first paint from cached quotes)')}</dl>`;
  const rec = (x: Receipt) =>
    `<dl class="how-kv">${kv('receipt', x.id)}${kv('op', `${x.op} (${x.op_id})`)}${kv('formula', x.formula)}${kv('args', JSON.stringify(x.args))}${kv('value', `${x.value} ${x.unit}`)}` +
    `${kv('engine', `${x.engine_version} · ${x.git_hash}`)}${kv('plan hash', x.plan_hash)}${kv('input hash', x.input_hash)}</dl>`;
  const steps = trace
    .map((s) => `<li class="mono">${esc(fmtTime(s.at))} ${esc(s.step)} ${esc(s.status)}${s.sandbox ? ` · ${esc(s.sandbox.sandbox_id)} ${esc(s.sandbox.state)}` : ''}${s.proxy ? ` · proxy ${s.proxy.allowed}/${s.proxy.refused}` : ''}</li>`)
    .join('');
  return (
    `<dl class="how-kv">${kv('run', r.run_id)}${kv('result', r.result_id)}${kv('verdict', r.verdict_id)}${kv('as of', r.as_of)}</dl>` +
    r.receipts.map(rec).join('') +
    (steps ? `<ol class="how-trace">${steps}</ol>` : '')
  );
}

function howHTML(w: Widget, trace: RunTraceStep[]) {
  const r = w.result;
  let i = 2;
  return (
    `<div class="sh-head${rz(0)}><h2>How we got this</h2>${closeBtn(0)}</div><p class="sh-sub${rz(1)}>${esc(tileName(w))}${r ? `, updated ${esc(fmtTime(r.created_at))}` : ''}</p>` +
    step(1, 'Where the prices came from', pricesStep(w, r), i++) +
    step(2, 'What we read', articlesStep(r, trace), i++) +
    step(3, 'The math', mathStep(r), i++) +
    step(4, 'The safety check', checkStep(r, trace), i++) +
    `<button class="btn how-toggle${rz(i)} type="button" id="how-toggle" aria-expanded="false" aria-controls="how-details">Details</button>` +
    `<div class="how-details" id="how-details" hidden>${detailsHTML(r, trace)}</div>`
  );
}

/** "How we got this" for one widget: from the ⋯ menu, or from tapping one of its numbers. */
export async function openHow(id: string) {
  const w = S.widgets.get(id);
  if (!w || w.spec.kind !== 'display') return;
  // The trace adds times and reads; the sheet doesn't wait long for it.
  const trace = w.result ? await Promise.race([api.trace(id).then((t) => t.steps).catch(() => []), wait(800).then(() => [] as RunTraceStep[])]) : [];
  const cur = S.widgets.get(id);
  if (!cur) return toast('That widget is gone.');
  panel('sheet sheet--how', howHTML(cur, trace), {
    w: 520,
    from: tileFrom(id),
    fromFn: () => tileFrom(id),
    after: (s) => {
      const b = s.querySelector<HTMLButtonElement>('#how-toggle')!;
      const d = s.querySelector<HTMLElement>('#how-details')!;
      b.addEventListener('click', () => {
        const on = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(on));
        b.textContent = on ? 'Hide details' : 'Details';
        d.hidden = !on;
        if (on) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    },
  });
}
