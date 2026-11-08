/**
 * Safety you can see (design.md section 10): the safety chip's counts, the live line a research run shows on its
 * widget, the sealed box destroyed on screen when a page tries a trick, and the "since you last looked" strip.
 *
 * The line lives beside the tile's `.w-in`, so a re-render of the numbers never cuts its motion. The run's words come
 * only from run.step's step names and statuses; a page's text, a note's text or a URL never reaches the screen.
 * The widget keeps its last clean numbers: the board's result is the only source of numbers here, and nothing in
 * this file writes one.
 */
import type { EventName, RunTraceStep, Widget } from '@app/contracts';
import { $, esc, mk, reduced, setHtml } from './dom.ts';
import { api } from './api.ts';
import { IC } from './icons.ts';
import { BLOCKED_LINE, chipWords, failedWords, newRun, runLine, sinceWords, stepRun, type RunView } from './moment-state.ts';

// ---------- the screen ----------

interface Hooks {
  tile: (id: string) => HTMLElement | undefined;
  widget: (id: string) => Widget | undefined;
  widgets: () => Iterable<Widget>;
  openSafety: () => void;
}
let H: Hooks;
const runs = new Map<string, RunView>();
const failed = new Map<string, { text: string; tone: 'calm' | 'error'; until: number }>();
const endT = new Map<string, number>();
/** What the tile's line says now: a run, then a recent failure, then a kept block, then what changed. */
function restLine(w: Widget): { text: string; tone: 'calm' | 'blocked' | 'error' | 'since' } | null {
  const id = w.spec.widget_id;
  const r = runs.get(id);
  if (r) return runLine(r);
  const f = failed.get(id);
  if (f && f.until > Date.now()) return f;
  // News lists its blocked page among its items (widgets.ts); the other displays say it here.
  if (w.result?.blocked.length && !(w.spec.kind === 'display' && w.spec.type === 'news')) return { text: BLOCKED_LINE, tone: 'blocked' };
  // What changed since the owner's previous visit: board keeps the visits, the engine measured the move.
  const t = sinceWords(w.since);
  return t ? { text: t, tone: 'since' } : null;
}

function boxesHtml(r: RunView | undefined) {
  if (!r || !r.boxes.length) return '';
  return r.boxes.map((b) => `<i class="wl-box is-${b.state}" data-box="${esc(b.id)}"></i>`).join('');
}

/** Draw one tile's line. Boxes keep their elements across steps, so a destroyed box plays its one move. */
function paint(id: string) {
  const el = H.tile(id);
  const w = H.widget(id);
  if (!el || !w || w.spec.kind !== 'display') return;
  const line = restLine(w);
  const r = runs.get(id);
  el.classList.toggle('is-running', !!r && r.phase !== 'busy' && r.phase !== 'failed');
  let L = el.querySelector<HTMLElement>(':scope > .w-live');
  if (!line) {
    el.classList.remove('has-live');
    if (L) L.classList.remove('on');
    return;
  }
  if (!L) {
    L = mk('div', 'w-live');
    L.setAttribute('role', 'status');
    L.setAttribute('aria-live', 'polite');
    setHtml(L, `<span class="wl-icon"></span><span class="wl-boxes" aria-hidden="true"></span><span class="wl-text"></span>`);
    el.appendChild(L);
    void L.offsetWidth;
  }
  el.classList.add('has-live');
  L.classList.add('on');
  L.dataset.tone = line.tone;
  const icon = L.querySelector<HTMLElement>('.wl-icon')!;
  const iconHtml = line.tone === 'blocked' ? IC.blocked : line.tone === 'since' ? '' : line.tone === 'error' ? IC.blocked : IC.shield;
  if (icon.dataset.k !== line.tone) {
    icon.dataset.k = line.tone;
    setHtml(icon, iconHtml);
  }
  // Boxes: add the new ones, move each to its state; a run's end leaves them to fade with the line.
  const bx = L.querySelector<HTMLElement>('.wl-boxes')!;
  if (r) {
    if (bx.dataset.run !== r.run_id) {
      bx.dataset.run = r.run_id;
      setHtml(bx, boxesHtml(r));
    } else {
      const els = Array.from(bx.children) as HTMLElement[];
      r.boxes.forEach((b, i) => {
        let e = els[i];
        if (!e) {
          e = mk('i', 'wl-box');
          bx.appendChild(e);
        }
        e.dataset.box = b.id;
        e.className = `wl-box is-${b.state}`;
      });
    }
  } else if (bx.dataset.run) {
    // The run is over: its boxes fade, then go (nothing cuts).
    delete bx.dataset.run;
    bx.classList.add('is-gone');
    setTimeout(() => {
      if (bx.dataset.run) return;
      setHtml(bx, '');
      bx.classList.remove('is-gone');
    }, 420);
  }
  if (r) bx.classList.remove('is-gone');
  const tx = L.querySelector<HTMLElement>('.wl-text')!;
  if (tx.textContent !== line.text) {
    if (!tx.textContent || reduced()) tx.textContent = line.text;
    else {
      // The words cross-fade (opacity only); the box's move leads, the words follow.
      tx.classList.add('is-swapping');
      setTimeout(() => {
        tx.textContent = line.text;
        tx.classList.remove('is-swapping');
      }, 180);
    }
  }
}

export function paintAll() {
  for (const w of H.widgets()) paint(w.spec.widget_id);
}

/** A run ends: its line goes once the board has the result (or after a while, if nothing comes). */
function endRun(id: string, ms: number) {
  clearTimeout(endT.get(id));
  endT.set(
    id,
    window.setTimeout(() => {
      runs.delete(id);
      paint(id);
    }, ms),
  );
}

// ---------- the chip ----------

const chipT: number[] = [];
async function loadChip() {
  const t = await api.trustQuiet().catch(() => null);
  if (!t) return;
  const w = chipWords(t.counts);
  const chip = $('#safety-chip');
  if (!chip) return;
  const long = chip.querySelector('.long')!;
  const short = chip.querySelector('.short')!;
  if (long.textContent !== w.long) {
    long.textContent = w.long;
    short.textContent = w.short;
    chip.classList.remove('is-new');
    void chip.offsetWidth;
    chip.classList.add('is-new');
  }
  chip.setAttribute('aria-label', `Safety: ${w.long}`);
  chip.dataset.read = String(t.counts.articles_read);
  chip.dataset.tricks = String(t.counts.sandboxes_killed);
}
/** audit counts the log on its own clock: ask now-ish, and once more a little later. */
export function chipSoon() {
  chipT.splice(0).forEach((t) => clearTimeout(t));
  for (const ms of [700, 3500, 8000]) chipT.push(window.setTimeout(() => void loadChip(), ms));
}

// ---------- events ----------

export function onRunEvent(event: EventName, p: Record<string, unknown>) {
  const wid = typeof p.widget_id === 'string' ? p.widget_id : null;
  switch (event) {
    case 'run.started': {
      if (!wid) return;
      clearTimeout(endT.get(wid));
      failed.delete(wid);
      runs.set(wid, newRun(String(p.run_id ?? ''), String(p.kind ?? 'research')));
      endRun(wid, 120_000); // a run that never reports back stops shimmering
      paint(wid);
      break;
    }
    case 'run.step': {
      const s = p.step as RunTraceStep | undefined;
      if (!s || typeof s.widget_id !== 'string') return;
      const r = runs.get(s.widget_id) ?? newRun(s.run_id, 'research');
      if (r.run_id && r.run_id !== s.run_id) return; // an older run's late step
      runs.set(s.widget_id, stepRun({ ...r, run_id: s.run_id }, s));
      paint(s.widget_id);
      if (s.sandbox && (s.sandbox.state === 'killed' || s.sandbox.state === 'destroyed' || s.sandbox.state === 'released')) chipSoon();
      break;
    }
    case 'run.poisoned': {
      if (!wid) return;
      const r = runs.get(wid) ?? newRun(String(p.run_id ?? ''), 'research');
      if (!r.blocked) {
        const b = r.boxes.find((x) => x.state === 'reading' || x.state === 'sealed');
        runs.set(wid, { ...r, blocked: true, boxes: b ? r.boxes.map((x) => (x === b ? { ...x, state: 'destroyed' } : x)) : [...r.boxes, { id: 'x', state: 'destroyed' }] });
      }
      paint(wid);
      chipSoon();
      break;
    }
    case 'run.failed': {
      if (!wid) return;
      const reason = String(p.reason ?? 'internal');
      const r = runs.get(wid);
      const w = H.widget(wid);
      const f = failedWords(reason, w?.result?.as_of ?? null);
      if (reason === 'busy' && r) {
        runs.set(wid, { ...r, phase: 'busy' });
        endRun(wid, 120_000);
      } else {
        runs.delete(wid);
        failed.set(wid, { ...f, until: Date.now() + 9000 });
        setTimeout(() => paint(wid), 9100);
      }
      paint(wid);
      chipSoon();
      break;
    }
    case 'result.updated': {
      if (!wid) return;
      const r = runs.get(wid);
      // A research run lands in two phases; its line stays until the summary.
      if (r && (p.phase === 'summary' || r.kind === 'numbers')) endRun(wid, 900);
      chipSoon();
      break;
    }
    default:
      break;
  }
}

export function initMoment(h: Hooks) {
  H = h;
  const chip = $('#safety-chip');
  chip?.addEventListener('click', () => H.openSafety());
  void loadChip();
  paintAll();
}
