/**
 * Undo for Remove and Clear all: the change shows at once on the board, but the call to edge waits until the Undo
 * offer ends. Undo inside that time puts the tile back and nothing is sent. One offer at a time: a new one sends
 * the previous change first. Leaving the page (or hiding it, on a phone) sends what is waiting, with keepalive.
 */
export interface Change {
  /** What the toast says, e.g. "Removed Tonight". */
  text: string;
  /** Show the change on the board now (hide the tile, mark it). */
  apply: () => void;
  /** Take it back (Undo, or the call failed). */
  revert: () => void;
  /** Send it to edge. keepalive: the page is going away. */
  commit: (o: { keepalive: boolean }) => Promise<void>;
}

export interface UndoView {
  show: (text: string, ms: number) => void;
  hide: () => void;
}

interface Timers {
  set: (fn: () => void, ms: number) => number;
  clear: (t: number) => void;
}

export const UNDO_MS = 5000;

export class Undo {
  private cur: { c: Change; t: number } | null = null;

  constructor(
    private readonly view: UndoView,
    private readonly ms = UNDO_MS,
    private readonly timers: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => window.clearTimeout(t) },
    private readonly onError: (c: Change, e: unknown) => void = () => {},
  ) {}

  get waiting(): boolean {
    return !!this.cur;
  }

  /** Apply a change now and offer Undo for it. */
  offer(c: Change): void {
    this.send(false);
    c.apply();
    this.cur = { c, t: this.timers.set(() => this.send(false), this.ms) };
    this.view.show(c.text, this.ms);
  }

  /** Take the waiting change back. False when nothing is waiting (the offer already ended). */
  undo(): boolean {
    const cur = this.cur;
    if (!cur) return false;
    this.cur = null;
    this.timers.clear(cur.t);
    this.view.hide();
    cur.c.revert();
    return true;
  }

  /** Send the waiting change now. keepalive when the page is going away. */
  send(keepalive: boolean): Promise<void> {
    const cur = this.cur;
    if (!cur) return Promise.resolve();
    this.cur = null;
    this.timers.clear(cur.t);
    this.view.hide();
    return cur.c.commit({ keepalive }).catch((e: unknown) => {
      cur.c.revert();
      this.onError(cur.c, e);
    });
  }
}
