import { z } from 'zod';
import { AccountId, ConversationId, Timestamp, TurnId, VerdictId, WidgetId } from '../common.ts';
import { api } from '../endpoint.ts';
import { ToolChip } from '../tools.ts';

export const ChatTurn = z
  .object({
    turn_id: TurnId,
    role: z.enum(['user', 'agent']),
    text: z.string().max(4000),
    chips: z.array(ToolChip),
    picks: z
      .array(z.string().min(1).max(40))
      .max(12)
      .optional()
      .describe('agent turns: tap-to-pick answers written by code (leagues, then teams); a tap sends the text as the next message'),
    verdict_id: VerdictId.nullable().describe('agent turns: the chat verdict'),
    at: Timestamp,
  })
  .strict();
export type ChatTurn = z.infer<typeof ChatTurn>;

export const ChatReply = z
  .object({
    conversation_id: ConversationId,
    turn: ChatTurn.describe('the guarded agent turn, sent whole, never streamed'),
  })
  .strict();
export type ChatReply = z.infer<typeof ChatReply>;

export const AGENT = api('agent', {
  chat: {
    method: 'POST',
    path: '/chat',
    callers: ['edge'],
    body: z
      .object({
        account_id: AccountId,
        conversation_id: ConversationId.nullable(),
        widget_id: WidgetId.nullable().describe('set for a widget\'s "Tune" chat'),
        message: z.string().min(1).max(2000),
      })
      .strict(),
    response: ChatReply,
    errors: [400, 429],
    summary: 'One chat turn. The reply passes the guard; a blocked reply is the fixed line.',
  },
  getConversation: {
    method: 'GET',
    path: '/conversations/:conversation_id',
    callers: ['edge'],
    params: z.object({ conversation_id: ConversationId }),
    query: z.object({ account_id: AccountId }),
    response: z.object({ conversation_id: ConversationId, turns: z.array(ChatTurn) }).strict(),
    errors: [404],
    summary: 'A conversation so far.',
  },
});
