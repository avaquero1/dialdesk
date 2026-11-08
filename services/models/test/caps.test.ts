import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from '../src/meter.ts';

describe('default caps', () => {
  it('an account gets 2M tokens a day, so the $0.25 limit binds first at today\'s prices', () => {
    expect(DEFAULT_CAPS.account_daily_tokens).toBe(2_000_000);
    expect(DEFAULT_CAPS.account_daily_usd).toBe(0.25);
    expect(DEFAULT_CAPS.daily_usd).toBe(5);
  });
});
