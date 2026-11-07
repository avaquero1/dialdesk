/**
 * The chat agent's function tools (not MCP). The names are the contract: the models service passes them to the
 * chat model, the agent executes them, and the browser renders each call as a chip.
 */
import { z } from 'zod';
import { MarketId, ProposalId, ReceiptId, WidgetId } from './common.ts';
import { LookPatch } from './look.ts';
import { WidgetDraft } from './widget.ts';
import { DisplaySize } from './catalog.ts';

export const AGENT_TOOLS = {
  /** Propose new widgets from the catalog. board stores them as pending; the user's click makes them real. */
  propose_widget: z.object({ widgets: z.array(WidgetDraft).min(1).max(6) }).strict(),
  /** Change one widget's brief, size or params (a Tune chat). Pending until the user's click. */
  tune_widget: z
    .object({
      widget_id: WidgetId,
      brief: z.string().max(500).optional(),
      size: DisplaySize.optional(),
      user_probability: z.number().min(0).max(1).optional(),
      threshold_pts: z.number().min(1).max(50).optional(),
    })
    .strict(),
  /** Propose removing a widget. Pending until the user's click. */
  remove_widget: z.object({ widget_id: WidgetId }).strict(),
  /** Read a market's current price from markets (numbers only). */
  quote_market: z.object({ market_id: MarketId }).strict(),
  /** Read a receipt already on the user's board. */
  read_receipt: z.object({ receipt_id: ReceiptId }).strict(),
  /** Change the look. Only theme, mode and hue: never CSS. Applied by the browser, saved through edge to accounts. */
  set_look: LookPatch,
} as const;

export type AgentToolName = keyof typeof AGENT_TOOLS;
export const AgentToolName = z.enum(Object.keys(AGENT_TOOLS) as [AgentToolName, ...AgentToolName[]]);

/** A tool call as the chat shows it. */
export const ToolChip = z
  .object({
    tool: AgentToolName,
    args: z.record(z.string(), z.unknown()),
    status: z.enum(['proposed', 'applied', 'refused']),
    proposal_id: ProposalId.nullable(),
    label: z.string().max(80).describe('e.g. "set_look · hue 32°"'),
  })
  .strict();
export type ToolChip = z.infer<typeof ToolChip>;

/** The tool list in the shape models' /complete takes (JSON Schema parameters). */
export function agentToolDefs() {
  return (Object.keys(AGENT_TOOLS) as AgentToolName[]).map((name) => ({
    name,
    parameters: z.toJSONSchema(AGENT_TOOLS[name]) as Record<string, unknown>,
  }));
}
