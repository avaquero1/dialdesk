# Real-world clean pages (no false kills)

The text of five Wikipedia articles, as `pageText` reads them (visible, hidden and comment text; scripts and styles left
out), cut to 60,000 characters. `page.test.ts` checks that the guard's page check passes every one: a clean page must
never get its sandbox killed. "Free agent" is here on purpose: it says "agent" on every line.

Fetched on 2026-11-07 from `https://en.wikipedia.org/api/rest_v1/page/html/<title>`: Buffalo_Bills, Kansas_City_Chiefs,
Boston_Celtics, Free_agent, Prediction_market. Text from Wikipedia, the free encyclopedia, by its contributors, under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (these files only; the rest of the repo is MIT).
