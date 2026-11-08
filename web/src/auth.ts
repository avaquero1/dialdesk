/**
 * The door: sign up, log in, or try it as a guest. One glass panel over the moving wallpaper. Errors from edge are
 * shown in words; 429 and 413 get the same notice as everywhere else.
 */
import type { Account } from '@app/contracts';
import { $, setHtml } from './dom.ts';
import { ApiError, api, noticeFor } from './api.ts';

type Mode = 'signup' | 'login';

const MESSAGES: Record<string, string> = {
  '409': 'That email already has an account. Log in instead.',
  '401': 'That email and password don’t match.',
  '400': 'Check the email, and use a password of at least 10 characters.',
};

export function showAuth(onIn: (a: Account) => void) {
  const host = $('#auth');
  let mode: Mode = 'signup';
  let busy = false;
  document.documentElement.dataset.view = 'auth';

  const render = () => {
    setHtml(
      host,
      `<div class="auth-card">
        <h1 class="auth-title">My board</h1>
        <p class="auth-sub">Research for trading prediction markets. Live prices, articles read in sealed boxes, and the math shown.</p>
        <div class="seg auth-tabs" role="tablist" aria-label="Sign up or log in">
          <button type="button" role="tab" data-mode="signup" aria-pressed="${mode === 'signup'}">Sign up</button>
          <button type="button" role="tab" data-mode="login" aria-pressed="${mode === 'login'}">Log in</button>
        </div>
        <form class="auth-form" id="auth-form" autocomplete="on" novalidate>
          <label><span>Email</span><input name="email" type="email" autocomplete="email" required maxlength="254" spellcheck="false"></label>
          <label><span>Password</span><input name="password" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required minlength="10" maxlength="200"></label>
          <p class="auth-err" id="auth-err" role="alert"></p>
          <button class="btn btn--accent auth-go" type="submit">${mode === 'signup' ? 'Create my board' : 'Log in'}</button>
        </form>
        <div class="auth-or"><span>or</span></div>
        <button class="btn auth-guest" type="button" id="auth-guest">Try it as a guest</button>
        <p class="auth-fine">A guest board is deleted after a while. Math from public data. Not investment advice.</p>
      </div>`,
    );
    for (const b of host.querySelectorAll<HTMLElement>('[data-mode]'))
      b.addEventListener('click', () => {
        mode = b.dataset.mode as Mode;
        render();
      });
    $('#auth-form', host).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const email = (f.elements.namedItem('email') as HTMLInputElement).value.trim();
      const password = (f.elements.namedItem('password') as HTMLInputElement).value;
      if (!email || password.length < 10) return err(MESSAGES['400']!);
      void go(() => (mode === 'signup' ? api.signup(email, password) : api.login(email, password)));
    });
    $('#auth-guest', host).addEventListener('click', () => void go(() => api.guest()));
  };

  const err = (t: string) => {
    $('#auth-err', host).textContent = t;
  };

  async function go(fn: () => Promise<{ account: Account }>) {
    if (busy) return;
    busy = true;
    host.classList.add('is-busy');
    err('');
    try {
      const { account } = await fn();
      host.classList.add('is-leaving');
      setTimeout(() => {
        host.replaceChildren();
        host.classList.remove('is-leaving', 'is-busy');
      }, 420);
      onIn(account);
    } catch (e) {
      const a = e instanceof ApiError ? e : new ApiError(0, 'error', 'failed');
      err(noticeFor(a) ?? MESSAGES[String(a.status)] ?? `Something went wrong (${a.status}). Try again.`);
      host.classList.remove('is-busy');
    } finally {
      busy = false;
    }
  }

  render();
}
