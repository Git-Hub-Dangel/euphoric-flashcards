# LEARN_ALGORITHM — Q&A Reference

Short answers to questions raised during Learn-mode smoke testing.

## Q1. Can the group counter show the actual number of groups (≤ configured) instead of the configured cap when the deck runs out early?

Implemented. `LearnSession` computes once at construction:

```
effectiveLimit = min(configuredLimit, ceil(totalReviewablePoolCards / LEARN_GROUP_SIZE))
```

`totalReviewablePoolCards` = `newCards + matureDue + youngDue + youngFiller` (anchors excluded — they never enter review). `getGroupLimit()` returns `effectiveLimit`; the counter displays the currently active group 1-indexed (first of two → `1/2`; done screen → `gc/effectiveLimit`).

**Terminal cap is still `configuredLimit`, not `effectiveLimit`.** A carryover-driven group past `effectiveLimit` is allowed and overflows the counter (e.g. `3/2`).

**Overflow is only possible when `effectiveLimit < configuredLimit` and a carryover fires past `effectiveLimit`.** If `effectiveLimit == configuredLimit`, the session terminates at group `configuredLimit` regardless of any Again/carryover pattern — no overflow is ever displayed.

## Q2. If a carryover group starts with only 1 carried card, are the other 7 slots filled from the rest of the deck?

Yes. Carryover takes slot 0, then the standard fill pipeline runs on the remaining 7 slots (`matureDue → newCards → youngDue → overflow`). A carried leech is surrounded by up to 7 fresh cards.

## Q3. If pools are exhausted (e.g. carryover + only 2 remaining), will Learn re-draw already-completed cards to pad the group?

No. Completed cards are `splice`d out of the pools and added to `used`; there is no path back. The group simply ends up with 3 cards.

## Q4. With 90 due today, session 1 writes 30 — does session 2 only see the 60 remaining? And does the plugin only start pulling not-yet-due cards once due is exhausted?

Partially. Session 2 re-scans the vault, so the 30 written cards are no longer in the due pools. But `buildLearnGroup` interleaves new cards into every group from the start (up to `floor(G/2) = 4` per group), so due and new are always mixed — due is not drained first.

Once due is exhausted: groups fill from `newCards`, then spill into `youngFiller` (young cards not yet due). `matureAnchors` (mature cards not yet due) are never pulled for review — they serve only as sentence-task anchors.
