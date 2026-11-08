import { describe, expect, it } from 'vitest';
import { newId, type ToolChip } from '@app/contracts';
import { chipView, decide, emptyChat, fromHistory, lookChange, receive, undoLook, type Turn } from '../../src/chat-state.ts';

const at = new Date().toISOString();
const cnv = newId('cnv');
const agent = (text: string, chips: ToolChip[]): Turn => ({ turn_id: newId('trn'), role: 'agent', text, chips, verdict_id: newId('vrd'), at });
const proposal = (label: string, tool: ToolChip['tool'] = 'propose_widget'): ToolChip => ({ tool, args: {}, status: 'proposed', proposal_id: newId('prp'), label });
const look = (args: Record<string, unknown>): ToolChip => ({ tool: 'set_look', args, status: 'applied', proposal_id: null, label: 'set_look · hue 32°' });

describe('proposal chips and look changes', () => {
  it("a proposal asks first: Add 'Chiefs at Bills news'? with Add and Not now; the tap's answer replaces the buttons", () => {
    const c = proposal('Chiefs at Bills news');
    let s = receive(emptyChat(), cnv, agent('Tap to add them.', [c]));
    const line = s.lines[0]!;
    expect(chipView(s, line, c)).toEqual({ kind: 'ask', proposalId: c.proposal_id, ask: "Add 'Chiefs at Bills news'?", yes: 'Add', busy: false, failed: false });
    s = decide(s, c.proposal_id!, 'busy');
    expect(chipView(s, line, c)).toMatchObject({ kind: 'ask', busy: true });
    s = decide(s, c.proposal_id!, 'failed');
    expect(chipView(s, line, c)).toMatchObject({ kind: 'ask', busy: false, failed: true });
    expect(chipView(decide(s, c.proposal_id!, 'accepted'), line, c)).toEqual({ kind: 'said', text: "Added 'Chiefs at Bills news'." });
    expect(chipView(decide(s, c.proposal_id!, 'rejected'), line, c)).toEqual({ kind: 'said', text: 'Not now.' });
  });

  it('tune and remove proposals ask with their own word; refused chips and chips without a proposal stay labels', () => {
    const t = proposal('Tune Tonight: size', 'tune_widget');
    const r = proposal('Remove Tonight', 'remove_widget');
    const bad: ToolChip = { ...proposal('Bad'), status: 'refused', proposal_id: null };
    const s = receive(emptyChat(), cnv, agent('Tap to change it.', [t, r, bad]));
    const line = s.lines[0]!;
    expect(chipView(s, line, t)).toMatchObject({ kind: 'ask', ask: 'Tune Tonight: size?', yes: 'Change' });
    expect(chipView(s, line, r)).toMatchObject({ kind: 'ask', ask: 'Remove Tonight?', yes: 'Remove' });
    expect(chipView(s, line, bad)).toEqual({ kind: 'label', label: 'Bad', status: 'refused' });
  });

  it('history: a proposal the board no longer holds as pending shows without buttons; a pending one still asks', () => {
    const old = proposal('Old news');
    const open = proposal('Open news');
    const s = fromHistory(cnv, [agent('Tap to add them.', [old, open])], new Set([open.proposal_id!]));
    const line = s.lines[0]!;
    expect(chipView(s, line, old)).toEqual({ kind: 'label', label: 'Old news', status: 'proposed' });
    expect(chipView(s, line, open)).toMatchObject({ kind: 'ask' });
    // Without the board's pending list, nothing is assumed.
    expect(chipView(fromHistory(cnv, [agent('x', [old])]), line, old)).toMatchObject({ kind: 'ask' });
  });

  it('a live look change: applied now, [Undo] on the latest one only; Undo takes it back once', () => {
    const t1 = agent('Done: warmer glass.', [look({ hue: 32 })]);
    expect(lookChange(t1)).toEqual({ hue: 32 });
    let s = receive(emptyChat(), cnv, t1);
    const l1 = s.lines[0]!;
    expect(chipView(s, l1, t1.chips[0]!)).toEqual({ kind: 'look', text: 'set_look · hue 32°', undo: true });
    const t2 = agent('Done: cooler glass.', [look({ hue: 210 })]);
    s = receive(s, cnv, t2);
    const l2 = s.lines[1]!;
    expect(chipView(s, l1, t1.chips[0]!)).toMatchObject({ undo: false });
    expect(chipView(s, l2, t2.chips[0]!)).toMatchObject({ undo: true });
    s = undoLook(s);
    expect(chipView(s, l2, t2.chips[0]!)).toEqual({ kind: 'said', text: 'Undone: the look is back as it was.' });
    expect(s.undoLine).toBeNull();
    expect(undoLook(s)).toBe(s);
    // A reply without a look change keeps the Undo offer where it was.
    expect(receive(receive(emptyChat(), cnv, t1), cnv, agent('Hi.', [])).undoLine).toBe(l1.id);
  });

  it('only a valid, applied set_look changes the look: not a refused one, not CSS, not an empty one', () => {
    expect(lookChange(agent('x', [{ ...look({ hue: 32 }), status: 'refused' }]))).toBeNull();
    expect(lookChange(agent('x', [look({ css: 'body{}' })]))).toBeNull();
    expect(lookChange(agent('x', [look({})]))).toBeNull();
    expect(lookChange(agent('x', [look({ mode: 'dark', hue: null })]))).toEqual({ mode: 'dark', hue: null });
    expect(lookChange({ ...agent('x', [look({ hue: 3 })]), role: 'user' })).toBeNull();
  });
});
