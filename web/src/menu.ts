/**
 * The ⋯ menu, without the DOM: the same seven rows on every tile, in the same order. A row that doesn't apply to this
 * tile is greyed, never hidden, so the menu always looks the same. Sizes come from the catalog.
 */
import { DisplaySize, displayEntry, type Widget } from '@app/contracts';

export type MenuAction = 'agent' | 'refresh' | 'size' | 'how' | 'move' | 'clear' | 'remove';
export type Size = (typeof DisplaySize.options)[number];
export const SIZES: readonly Size[] = DisplaySize.options;

export interface MenuRow {
  action: MenuAction;
  label: string;
  on: boolean;
}

/** The labels from the design (section 5). */
export const LABELS: Record<MenuAction, string> = {
  agent: 'Change it with the agent',
  refresh: 'Refresh now',
  size: 'Size',
  how: 'How we got this',
  move: 'Move to a folder',
  clear: 'Clear all',
  remove: 'Remove',
};
const ORDER: MenuAction[] = ['agent', 'refresh', 'size', 'how', 'move', 'clear', 'remove'];
/** Rows a later step wires (the chat in W1.3, the receipts trail in W1.2): greyed on every tile until then. */
export const NOT_YET: ReadonlySet<MenuAction> = new Set(['agent', 'how']);

/** Every size in the same order; the ones the catalog doesn't allow for this display are off. */
export function sizesFor(w: Widget): { size: Size; on: boolean; cur: boolean }[] {
  const s = w.spec;
  const ok: readonly string[] = s.kind === 'display' ? displayEntry(s.type).sizes : [];
  return SIZES.map((size) => ({ size, on: ok.includes(size) && s.kind === 'display' && s.size !== size, cur: s.kind === 'display' && s.size === size }));
}

/** The folders a tile can move into: any folder on the board, but folders don't nest. */
export function foldersFor(w: Widget, all: Iterable<Widget>): Widget[] {
  if (w.spec.kind === 'folder') return [];
  return [...all].filter((f) => f.spec.kind === 'folder' && f.spec.widget_id !== w.spec.widget_id);
}

export function menuRows(w: Widget, all: Iterable<Widget>): MenuRow[] {
  const display = w.spec.kind === 'display';
  const on: Record<MenuAction, boolean> = {
    agent: false,
    refresh: display && w.state !== 'refreshing',
    size: display && sizesFor(w).some((z) => z.on),
    how: false,
    move: foldersFor(w, all).length > 0,
    clear: display,
    remove: true,
  };
  return ORDER.map((action) => ({ action, label: LABELS[action], on: on[action] && !NOT_YET.has(action) }));
}
