# Learn Mode — Progress Log

Companion to `LEARN.md` (the full plan). Records what has landed on the `learn-mode` branch so a fresh conversation can pick up mid-implementation.

## Status snapshot (2026-09-23)

- **Baseline:** 95 tests → **now:** 144 tests, all green. `npx tsc --noEmit --skipLibCheck` clean, `npm run build` clean, `grep -rn "\.style\." src/ --include="*.ts"` returns nothing.
- **Branch:** `learn-mode`. No commits yet — everything is uncommitted working-tree changes.
- **Phase 4 finished.** Next up is Phase 5 (`LearnModal`).

## Phase 1 — Extract shared primitives — DONE

New files (all pure, Obsidian-free):
- `src/utils/rng.ts` — `mulberry32(seed)` deterministic PRNG for tests.
- `src/utils/shuffle.ts` — `fisherYates(arr, rng = Math.random)` with rng seam.
- `src/utils/face.ts` — `resolveFaceIndex(cardSide, rng)` (Front / Back / Shuffle → 0 | 1).
- `src/scheduling/due.ts` — `isFaceDue(schedule, today)` extracted from Review's inline predicate.
- `src/scheduling/session-helpers.ts` — `histogramFor`, `previewInterval`, `applyResponse` extracted from `ReviewModal` (module-level free functions, unchanged behaviour).
- `src/ui/shared/write-schedule.ts` — `writeGradedResponse({plugin, vault, fileCache, item, newSchedule})` returning the line-count `delta`, plus `shiftLocationsForDelta(iterable, changedCard, filePath, delta)` (generalised from ReviewModal.shiftQueueForDelta so Learn can pass its full session-held union).

Wired into existing modals:
- `src/ui/review/index.ts` — replaced inline `isFaceDue`, inline shuffle, `histogramFor`/`previewInterval`/`applyResponse`, `writeSchedule` internals, and `shiftQueueForDelta` internals. Behaviour is byte-identical.
- `src/ui/conjure-sentences/index.ts` — replaced local `fisherYates` with `src/utils/shuffle` import and inline face-index resolution with `resolveFaceIndex`.

**Intentionally deferred to Phase 5** (per plan's "prefer extraction only when it stays a straight refactor"): `renderCardFace` extraction (the Review card-view shared helper), and extraction of `renderWordItem` + `buildConstructionConstraintPool` from Conjure Sentences.

## Phase 2 — Pure Learn logic + vitest coverage — DONE

New files under `src/learn/`:
- `constants.ts` — `LEARN_GROUP_SIZE=8`, `LEARN_MATURE_INTERVAL_DAYS=21`, `LEARN_SENTENCE_TRIGGER=0.7`, `LEARN_AGAIN_MIN_LAG=3`, `LEARN_CARRYOVER_MIN_AGAINS=2`.
- `pool.ts` — `classifyPools(cards, today, rng)` returns `{ newCards, matureDue, youngDue, youngFiller, matureAnchors }` per blueprint §3. Overdue-ratio ranking, ease tie-break, min-interval anchor weighting.
- `group-builder.ts` — `buildLearnGroup(pools, used, carryover)` implements the fill order (§4): carry, `m = round(G * D_mature / D_due)` clamped to `[1, matureDue.length]`, up to `floor(G/2)` new, `youngDue`, then spills matureDue → newCards → youngFiller.
- `group-state.ts` — `LearnItem`, `LearnCardHistory`, `buildInitialQueue` (rejection-sampling shuffler that prefers the card with the most remaining faces to avoid stuck-alone adjacency), `recordAgain`/`recordClear`, `groupProgress`/`isGroupComplete`/`isEligibleForSentences`.
- `sentence-planner.ts` — `computeTaskCount` (T formula with `ceil(G/2)` cap), `computeThresholds` (0.7 or [0.7 … 1.0] spread), `tasksFiring` (multi-crossing), `weightedSampleWithoutReplacement` (exponential-jump trick), `pickSentenceWords` (weights 4/3/2/1 × 0.5^u, anchor 1/interval, `w=1` skips anchor, `w>=2` empty anchors falls back to group word).
- `carryover.ts` — `selectCarryover(histories, carriedSoFar)` returns highest `againCount ≥ 2`, tie-break by largest `lastAgainSeq`, excludes already-carried cards.
- `session.ts` — `LearnSession` state machine. `start()`, `nextStep(): LearnStep`, `submitFaceAnswer(item, "Again"|"Okay"|"Good"|"OK")` returning `{writeIntent, groupCompleted}`, `confirmWritten(item)`, `dismissSentence()`, `regenerateSentence()`, `heldLocations()`, plus `advanceIfGroupComplete()` (called automatically inside `submitFaceAnswer` / `dismissSentence`). Tracks `writtenFaces` session-wide so second-day sessions never re-write the same face. Snapshots carried card's history so it re-enters the next group with `againCount` intact.
- `src/utils/queue.ts` — `reinsertWithMinLag(queue, currentIdx, item, minLag, rng)`. Used by `recordAgain`.
- `src/learn/test-helpers.ts` — `sched(dueStr, interval, ease?)` and `makeCard(schedules, opts?)` factories. Not a `*.test.ts` file so vitest doesn't run it.

Test files (49 new tests):
- `pool.test.ts` (7) — bucketing, overdue ranking, ease tie-break, filler ordering, seeded shuffle.
- `group-builder.test.ts` (7) — fill order, m clamp, short group, empty group, carryover slot 0, `used` bypass, spill order.
- `group-state.test.ts` (9) — face count, adjacency repair across 20 seeds, `writeEligible` gating, min-lag reinsertion, min-lag clamp, `recordAgain`/`recordClear` transitions, post-Again worst preservation, progress + completion.
- `sentence-planner.test.ts` (18) — T formula, ceil cap, thresholds, multi-crossing cursor, weight determinism, zero-weight skip, weight bias in the long run, anchor fallback, wordCount=1, decay bias.
- `carryover.test.ts` (5) — threshold, highest wins, tie-break, once-per-session exclusion, all-carried → null.
- `session.test.ts` (3) — writeEligible per (card, face) at load; `writtenFaces` gate ensures second-session writes stay null; carryover keeps the leech in the next group's held locations.

## Phase 3 — Settings + PluginData — DONE

- `src/settings/index.ts` — `ReviewMode` gained `"Learn"` (prior pass). `EuphoricSettings` and `DEFAULT_SETTINGS` gained `learnGroupsPerSession: number` (default `3`) and `defaultLearnSide: CardSide` (default `"Shuffle"`).
- `src/settings/settings-tab.ts` — new declarative `group: "Learn"` block placed between the Conjure Sentences group and Construction Constraints. Slider `learnGroupsPerSession` (min 1, max 10, step 1) and dropdown `defaultLearnSide` (Shuffle / Front / Back).
- `src/main.ts` — `ExplorerState` gained optional `learnCardSide?: CardSide` (additive, no migration). Explorer reads still to be wired in Phase 4 with the `saved?.learnCardSide ?? settings.defaultLearnSide` fallback.
- `Ef.md` §6 (settings surface + new Learn group placement) and §7 (`explorerState.learnCardSide`, non-persisted `learnGroupsPerSession`) updated in the same pass.

Nothing in Phase 3 touched the Explorer UI itself — that is Phase 4.

## Phase 4 — Explorer wiring — DONE

`src/ui/explorer/index.ts`:
- Added instance fields `learnSide: CardSide` (persisted through `explorerState.learnCardSide`, falls back to `settings.defaultLearnSide`) and `learnGroups: number` (instance-only, re-read from `settings.learnGroupsPerSession` in `load()` so per-session overrides reset naturally on every reopen — blueprint §10 / plan Phase 3 rule).
- `"Learn"` added to the mode dropdown between `Cram` and `Conjure Sentences`.
- `renderSettingsPanel` gained a `Learn` branch: Card Side dropdown (persists via `learnCardSide`) plus a Groups dropdown of integers 1..10 that mutates the instance field only (no `persistState()`).
- `persistState` writes `learnCardSide`; `learnGroups` is never persisted.
- `openTargetModal` has a `Learn` branch that is currently a no-op — Phase 5 wires it to `new LearnModal(...)` with `{ cardSide: this.learnSide, groupLimit: this.learnGroups, selectionDeckTag: node.tag }`. The click still closes the Explorer via `launchMode`'s `fadeOutThen`; without a target modal, the user lands on an empty vault view. Acceptable interim state until Phase 5 lands.

Verification: `npx tsc --noEmit --skipLibCheck` clean, `npm test` all 144 pass, `npm run build` clean, `grep -rn "\.style\." src/ --include="*.ts"` empty.

## Phases 5–7 — untouched

Blueprint sections still ahead:
- Phase 5: `src/ui/learn/index.ts` (`LearnModal`). Reuses Review's face render + Conjure Sentences' word render (extract `renderWordItem` + `buildConstructionConstraintPool` into `src/ui/shared/*` if extraction stays clean). Fullscreen invariants (`preventBgTapDismiss`, `addCloseButton`, `applyAnimationDuration`, `.ef-modal-fullscreen`). Progress = `cleared/total` in current group and `groupsCompleted/groupLimit`. Edit-pencil shift uses `session.heldLocations()` + `shiftLocationsForDelta`.
- Phase 6: `styles.css` (only if new selectors needed) + `EF.md` update in the same commit (invariant 21). New invariants to add: (a) write-eligibility fixed at load and gated by `writtenFaces`, (b) session-wide line-shift compensation across pools + queue + carryover + anchors, (c) carryover at most once per card per session, (d) sentence tasks never write schedules.
- Phase 7: manual smoke test (blueprint §12 checklist).

## Known caveats to raise in the next pass

- `session.getGroupProgress()` returns `{ cleared, total }` in **face** units. The blueprint UI wants a two-line progress display (`groups completed / limit` and `cleared / total in current group`); both are already exposed on the session.
- `computeTaskCount` is recomputed inside `enqueueDueSentenceTasks` on every answer, so a fragile group that becomes more fragile mid-run (more Agains land) can enlarge T retroactively. Thresholds regenerate; already-fired tasks stay fired via `thresholdCursor`. Spec-consistent, but worth double-checking against §6 during Phase 5 review.
- `session.regenerateSentence()` rolls back appearance counts for the outgoing pick and re-bumps for the new pick. Sentence-planner's word selection is deterministic given `rng`, so re-draws behave predictably in tests.
- `writeGradedResponse` is a straight extract; it still calls `this.plugin.saveData_()` fire-and-forget when load balancing is on (matching the pre-existing `void this.plugin.saveData_();` behaviour in `ReviewModal.writeSchedule`).
- Phase 1 deliberately *did not* extract the Review card render (`renderCardFace`). Phase 5 will decide whether to extract or let LearnModal duplicate.

## How to resume

1. Read `LEARN.md` (the plan) top-to-bottom.
2. Read this file for state.
3. `git diff` (nothing committed yet — the whole learn-mode work is uncommitted).
4. Run `npm test && npm run build && grep -rn "\.style\." src/ --include="*.ts"` — all should be green / silent.
5. Pick up at Phase 3 remainder (settings shape + settings-tab entries + `ExplorerState.learnCardSide`), then move to Phase 4.
