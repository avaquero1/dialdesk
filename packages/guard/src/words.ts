/**
 * Layer one's lists. A match here is sure: the verdict is decided without a model call.
 * Words that are only sometimes advice ("should", "pick", "tip", "lock", "lean", "value", "edge") are not here: a bare
 * "tip" is also an NBA "tip-off", and "should" is also "that should take a minute". Layer two judges those in context.
 */
import { AGENT_TOOLS } from '@app/contracts';

export const WORDLIST_VERSION = 'v1';

/** Advice phrasing (philosophy.md, "Math, not advice"). Each one tells the reader to trade, or calls an outcome certain. */
export const ADVICE_PATTERNS: RegExp[] = [
  /\bbuy\b(?![-\s]?(?:in|ins|into|out|outs)\b)/i,
  /\bsell\b(?![-\s]?(?:out|outs|off|offs)\b)/i,
  /\byou (?:should|must|gotta|ought to)\b/i,
  /\byou(?:'d| would| need to| have to| want to|'ll want to) (?:buy|sell|bet|trade|hammer|load up|get in|jump on)\b/i,
  /\bshould (?:you |i |we )?(?:buy|sell|bet|trade|hammer|load up|get in|jump on)\b/i,
  /\b(?:i'?d|i would|we'?d|we would) (?:buy|sell|hammer)\b/i,
  /\b(?:should|you'?d|you would|i'?d|i would|we'?d|we would|i'?m|i am) (?:you |i |we )?(?:take|taking|back|backing|fade|fading|grab|grabbing|go(?:ing)? with|go(?:ing)? for|ride|riding) (?:the )?(?:yes|no|over|under|favorite|favourite|underdog|dog|home side|away side|other side)\b/i,
  /\bi (?:recommend|suggest|advise)\b/i,
  /\b(?:my|our|best|safe|free) (?:pick|bet|lock)s?\b/i,
  /\bsure thing\b/i,
  /\block (?:it )?in\b/i,
  /\b(?:a|the) lock\b(?! ?(?:er|out|down|step|-))/i,
  /\block of the (?:day|week|night|year|season)\b/i,
  /\bcan'?t (?:lose|miss|go wrong)\b/i,
  /\bguaranteed? (?:win|winner|to (?:win|hit|cash)|profit|returns?|payout|cash)\b|\bit'?s guaranteed\b/i,
  /\b(?:free|easy) money\b/i,
  /\bno[- ]brainer\b/i,
  /\bslam dunk\b/i,
  /\b(?:max|maximum) (?:bet|position|size)\b/i,
  /\bgo(?:ing)? all[- ]in\b|\ball-in\b/i,
  /\b(?:bet|put) (?:it all|everything|the house|your (?:money|savings|stack))\b/i,
  /\bput everything on\b/i,
  /\bload up on\b/i,
  /\b(?:hammer|smash|pound) (?:the )?(?:yes|no|over|under)\b/i,
  /\b(?:don'?t|do not) miss (?:this|out)\b/i,
  /\bget in (?:now|early|before)\b/i,
];

/** "Say trading a prediction market, never betting" (CLAUDE.md). Applies to our own words: templates and chat replies. */
export const VOCABULARY_PATTERNS: RegExp[] = [/\b(?:bet|bets|betting|bettor|bettors|wager|wagers|wagering|gamble|gambling|sportsbook)\b/i];

/** Kept for callers of v0: the words philosophy.md names, all still caught by ADVICE_PATTERNS or VOCABULARY_PATTERNS. */
export const ADVICE_WORDS = ['buy', 'sell', 'you should', 'lock it in', 'sure thing', 'bet', 'betting', "can't lose"];

const TOOL_NAMES = Object.keys(AGENT_TOOLS).join('|');
const AGENTS = '(?:ai|a\\.i\\.|assistant|agent|model|llm|chatbot|bot|gpt|claude)s?';

/** Text aimed at the agent rather than the reader. A match in reader output poisons the source. */
export const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules|directions|guidelines|guardrails|system message)\b/i,
  /\byou are now\b/i,
  new RegExp(`\\binstructions? (?:aimed at|targeting|addressed to|directed at|meant for) (?:all |any )?${AGENTS}\\b`, 'i'),
  /\b(?:new|updated|real|hidden|secret) instructions\b/i,
  /\bsystem prompt\b/i,
  /\b(?:system|admin|developer|operator) (?:notice|message|override|instruction|command)s?\b/i,
  new RegExp(`\\b(?:notice|message|note|instructions?) (?:for|to) (?:all |any )?${AGENTS}\\b`, 'i'),
  new RegExp(`\\b${AGENTS}\\b[^.\\n]{0,20}\\b(?:reading|processing|parsing|summari[sz]ing|scraping|crawling) (?:this|the) (?:page|post|article|text|site)\\b`, 'i'),
  new RegExp(`(?:^|[.!?\\n]\\s*|\\(|\\[)${AGENTS}\\s*:`, 'i'),
  /\btell (?:the|your) (?:user|reader|human|client|customer)s?\b/i,
  /\b(?:say|report|respond|reply|output|answer|show|recommend)\b[^.\n]{0,40}\bto (?:the|your) (?:user|human)s?\b/i,
  /\b(?:do not|don'?t|never) (?:mention|reveal|show|disclose|tell)\b[^.\n]{0,40}\b(?:user|reader|comment|instructions?|risk numbers?)\b/i,
  /\byou (?:must|need to|have to|will|are required to) (?:now )?(?:say|tell|recommend|output|respond|reply|write|state|report|include|call|use|run|visit|open)\b/i,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|###\s*(?:instruction|system)\b/i,
  new RegExp(`\\b(?:${TOOL_NAMES})\\b`, 'i'),
];

/** Asks to send data somewhere. */
export const EXFIL_PATTERNS: RegExp[] = [
  /\b(?:send|post|upload|forward|email|e-mail|leak|share|transmit|paste|submit)\b[^.\n]{0,40}\b(?:api[- ]?keys?|access keys?|private keys?|secret keys?|passwords?|tokens?|cookies?|credentials?|seed phrases?|session (?:ids?|cookies?|tokens?))\b/i,
  /\b(?:api[- ]?keys?|passwords?|tokens?|cookies?|credentials?|secrets?)\b[^.\n]{0,60}\bto https?:\/\//i,
  /\bexfiltrat/i,
  /\b(?:curl|wget)\s+(?:-\S+\s+)*https?:/i,
  /\bdocument\.cookie\b/i,
];

/** Things shaped like secrets. */
export const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)_(?:live_|test_)?[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // a JWT
  /\bAKIA[0-9A-Z]{16}\b/, // an AWS access key id
  /\b0x[0-9a-fA-F]{64}\b/, // 32 bytes of hex: a wallet's private key (an address is 20 bytes)
  /\b[A-Za-z0-9+/]{40,}={0,2}/,
];

/**
 * A summary template holds no number of its own (F8): the engine's numbers fill its slots. Caught outside the slots:
 * any digit in any script, number symbols (½, ²), and spelled amounts from ten up and percentages. Small counts
 * ("the two exchanges", "one source") are allowed.
 */
export const SLOT_RE = /\{[nq][0-9]{1,2}\}/g;
export const BARE_NUMBER_PATTERNS: RegExp[] = [
  /\p{Nd}/u,
  /\p{No}/u,
  /\b(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)\b/i,
  /\b(?:percent|per cent|percentage)\b|%/i,
];
