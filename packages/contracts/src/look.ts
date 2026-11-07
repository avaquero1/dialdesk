import { z } from 'zod';

/**
 * The 12 candidate themes from the mockups. 6 are kept after the review; the contracts owner then narrows
 * THEME_IDS to those 6 (a v1 change). Until then every candidate validates.
 */
export const THEME_IDS = [
  'agent-mail',
  'clear-water',
  'mercury',
  'stadium-night',
  'deep-sea',
  'ice',
  'aurora',
  'prism',
  'obsidian',
  'rain',
  'daybreak',
  'ink-in-water',
] as const;
export const ThemeId = z.enum(THEME_IDS);
export const LookMode = z.enum(['light', 'dark', 'system']);

/** The only stored look value. Never CSS from a model: just these three values. */
export const Look = z
  .object({
    theme: ThemeId,
    mode: LookMode,
    hue: z.number().int().min(0).max(360).nullable().describe("null = the theme's own hue"),
  })
  .strict();
export type Look = z.infer<typeof Look>;

/** set_look's arguments: any subset of the look. */
export const LookPatch = Look.partial().strict();
export type LookPatch = z.infer<typeof LookPatch>;

export const DEFAULT_LOOK: Look = { theme: 'agent-mail', mode: 'system', hue: null };
