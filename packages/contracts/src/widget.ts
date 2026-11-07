import { z } from 'zod';
import { AccountId, MarketId, Timestamp, WidgetId } from './common.ts';
import { AppId, Cadence, DisplayParams, DisplaySize, DisplayType } from './catalog.ts';
import { SourceId } from './sources.ts';
import { EnginePlan } from './rust.ts';

/** Where a tile sits: a grid cell, or inside a folder. */
export const Place = z.union([
  z.object({ col: z.number().int().min(0).max(63), row: z.number().int().min(0).max(255) }).strict(),
  z.object({ folder_id: WidgetId, index: z.number().int().min(0).max(63) }).strict(),
]);
export type Place = z.infer<typeof Place>;

const specBase = {
  widget_id: WidgetId,
  account_id: AccountId,
  title: z.string().min(1).max(60),
  place: Place,
};

/** A widget spec: validated against the widget catalog before board saves it. */
export const WidgetSpec = z.discriminatedUnion('kind', [
  z
    .object({
      ...specBase,
      kind: z.literal('display'),
      type: DisplayType,
      size: DisplaySize,
      market_ids: z.array(MarketId).max(12),
      params: DisplayParams,
    })
    .strict(),
  z.object({ ...specBase, kind: z.literal('app'), app: AppId }).strict(),
  z.object({ ...specBase, kind: z.literal('folder'), children: z.array(WidgetId).max(24) }).strict(),
]);
export type WidgetSpec = z.infer<typeof WidgetSpec>;

/** A spec the agent proposes: no ids or place yet (board assigns them on accept). */
export const WidgetDraft = z
  .object({
    kind: z.literal('display'),
    type: DisplayType,
    size: DisplaySize.optional(),
    title: z.string().min(1).max(60),
    market_ids: z.array(MarketId).max(12),
    params: DisplayParams,
    brief: z.string().max(500).optional().describe("the user's own words for this widget"),
  })
  .strict();
export type WidgetDraft = z.infer<typeof WidgetDraft>;

/**
 * A widget's profile: its sub-agent's memory. The user's words, source ids and settings only.
 * Never page text, titles, facts or summaries.
 */
export const WidgetProfile = z
  .object({
    widget_id: WidgetId,
    brief: z.string().max(500).describe("the user's own words"),
    source_ids: z.array(SourceId).max(20),
    added_domains: z.array(z.string()).max(20).describe('domains the user clicked to allow for this widget'),
    cadence: Cadence,
    feedback: z.array(z.object({ at: Timestamp, text: z.string().max(300) }).strict()).max(50),
    last_math_plan: EnginePlan.nullable(),
  })
  .strict();
export type WidgetProfile = z.infer<typeof WidgetProfile>;

export const WidgetState = z.enum(['normal', 'refreshing', 'blocked', 'new']);
