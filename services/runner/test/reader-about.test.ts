import { describe, expect, it } from 'vitest';
import { READER_PROMPT, readerAbout } from '../src/run.ts';

describe('what the reader is told a card follows', () => {
  it('names the team and the game, and the page stays out of it', () => {
    expect(readerAbout({ title: 'Bills news', params: { team: 'Bills' } }, [{ title: 'Buffalo at Minnesota Winner?' }])).toBe('This card follows only these. Team: "Bills". Game: "Buffalo at Minnesota Winner?".');
  });

  it('falls back on the card title when no team is set, and lists a title once', () => {
    const two = [{ title: 'Buffalo at Minnesota Winner?' }, { title: 'Buffalo at Minnesota Winner?' }, { title: 'Lions at Commanders' }];
    expect(readerAbout({ title: 'Two prices', params: {} }, two)).toBe('This card follows only these. Card: "Two prices". Games: "Buffalo at Minnesota Winner?", "Lions at Commanders".');
  });

  it('keeps the report of orders aimed at an agent, whichever team the page is about', () => {
    expect(READER_PROMPT).toMatch(/aimed at an AI, assistant or agent.*whichever team the page is about/);
  });
});
