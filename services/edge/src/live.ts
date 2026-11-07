import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { BrowserEvent, EVENTS, LIVE_PATH } from '@app/contracts';
import type { Logger } from '@app/service-kit';
import type { EventFeed } from './feed.ts';

export interface LiveSession {
  accountId: string;
  sessionId: string;
  /** Unix seconds: the socket closes then. */
  exp: number;
}

export interface LiveOptions {
  /** Exact Origin values allowed to open the socket (scheme://host[:port]). A missing Origin is refused. */
  origins: ReadonlySet<string>;
  /** The same session check as the HTTP routes, from the Cookie header. */
  authenticate: (cookieHeader: string | undefined) => Promise<LiveSession | null>;
  /** Asked every `recheckMs`: false closes the socket (logout, guest sweep). */
  stillValid: (s: LiveSession) => Promise<boolean>;
  feed: EventFeed;
  log: Logger;
  /** Per-address handshake limit; false answers 429. */
  allow?: (req: IncomingMessage) => boolean;
  maxPerAccount?: number;
  maxTotal?: number;
  recheckMs?: number;
  heartbeatMs?: number;
  clock?: () => number;
}

/** Close codes the browser sees. 4001: the session ended or expired; it should refetch /api/me. */
export const CLOSE = { sessionEnded: 4001, policy: 1008, tooSlow: 1013 } as const;
const MAX_BUFFERED = 1 << 20;

/**
 * /live: pushes bus events to the browser. The handshake is refused unless the path is /live, the method GET, the
 * Origin one of `origins`, and the session cookie valid. A socket carries only its own account's events, and it
 * never takes input: frames from the browser are ignored, and one over 1 KiB closes it.
 */
export function attachLive(server: Server, o: LiveOptions) {
  const clock = o.clock ?? Date.now;
  const maxPerAccount = o.maxPerAccount ?? 5;
  const maxTotal = o.maxTotal ?? 5000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, clientTracking: false });
  const byAccount = new Map<string, Set<WebSocket>>();
  const sessionOf = new WeakMap<WebSocket, LiveSession>();
  let total = 0;
  let pending = 0;

  const refuse = (socket: Duplex, status: number) => {
    if (socket.writable) socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => socket.destroy());
    const path = (req.url ?? '').split('?')[0];
    if (path !== LIVE_PATH) return refuse(socket, 404);
    if (req.method !== 'GET') return refuse(socket, 405);
    const origin = req.headers.origin;
    if (!origin || !o.origins.has(origin)) {
      o.log.warn({ live: 'refused', reason: 'origin' }, 'live handshake refused');
      return refuse(socket, 403);
    }
    if (o.allow && !o.allow(req)) return refuse(socket, 429);
    let s: LiveSession | null;
    try {
      s = await o.authenticate(req.headers.cookie);
    } catch {
      return refuse(socket, 503);
    }
    if (!s) return refuse(socket, 401);
    if ((byAccount.get(s.accountId)?.size ?? 0) >= maxPerAccount) return refuse(socket, 429);
    if (total + pending >= maxTotal) return refuse(socket, 503);
    pending++;
    wss.handleUpgrade(req, socket, head, (ws) => {
      pending--;
      open(ws, s);
    });
  }

  function open(ws: WebSocket, s: LiveSession) {
    total++;
    sessionOf.set(ws, s);
    const set = byAccount.get(s.accountId) ?? new Set<WebSocket>();
    set.add(ws);
    byAccount.set(s.accountId, set);
    let alive = true;
    const expiry = setTimeout(() => ws.close(CLOSE.sessionEnded, 'session expired'), Math.max(0, s.exp * 1000 - clock()));
    const recheck = setInterval(() => {
      o.stillValid(s).then(
        (ok) => void (ok || ws.close(CLOSE.sessionEnded, 'session ended')),
        () => {},
      );
    }, o.recheckMs ?? 60_000);
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, o.heartbeatMs ?? 30_000);
    ws.on('pong', () => (alive = true));
    ws.on('message', () => {}); // the socket takes no input
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(expiry);
      clearInterval(recheck);
      clearInterval(beat);
      total--;
      set.delete(ws);
      if (!set.size) byAccount.delete(s.accountId);
    });
  }

  const unsubscribe = o.feed.subscribe((event, payload) => {
    const parsed = EVENTS[event]?.schema.safeParse(payload);
    if (!parsed?.success) return void o.log.warn({ event }, 'live: dropped an event that fails its schema');
    const data = parsed.data as { account_id: string };
    const sockets = byAccount.get(data.account_id);
    if (!sockets) return;
    const frame = JSON.stringify(BrowserEvent.parse({ event, payload: data }));
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED) ws.close(CLOSE.tooSlow, 'too slow');
      else ws.send(frame);
    }
  });

  const handler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void onUpgrade(req, socket, head);
  server.on('upgrade', handler);

  return {
    /** Sockets open now (for /health and tests). */
    count: () => total,
    /** Close every socket of one session at once (logout through this edge). */
    closeSession(sessionId: string) {
      for (const set of byAccount.values())
        for (const ws of set) if (sessionOf.get(ws)?.sessionId === sessionId) ws.close(CLOSE.sessionEnded, 'logged out');
    },
    close() {
      unsubscribe();
      server.off('upgrade', handler);
      for (const set of byAccount.values()) for (const ws of set) ws.terminate();
      wss.close();
    },
  };
}
export type Live = ReturnType<typeof attachLive>;
