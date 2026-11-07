/**
 * /live: edge pushes this account's bus events. Events are hints, not truth: the app refetches what changed, and
 * after any reconnect it refetches the board. Close 4001 means the session ended or expired: the app asks /api/me
 * again (a 401 there shows the sign-in screen). The socket never sends anything.
 */
import type { EventName } from '@app/contracts';

export const SESSION_ENDED = 4001;

export interface LiveHandlers {
  onEvent: (event: EventName, payload: Record<string, unknown>) => void;
  /** Opened again after a drop: refetch, since events may have been missed. */
  onReconnect: () => void;
  /** Close 4001. */
  onSessionEnded: () => void;
  onState?: (s: 'open' | 'closed') => void;
}

export class Live {
  private ws: WebSocket | null = null;
  private tries = 0;
  private timer = 0;
  private stopped = false;
  private opened = false;

  constructor(private h: LiveHandlers) {}

  start() {
    this.stopped = false;
    this.connect();
    addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.kick);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.kick);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Back online or visible again: reconnect now instead of waiting out the backoff. */
  private kick = () => {
    if (this.stopped || document.visibilityState === 'hidden' || this.ws) return;
    clearTimeout(this.timer);
    this.connect();
  };

  private connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      const again = this.opened;
      this.opened = true;
      this.tries = 0;
      this.h.onState?.('open');
      if (again) this.h.onReconnect();
    };
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') return;
      try {
        const f = JSON.parse(m.data) as { event?: unknown; payload?: unknown };
        if (typeof f.event === 'string' && f.payload && typeof f.payload === 'object') this.h.onEvent(f.event as EventName, f.payload as Record<string, unknown>);
      } catch {
        /* not a frame we know: ignore */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.h.onState?.('closed');
      if (this.stopped) return;
      if (e.code === SESSION_ENDED) {
        this.h.onSessionEnded();
        return;
      }
      // Backoff with jitter: 1 s, 2 s, 4 s … up to 30 s.
      const ms = Math.min(30_000, 1000 * 2 ** Math.min(this.tries++, 5)) * (0.75 + Math.random() * 0.5);
      this.timer = window.setTimeout(() => this.connect(), ms);
    };
  }
}
