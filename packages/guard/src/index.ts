/**
 * packages/guard: the check built into agent and runner (not a service). Two layers:
 * - layer one (`checkExtract`, `checkPublish`, `checkChat`): rules in code, no model. It runs first and decides alone
 *   when it's sure. board re-checks a result with `checkPublish`.
 * - layer two (`guardExtract`, `guardPublish`, `guardChat`): layer one, then the decision model through models (role
 *   `guard`) on what layer one passed. It only adds reasons, and fails closed (`unchecked`) when the model can't answer.
 */
export * from './words.ts';
export { checkChat, checkExtract, checkPublish, renderSummary, type ExtractInput, type PublishInput } from './layer-one.ts';
export { checkPage, normalizePage, pageReasons, PAGE_EXFIL_PATTERNS, PAGE_INSTRUCTION_PATTERNS } from './page.ts';
export { chatReplyText, guardChat, guardChatReply, guardExtract, guardPublish, guardPrompt, readAnswer, type GuardOptions, type ModelsCall } from './layer-two.ts';
