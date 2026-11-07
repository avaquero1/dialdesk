/**
 * edge's browser API, same origin only. The session is the HttpOnly cookie edge sets, so this code never sees a token.
 * Every state-changing call carries the page's Origin (the browser adds it) and edge checks it.
 * Any route may answer 429 (rate limits) or 413 (body cap): both become a notice, never a crash.
 */
import type { Account, Board, ChatReply, ChatTurn, Look, Widget } from '@app/contracts';

export type { Account, Board, Look, Widget };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

export interface ApiHooks {
  /** A 401 on a call that needs a session: the session ended. */
  onSessionLost?: () => void;
  /** A 429 or a 413, or the server unreachable: a short line for the notice strip. */
  onNotice?: (text: string, kind: 'limit' | 'size' | 'offline') => void;
}

const hooks: ApiHooks = {};
export const setApiHooks = (h: ApiHooks) => Object.assign(hooks, h);

/** The words for a status edge may send on any route. */
export function noticeFor(e: ApiError): string | null {
  if (e.status === 429) return e.retryAfterS ? `Too many requests. Try again in ${e.retryAfterS} s.` : 'Too many requests. Wait a moment, then try again.';
  if (e.status === 413) return 'That was too large to send.';
  if (e.status === 0) return "Can't reach the server. Check your connection.";
  return null;
}

/** `quiet`: the caller shows its own words for 429, 413 and offline (the chat does), so no notice. */
async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, o: { auth?: boolean; keepalive?: boolean; quiet?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: o.keepalive,
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const e = new ApiError(0, 'offline', "can't reach the server");
    if (!o.quiet) hooks.onNotice?.(noticeFor(e)!, 'offline');
    throw e;
  }
  if (res.ok) return (res.status === 204 ? { ok: true } : await res.json()) as T;
  let code = 'error';
  let message = res.statusText || 'request failed';
  try {
    const j = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof j.error === 'string') code = j.error;
    if (typeof j.message === 'string') message = j.message;
  } catch {
    /* not JSON (a proxy's page): keep the status text */
  }
  const ra = Number(res.headers.get('retry-after'));
  const e = new ApiError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : null);
  if (res.status === 429 && !o.quiet) hooks.onNotice?.(noticeFor(e)!, 'limit');
  else if (res.status === 413 && !o.quiet) hooks.onNotice?.(noticeFor(e)!, 'size');
  else if (res.status === 401 && o.auth !== false) hooks.onSessionLost?.();
  throw e;
}

type Places = { widget_id: string; place: { col: number; row: number } | { folder_id: string; index: number } }[];

export const api = {
  signup: (email: string, password: string) => call<{ account: Account }>('POST', '/api/signup', { email, password }, { auth: false }),
  login: (email: string, password: string) => call<{ account: Account }>('POST', '/api/login', { email, password }, { auth: false }),
  guest: () => call<{ account: Account }>('POST', '/api/guest', {}, { auth: false }),
  logout: () => call<{ ok: true }>('POST', '/api/logout', {}, { auth: false }),
  /** auth: false, so boot can ask "is there a session?" without the session-lost path. */
  me: (o: { auth?: boolean } = {}) => call<Account>('GET', '/api/me', undefined, o),
  board: () => call<Board>('GET', '/api/board'),
  setLayout: (places: Places) => call<Board>('PUT', '/api/board/layout', { places }),
  setLook: (look: Look) => call<Look>('PUT', '/api/look', look),
  // The ⋯ menu. keepalive: an Undo offer still waiting when the page goes away is sent anyway.
  resize: (id: string, size: 'S' | 'M' | 'L' | 'XL') => call<Widget>('PATCH', `/api/widgets/${encodeURIComponent(id)}/size`, { size }),
  refresh: (id: string) => call<{ job_id: string }>('POST', `/api/widgets/${encodeURIComponent(id)}/refresh`, {}),
  clear: (id: string, o: { keepalive?: boolean } = {}) => call<Widget>('POST', `/api/widgets/${encodeURIComponent(id)}/clear`, {}, o),
  remove: (id: string, o: { keepalive?: boolean } = {}) => call<{ ok: true }>('DELETE', `/api/widgets/${encodeURIComponent(id)}`, undefined, o),
  chat: (conversation_id: string | null, message: string) =>
    call<ChatReply>('POST', '/api/chat', { conversation_id, widget_id: null, message }, { quiet: true }),
  conversation: (id: string) =>
    call<{ conversation_id: string; turns: ChatTurn[] }>('GET', `/api/chat/${encodeURIComponent(id)}`, undefined, { quiet: true }),
};
