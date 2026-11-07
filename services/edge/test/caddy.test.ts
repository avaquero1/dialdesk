/** The Caddyfile's promises, checked as text so a later edit can't quietly drop one. `caddy adapt --validate` passes on it too. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const file = readFileSync(new URL('../../../deploy/Caddyfile', import.meta.url), 'utf8');
const live = file
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');
const csp = /Content-Security-Policy "([^"]+)"/.exec(live)?.[1] ?? '';
const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

describe('deploy/Caddyfile', () => {
  it('listens on 443 only: no http site, no redirect, no HTTP-01, no HTTP/3, no admin API', () => {
    expect(live).toMatch(/^https:\/\/vultrcontest\.vaquerothe\.dev \{/m);
    expect(live).not.toMatch(/^(http:\/\/|:80|.*:80\b)/m);
    expect(live).toContain('auto_https disable_redirects');
    expect(live).toContain('disable_http_challenge');
    expect(live).toMatch(/protocols h1 h2\n/);
    expect(live).toContain('admin off');
  });

  it('sets a CSP that allows no inline script, no eval and no framing', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('default-src')).toBe("default-src 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic|\*/);
    expect(live).toContain('Strict-Transport-Security');
  });

  it('sends only /api/* and /live to edge, and caps API bodies', () => {
    const proxied = [...live.matchAll(/handle (\S+) \{\n(?:[^}]*\{[^}]*\}\n)*\s*reverse_proxy edge:8080/g)].map((m) => m[1]);
    expect(proxied).toEqual(['/api/*', '/live']);
    expect(live.match(/reverse_proxy/g)).toHaveLength(2);
    expect(live).toMatch(/max_size 64KB/);
  });
});
