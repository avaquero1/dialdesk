/** The demo cap on a board's widgets (accept answers 409 board_full past it). */
import { describe, expect, it } from 'vitest';
import { MAX_WIDGETS, REFRESH_PER_ACCOUNT_HOUR, REFRESH_PER_HOUR, checkRefresh, checkWidgetCap } from '../src/logic.ts';

describe('board: the widget cap', () => {
  it('lets a board fill up to MAX_WIDGETS and refuses one more', () => {
    expect(() => checkWidgetCap(MAX_WIDGETS - 2, 2)).not.toThrow();
    expect(() => checkWidgetCap(MAX_WIDGETS - 1, 2)).toThrow(expect.objectContaining({ status: 409, code: 'board_full' }));
    // A proposal that only tunes or removes is never refused, even on a full board.
    expect(() => checkWidgetCap(MAX_WIDGETS + 5, 0)).not.toThrow();
  });
});

describe('board: the refresh limits (A1.4.2)', () => {
  it('60 manual refreshes an hour per account, 12 per widget; the account cap answers first', () => {
    expect(REFRESH_PER_ACCOUNT_HOUR).toBe(60);
    expect(() => checkRefresh(REFRESH_PER_HOUR - 1, REFRESH_PER_ACCOUNT_HOUR - 1)).not.toThrow();
    expect(() => checkRefresh(0, REFRESH_PER_ACCOUNT_HOUR)).toThrow(expect.objectContaining({ status: 429, code: 'refresh_cap' }));
    expect(() => checkRefresh(REFRESH_PER_HOUR, 0)).toThrow(expect.objectContaining({ status: 429, code: 'too_many_refreshes' }));
    expect(() => checkRefresh(REFRESH_PER_HOUR, REFRESH_PER_ACCOUNT_HOUR)).toThrow(expect.objectContaining({ code: 'refresh_cap' }));
  });
});
