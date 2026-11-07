# packages/guard

The check inside agent and runner (not a service). Phase 0 has layer one, in code: word lists for advice,
patterns for orders aimed at the agent and for secrets, and the structural checks on a result (no bare digit in a
summary template, a receipt for every number slot, a source for every fact). `checkExtract`, `checkPublish` and
`checkChat` return a `Verdict` (packages/contracts). Layer two, the decision model through models (role `guard`),
comes in Phase 1 and can only make a verdict stricter.
