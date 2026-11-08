/**
 * Layer zero: the page's own text, before any model sees it (flow B step 3). No model, no reader: the kill can't depend
 * on what a reader model chooses to repeat (the A1.2.1 bake-off: the real readers left the planted orders out of their
 * facts). It reads everything the browse box returns (visible, hidden and comment text), not only the part the reader
 * gets.
 *
 * A page is full of words that look like orders to a human ("you are now leaving", "ignore the noise", "free agent:",
 * "assistant coach"), so these patterns are narrower than INSTRUCTION_PATTERNS: each one needs text that names an AI
 * reader, or a phrase only an injection uses (chat-template tokens, "ignore your previous instructions", a request
 * for keys). A hit poisons the page.
 */
import { AGENT_TOOLS, type VerdictReasonCode } from '@app/contracts';
import { makeVerdict, type Reasons } from './layer-one.ts';

/** Words that name an AI reader. Plain "agent", "assistant", "model" and "bot" are not here: sports pages use them. */
const AI = '(?:ai|a\\.i\\.|artificial intelligence|llms?|large language models?|language models?|chatbots?|chatgpt|gpts?|claude|gemini|copilot)';
/** An AI reader, possibly with a noun after it: "AI assistants", "LLM agents", "language model". */
const AI_READER = `${AI}(?:[- ](?:assistants?|agents?|models?|bots?|crawlers?|systems?|tools?|readers?|scrapers?|browsers?))?(?![- ]?(?:generated|powered|assisted|written|created|driven|based|enabled|enhanced|produced|curated|summar))`;
/** Any reader the text could be talking to, used only next to a phrase that already reads as an order. */
const ANY_READER = `(?:${AI_READER}|assistants?|agents?|models?|bots?|crawlers?|scrapers?)`;
const ORDER_VERBS = '(?:ignore|disregard|forget|override|bypass|tell|say|recommend|report|respond|reply|output|send|post|upload|forward|reveal|do not|don\'?t|never|must|always|stop|follow|obey|execute|run|call|visit|open|include|write|state)';
/** Orders only an agent takes, for "AI ... must <verb>" (an article can say "AI tools should always be checked"). */
const AGENT_ORDERS = '(?:ignore|disregard|forget|override|bypass|tell|say|recommend|report|respond|reply|output|send|upload|forward|reveal|obey)';

const TOOL_NAMES = Object.keys(AGENT_TOOLS).join('|');

export const PAGE_INSTRUCTION_PATTERNS: RegExp[] = [
  // Overrides: "ignore your previous instructions", "disregard all prior prompts".
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:your|the|my|these|those|previous|prior|above|earlier|preceding|original|initial|system)\s+(?:previous\s+|prior\s+|earlier\s+|original\s+|initial\s+|system\s+)?(?:instructions?|prompts?|directives?|guidelines|guardrails|system (?:message|prompt)s?|programming)\b/i,
  new RegExp(`\\b(?:new|updated|real|hidden|secret|actual|true) (?:system )?instructions? (?:for|to) (?:all |any |every )?(?:the )?${AI_READER}\\b`, 'i'),
  /\bsystem prompt\b/i,
  // A note addressed to an AI: "SYSTEM NOTICE FOR AI ASSISTANTS", "message to any LLM", "attention AI agents".
  new RegExp(`\\b(?:notice|message|note|instructions?|memo|directive|command|order)s? (?:for|to) (?:all |any |every )?(?:the )?${AI_READER}\\b`, 'i'),
  new RegExp(`\\b(?:attention|warning)\\s*[:,!-]?\\s*(?:all |any |every )?${AI_READER}\\b`, 'i'),
  new RegExp(`\\b(?:dear|hey|hello|note to)\\s*,?\\s*(?:all |any |every )?${ANY_READER}\\b`, 'i'),
  // Addressed by name at the start of a sentence: "AI assistant: ignore ...", "LLMs, tell the user ...".
  new RegExp(`(?:^|[.!?\\n]\\s*|\\(|\\[|-{2,}\\s*)(?:to |for )?(?:the |all |any )?${AI_READER}\\s*[:,]\\s*${ORDER_VERBS}\\b`, 'i'),
  // An AI named in the same sentence as an order or as the reader of this page.
  new RegExp(`\\b(?:if you are|if you're) (?:an? )?${ANY_READER}\\b|\\b(?:you are|you're) (?:an? )?${AI_READER}\\b`, 'i'),
  new RegExp(`\\b${ANY_READER}\\b[^.!?\\n]{0,30}\\b(?:reading|processing|parsing|summari[sz]ing|scraping|crawling|indexing|visiting|browsing) (?:this|the) (?:page|post|article|text|site|document|content|comment)\\b`, 'i'),
  new RegExp(`\\b${AI_READER}\\b[^.!?\\n]{0,40}\\b(?:must|should|need to|have to|are required to|are instructed to|will now)\\s+(?:now\\s+)?${AGENT_ORDERS}\\b`, 'i'),
  // Orders about the human on the other side: only an agent has a "user" to tell.
  /\b(?:tell|inform|convince|persuade|instruct|advise) (?:the|your) (?:user|human|operator)s?\b/i,
  /\b(?:say|report|respond|reply|output|answer|show|recommend|suggest)\b[^.!?\n]{0,40}\bto (?:the|your) (?:user|human|operator)s?\b/i,
  /\b(?:do not|don'?t|never) (?:mention|reveal|show|disclose|tell)\b[^.!?\n]{0,40}\b(?:(?:this|these|the) (?:comment|instructions?|note|message|notice)|to the user|the user|risk numbers?)\b/i,
  /\byou (?:are now|will now act|must now) (?:working|acting|operating) (?:for|as|on behalf of)\b/i,
  // Chat-template tokens and prompt markup.
  /<\|(?:im_start|im_end|system|user|assistant|endoftext|begin_of_text|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>|###\s*(?:instruction|system)\b|\bBEGIN (?:SYSTEM|ADMIN) (?:PROMPT|MESSAGE|INSTRUCTIONS)\b/i,
  // Our own agent's tool names: a page has no reason to know them.
  new RegExp(`\\b(?:${TOOL_NAMES})\\b`, 'i'),
];

/** Asks to send the user's secrets somewhere. */
export const PAGE_EXFIL_PATTERNS: RegExp[] = [
  /\b(?:send|post|upload|forward|email|e-mail|leak|share|transmit|paste|submit|include|append)\b[^.!?\n]{0,40}\b(?:(?:the )?user'?s?|their) (?:api[- ]?keys?|access keys?|private keys?|secret keys?|passwords?|tokens?|cookies?|credentials?|seed phrases?|session (?:ids?|cookies?|tokens?)|wallet)\b/i,
  /\b(?:send|post|upload|forward|leak|transmit|paste)\b[^.!?\n]{0,40}\b(?:your|all|any) (?:api[- ]?keys?|private keys?|secret keys?|seed phrases?|session (?:cookies?|tokens?))\b/i,
  /\b(?:api[- ]?keys?|passwords?|tokens?|cookies?|credentials?|secrets?)\b[^.!?\n]{0,60}\bto https?:\/\//i,
  /\bexfiltrat/i,
  /\bdocument\.cookie\b/i,
];

/** Zero-width and format characters an injection uses to split words past a pattern ("ig​nore"). */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** The text the patterns read: compatibility forms folded (full-width letters, ligatures), invisible characters removed. */
export function normalizePage(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
}

/** The reasons a page's own text gives. `where` is `page` (no page words go into a verdict). */
export function pageReasons(text: string): Reasons {
  const t = normalizePage(text);
  const reasons: Reasons = [];
  const checks: [VerdictReasonCode, RegExp[]][] = [
    ['instruction', PAGE_INSTRUCTION_PATTERNS],
    ['exfil', PAGE_EXFIL_PATTERNS],
  ];
  for (const [code, res] of checks) if (res.some((r) => r.test(t))) reasons.push({ code, where: 'page' });
  return reasons;
}

/**
 * Step 3, before the reader: the page's whole text (as the browse box returns it). `poison` => runner kills the held
 * sandbox, and the page never reaches a model. `pass` here proves nothing: the reader's facts still go to the guard.
 */
export function checkPage(text: string) {
  return makeVerdict('extract', pageReasons(text), null);
}
