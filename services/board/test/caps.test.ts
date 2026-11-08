/** The demo cap on a board's widgets (accept answers 409 board_full past it). */
import { describe, expect, it } from 'vitest';
import { MAX_WIDGETS, checkWidgetCap } from '../src/logic.ts';

describe('board: the widget cap', () => {
  it('lets a board fill up to MAX_WIDGETS and refuses one more', () => {
    expect(() => checkWidgetCap(MAX_WIDGETS - 2, 2)).not.toThrow();
    expect(() => checkWidgetCap(MAX_WIDGETS - 1, 2)).toThrow(expect.objectContaining({ status: 409, code: 'board_full' }));
    // A proposal that only tunes or removes is never refused, even on a full board.
    expect(() => checkWidgetCap(MAX_WIDGETS + 5, 0)).not.toThrow();
  });
});
