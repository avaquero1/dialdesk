import { describe, expect, it } from 'vitest';
import type { Candidate } from '@app/contracts';
import { keepCandidate } from '../src/run.ts';

const page = { candidate_id: 'cnd_1', url: 'https://testpage.example.invalid/n.html', domain: 'testpage.example.invalid', published_at: null, via: 'search', source_id: null, allowed: true, title_for_user: null } as Candidate;
const base = { catalog: new Set(['espn.com']), added: new Set<string>(), sourceEnv: 'prod' as const };

describe("runner's re-check of the test page", () => {
  it('drops a non-catalog page by default', () => {
    expect(keepCandidate(page, base)).toBe(false);
    expect(keepCandidate(page, { ...base, testPageDomain: '' })).toBe(false);
  });
  it('keeps only the set test page domain', () => {
    expect(keepCandidate(page, { ...base, testPageDomain: 'testpage.example.invalid' })).toBe(true);
    expect(keepCandidate({ ...page, url: 'https://evil.example.invalid/x', domain: 'evil.example.invalid' }, { ...base, testPageDomain: 'testpage.example.invalid' })).toBe(false);
  });
});
