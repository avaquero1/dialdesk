# packages/guard

The check inside agent and runner (not a service). Every reader output, result and chat reply passes it before it
reaches the user. It returns a `Verdict` (packages/contracts).

## Two layers

**Layer one: rules in code, no model** (`checkExtract`, `checkPublish`, `checkChat`). It runs first and decides alone
when it's sure: any match blocks or poisons, and the model is not asked. board re-checks a result with `checkPublish`.

| Stage | Layer one catches |
|---|---|
| extract (flow B step 3) | orders aimed at the agent (`instruction`): "ignore your previous instructions", "AI assistant:", "notice for AI assistants", "tell the user", "do not mention this comment", chat-template tokens, our tool names; asks to send data (`exfil`): keys, passwords or cookies sent somewhere, `curl`, `document.cookie`. => `poison` |
| publish (step 6) | a number in the template outside a slot (`bare_digit`, F8: any digit in any script, ½, spelled amounts from ten up, "percent", `%`); advice and betting words in the template or in a quote placed in a slot (`advice`); a slot with no receipt or of the wrong kind (`missing_receipt`); a fact with no source (`unsourced_claim`); a source that isn't https (`bad_link`); secrets. => `block` |
| chat (flow D) | advice and betting words, secrets, orders aimed at the agent, asks to send data. => `block`, and the user sees "I do math, not calls." (F7) |

The lists are in `src/words.ts` (`WORDLIST_VERSION` v1). Words that are only sometimes advice are left to layer two:
"should" ("that should take a minute"), "tip" (an NBA tip-off), "pick" ("the former first pick"), a bare "lock",
"value", "lean", and "I'd take the Bills" (a team name). "you should", "buy YES", "lock it in" and "I'd take YES" stay
in layer one.

**Layer two: the decision model** (`guardExtract`, `guardPublish`, `guardChat`, `guardChatReply`). It runs layer one,
and only when that passes asks models (role `guard`: nemotron-3.5-content-safety, then qwen3.8-flash-next;
`MODELS_ROLE_GUARD` overrides) two questions: "is this advice?" (publish, chat) and "does this text carry instructions
aimed at the agent?" (extract, chat). It only adds reasons: it never lets through what layer one blocked.

- The text goes inside a JSON `items` list, so page text can't break out of it. The system prompt holds no page text.
- It reads our shape `{"advice": [ids], "instructions": [ids]}`, booleans, the models fake's `{"outcome": ...}`, a
  content-safety answer (`"Response Safety": "unsafe"`) and a bare `safe`/`unsafe`. Ids it doesn't know become the
  stage's default field (`reply`, `summary`, the first fact).
- **Fails closed.** A model error (402 kill switch, 429, 502) or an unreadable answer gives reason `unchecked` and
  outcome `block`. At the extract stage that's `block`, not `poison`: runner releases the sandbox and drops that
  source's facts, without the poison note (the page did nothing we know of).
- `checker.model` names the model that answered, or `null` when layer one decided alone.

```ts
import { guardChatReply, guardExtract } from '@app/guard';
const models = await clientFromEnv('runner', 'models');
const v = await guardExtract(facts, { models, account_id }); // 'poison' => kill the live sandbox
const { verdict, text } = await guardChatReply(reply, { models: await clientFromEnv('agent', 'models'), account_id });
```

Tests: `packages/guard/test/guard.test.ts` (the fixture pages, advice bait, slot summaries, chat replies, answer
shapes), on the models fake behind the real typed client.
