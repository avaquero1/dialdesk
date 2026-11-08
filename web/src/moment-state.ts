/**
 * The words and the run's view for "safety you can see" (moment.ts draws them). Pure: no DOM, unit tested in
 * web/test/unit/moment.test.ts. Words come from step names, statuses and counts only, never from a page or a note's text
 * (the planner's note gives only its number of sources).
 */
import type { RunTraceStep, WidgetSince } from '@app/contracts';

/** The two counts the chip reads from audit's trust page (TrustCounts; tricks are boxes killed, as the Safety sheet counts them). */
export interface ChipCounts {
  /** browse boxes only (audit): the math step's compute boxes are not articles. */
  articles_read: number;
  sandboxes_killed: number;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export const BLOCKED_LINE = 'Blocked: this page tried to trick the agent. Its sealed box was destroyed.';
export const BUSY_LINE = 'Lots of research going on. Yours is next.';

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The chip: "128 articles read safely today · 1 trick blocked" (tricks only when there were some). */
export function chipWords(c: ChipCounts | null): { long: string; short: string } {
  if (!c) return { long: 'Every article read in a sealed box', short: 'Sealed boxes' };
  const read = c.articles_read;
  const tricks = c.sandboxes_killed;
  const long = read ? `${plural(read, 'article', 'articles')} read safely today` : 'No articles read yet today';
  const n = read.toLocaleString('en-US');
  // A phone's top bar has room for about 15 letters: there, a blocked trick is the news (the full line is the label).
  if (!tricks) return { long, short: read ? `${n} read safely` : 'Sealed boxes' };
  return { long: `${long} · ${plural(tricks, 'trick', 'tricks')} blocked`, short: `${plural(tricks, 'trick', 'tricks')} blocked` };
}

export type BoxState = 'sealed' | 'reading' | 'done' | 'destroyed' | 'failed';
export interface RunView {
  run_id: string;
  kind: 'numbers' | 'research' | 'publish' | string;
  phase: 'start' | 'reading' | 'math' | 'check' | 'busy' | 'failed';
  /** articles to read (from the plan step), null until the plan is made */
  total: number | null;
  boxes: { id: string; state: BoxState }[];
  blocked: boolean;
  failed: string | null;
}

export const newRun = (run_id: string, kind: string): RunView => ({ run_id, kind, phase: 'start', total: null, boxes: [], blocked: false, failed: null });

/** The planner's own count, from its note's tail ("…; 3 source(s)"). Only a number is read, never words. */
const sourcesOf = (note: string | null) => {
  const m = /(\d+) source\(s\)$/.exec(note ?? '');
  return m ? Number(m[1]) : null;
};

/** One run.step folded into the run's view. */
export function stepRun(r: RunView, s: RunTraceStep): RunView {
  const v: RunView = { ...r, boxes: r.boxes.map((b) => ({ ...b })) };
  const box = (id: string) => {
    let b = v.boxes.find((x) => x.id === id);
    if (!b) {
      b = { id, state: 'sealed' };
      v.boxes.push(b);
    }
    return b;
  };
  switch (s.step) {
    case 'plan':
      v.total = sourcesOf(s.note);
      if (v.total) {
        v.phase = 'reading';
        // The boxes are drawn now, sealed; each one gets its source when its read step arrives.
        for (let i = v.boxes.length; i < Math.min(v.total, 8); i++) v.boxes.push({ id: `#${i}`, state: 'sealed' });
      }
      break;
    case 'read': {
      v.phase = v.phase === 'start' ? 'reading' : v.phase;
      // A box is its sealed box (the extract step names only that), else its source.
      const id = s.sandbox?.sandbox_id ?? s.source?.candidate_id ?? `#${v.boxes.length}`;
      // Give this source the first sealed placeholder, so the boxes keep their places.
      const ph = v.boxes.find((b) => b.id.startsWith('#') && b.state === 'sealed');
      if (ph && !v.boxes.some((b) => b.id === id)) ph.id = id;
      const b = box(id);
      b.state = s.status === 'poisoned' ? 'destroyed' : s.status === 'ok' ? 'reading' : s.status === 'failed' ? 'failed' : b.state;
      if (s.status === 'poisoned') v.blocked = true;
      break;
    }
    case 'extract': {
      const id = s.sandbox?.sandbox_id ?? s.source?.candidate_id;
      const b = (id ? v.boxes.find((x) => x.id === id) : undefined) ?? v.boxes.find((x) => x.state === 'reading');
      if (s.status === 'poisoned') {
        v.blocked = true;
        if (b) b.state = 'destroyed';
        else v.boxes.push({ id: `x${v.boxes.length}`, state: 'destroyed' });
      } else if (b) b.state = s.status === 'ok' ? 'done' : 'failed';
      break;
    }
    case 'math':
      if (s.status === 'started' || s.status === 'ok' || s.status === 'skipped') v.phase = 'math';
      break;
    case 'guard':
    case 'summary':
    case 'publish':
      v.phase = 'check';
      break;
    default:
      break;
  }
  return v;
}

/** The run's line. Red (tone 'blocked') only when a page tried a trick, or for a real error. */
export function runLine(r: RunView): { text: string; tone: 'calm' | 'blocked' | 'error' } {
  if (r.blocked) return { text: BLOCKED_LINE, tone: 'blocked' };
  if (r.phase === 'busy') return { text: BUSY_LINE, tone: 'calm' };
  if (r.phase === 'failed') return { text: r.failed ?? 'This update didn’t finish. Showing the last numbers.', tone: 'error' };
  if (r.kind === 'numbers') return { text: r.phase === 'check' ? 'Checking the numbers…' : 'Getting fresh prices…', tone: 'calm' };
  if (r.phase === 'reading' && r.total) return { text: `Reading ${r.total === 1 ? '1 article in a sealed box' : `${r.total} articles in sealed boxes`}…`, tone: 'calm' };
  if (r.phase === 'math') return { text: 'Doing the math…', tone: 'calm' };
  if (r.phase === 'check') return { text: 'Checking it over…', tone: 'calm' };
  return { text: 'Finding articles to read…', tone: 'calm' };
}

/** run.failed's reason in plain words (design.md section 11). `at` is the last clean numbers' time. */
export function failedWords(reason: string, at: string | null): { text: string; tone: 'calm' | 'error' } {
  const since = at ? ` from ${fmtTime(at)}` : '';
  switch (reason) {
    case 'busy':
      return { text: BUSY_LINE, tone: 'calm' };
    case 'exchange_down':
      return { text: `An exchange isn’t answering. Showing the last prices${since}.`, tone: 'calm' };
    case 'guard_block':
      return { text: `This update didn’t pass the safety check. Showing the last numbers${since}.`, tone: 'error' };
    default:
      return { text: `This update didn’t finish. Showing the last numbers${since}.`, tone: 'error' };
  }
}

/**
 * "Since you last looked", from board (Widget.since): the engine's move of the main chance since the owner's previous
 * visit, on any device, else how many items are new. null when nothing changed.
 */
export function sinceWords(s: WidgetSince | null | undefined): string | null {
  if (!s) return null;
  // The first move is the first chance's: a gap op in points, with its receipt (both prices, both times).
  const n = s.numbers[0];
  const d = n ? Math.round(n.value) : 0;
  if (d) return `Since you last looked: ${d > 0 ? 'up' : 'down'} ${plural(Math.abs(d), 'point', 'points')}`;
  if (s.new_items) return `Since you last looked: ${plural(s.new_items, 'new item', 'new items')}`;
  return null;
}
