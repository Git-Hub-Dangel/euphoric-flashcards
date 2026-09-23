# Learn Mode — Progress Log

Companion to `LEARN.md` (the full plan). Records what has landed on the `learn-mode` branch.

## Status snapshot (2026-09-23)

- **Baseline:** 95 tests → **now:** 144 tests, all green. `npx tsc --noEmit --skipLibCheck` clean, `npm run build` clean, `grep -rn "\.style\." src/ --include="*.ts"` returns nothing.
- **Branch:** `learn-mode`. No commits yet — everything is uncommitted working-tree changes.
- **Phases 1–6 finished.** Only Phase 7 (manual smoke test in a real vault, no code) remains.

## Phase 1 — Extract shared primitives — DONE

New files (all pure, Obsidian-free):
- `src/utils/rng.ts` — `mulberry32(seed)` deterministic PRNG for tests.
- `src/utils/shuffle.ts` — `fisherYates(arr, rng = Math.random)` with rng seam.
- `src/utils/face.ts` — `resolveFaceIndex(cardSide, rng)` (Front / Back / Shuffle → 0 | 1).
- `src/scheduling/due.ts` — `isFaceDue(schedule, today)` extracted from Review's inline predicate.
- `src/scheduling/session-helpers.ts` — `histogramFor`, `previewInterval`, `applyResponse` extracted from `ReviewModal` (module-level free functions, unchanged behaviour).
- `src/ui/shared/write-schedule.ts` — `writeGradedResponse({plugin, vault, fileCache, item, newSchedule})` returning the line-count `delta`, plus `shiftLocationsForDelta(iterable, changedCard, filePath, delta)` (generalised from `ReviewModal.shiftQueueForDelta` so Learn can pass its full session-held union).

Wired into existing modals:
- `src/ui/review/index.ts` — replaced inline `isFaceDue`, inline shuffle, `histogramFor`/`previewInterval`/`applyResponse`, `writeSchedule` internals, and `shiftQueueForDelta` internals. Behaviour is byte-identical.
- `src/ui/conjure-sentences/index.ts` — replaced local `fisherYates` with `src/utils/shuffle` and inline face-index resolution with `resolveFaceIndex`.

Deferred to Phase 5: `renderCardFace` extraction, `renderWordItem` + `buildConstructionConstraintPool` extraction from Conjure Sentences. Phase 5 ultimately extracted the latter two but not `renderCardFace` (LearnModal duplicates the face render — it stays cleaner than a caller-flag-heavy shared helper).

## Phase 2 — Pure Learn logic + vitest coverage — DONE

New files under `src/learn/`:
- `constants.ts` — `LEARN_GROUP_SIZE=8`, `LEARN_MATURE_INTERVAL_DAYS=21`, `LEARN_SENTENCE_TRIGGER=0.7`, `LEARN_AGAIN_MIN_LAG=3`, `LEARN_CARRYOVER_MIN_AGAINS=2`.
- `pool.ts` — `classifyPools(cards, today, rng)` returns `{ newCards, matureDue, youngDue, youngFiller, matureAnchors }`. Overdue-ratio ranking, ease tie-break, min-interval anchor weighting.
- `group-builder.ts` — `buildLearnGroup(pools, used, carryover)` implements the blueprint fill order: carry, `m = round(G * D_mature / D_due)` clamped to `[1, matureDue.length]`, up to `floor(G/2)` new, `youngDue`, then spills matureDue → newCards → youngFiller.
- `group-state.ts` — `LearnItem`, `LearnCardHistory`, `buildInitialQueue` (rejection-sampling shuffler that prefers the card with the most remaining faces to avoid stuck-alone adjacency), `recordAgain`/`recordClear`, `groupProgress`/`isGroupComplete`/`isEligibleForSentences`.
- `sentence-planner.ts` — `computeTaskCount` (T formula with `ceil(G/2)` cap), `computeThresholds` (0.7 or [0.7 … 1.0] spread), `tasksFiring` (multi-crossing), `weightedSampleWithoutReplacement` (exponential-jump trick), `pickSentenceWords` (weights 4/3/2/1 × 0.5^u, anchor 1/interval, `w=1` skips anchor, `w>=2` empty anchors falls back to group word).
- `carryover.ts` — `selectCarryover(histories, carriedSoFar)` returns highest `againCount ≥ 2`, tie-break by largest `lastAgainSeq`, excludes already-carried cards.
- `session.ts` — `LearnSession` state machine. `start()`, `nextStep(): LearnStep`, `submitFaceAnswer(item, "Again"|"Okay"|"Good"|"OK")` returning `{writeIntent, groupCompleted}`, `confirmWritten(item)`, `dismissSentence()`, `regenerateSentence()`, `heldLocations()`, plus `advanceIfGroupComplete()` (called automatically inside `submitFaceAnswer` / `dismissSentence`). Tracks `writtenFaces` session-wide so second-day sessions never re-write the same face. Snapshots carried card's history so it re-enters the next group with `againCount` intact.
- `src/utils/queue.ts` — `reinsertWithMinLag(queue, currentIdx, item, minLag, rng)`. Used by `recordAgain`.
- `src/learn/test-helpers.ts` — `sched(dueStr, interval, ease?)` and `makeCard(schedules, opts?)` factories. Not a `*.test.ts` so vitest doesn't run it.

Test files (49 new tests):
- `pool.test.ts` (7), `group-builder.test.ts` (7), `group-state.test.ts` (9), `sentence-planner.test.ts` (18), `carryover.test.ts` (5), `session.test.ts` (3).

## Phase 3 — Settings + PluginData — DONE

- `src/settings/index.ts` — `ReviewMode` gained `"Learn"`. `EuphoricSettings` and `DEFAULT_SETTINGS` gained `learnGroupsPerSession: number` (default `3`) and `defaultLearnSide: CardSide` (default `"Shuffle"`).
- `src/settings/settings-tab.ts` — new declarative `group: "Learn"` block placed between Conjure Sentences and Construction Constraints. Slider `learnGroupsPerSession` (min 1, max 10, step 1) and dropdown `defaultLearnSide` (Shuffle / Front / Back).
- `src/main.ts` — `ExplorerState` gained optional `learnCardSide?: CardSide` (additive, no migration).
- `EF.md` §6 (settings surface + Learn group) and §7 (`explorerState.learnCardSide`, non-persisted `learnGroupsPerSession`) updated in the same pass.

## Phase 4 — Explorer wiring — DONE

`src/ui/explorer/index.ts`:
- Added instance fields `learnSide: CardSide` (persisted through `explorerState.learnCardSide`, falls back to `settings.defaultLearnSide`) and `learnGroups: number` (instance-only, re-read from `settings.learnGroupsPerSession` in `load()` so per-session overrides reset naturally on every reopen).
- `"Learn"` added to the mode dropdown between `Cram` and `Conjure Sentences`.
- `renderSettingsPanel` gained a `Learn` branch: Card Side dropdown (persists via `learnCardSide`) plus a Groups dropdown of integers 1..10 that mutates the instance field only (no `persistState()`).
- `persistState` writes `learnCardSide`; `learnGroups` is never persisted.
- `openTargetModal` Learn branch initially a no-op — replaced with real `LearnModal` dispatch in Phase 5.

## Phase 5 — `LearnModal` — DONE

New:
- `src/ui/shared/construction-constraints.ts` — `buildConstructionConstraintPool(settings, selectionDeckTag)` extracted from Conjure Sentences (prefix-on-slash, case-insensitive, `#`-stripped, multi-collection union).
- `src/ui/shared/word-row.ts` — `renderWordRow(container, {card, faceIndex}, settings)` extracted from Conjure Sentences' `renderWordItem`. Reveal button toggles `.ef-hidden` on `.ef-cs-reveal-area`; reveal animates via `staggerIn`.
- `src/ui/learn/index.ts` — `LearnModal` fullscreen modal. `onOpen` wires `preventBgTapDismiss`, `addCloseButton`, `applyAnimationDuration`, `.ef-modal-fullscreen`, and the shared `.ef-review` class so it inherits Review's styles. Loads cards via `loadCardsForDeck`, classifies with `classifyPools(today)`, instantiates `LearnSession({groupLimit, wordCount: settings.conjureSentencesWordCount, cardSide, today, rng: Math.random})`.
- Layout: permanent header (`.ef-review-header`) + body (`.ef-card-body`) + footer (`.ef-review-actions`); header + footer stagger on first render only, body content staggers every swap. Header shows deck path, edit pencil, and progress as `cleared/total · groupsCompleted/limit` with `.ef-progress-flash`. On sentence steps the edit pencil is hidden.
- Face step: prompt + hidden answer + type badge + explanation + examples; Show Answer + `1/2/3` keys + Space/Enter reveal. Post-Again shows `Again`/`OK`; first-pass shows `Again`/`Okay`/`Good`. Interval previews gated on `settings.showIntervalOnButtons && item.writeEligible`.
- Answer routing: `submitFaceAnswer(...)` → if `writeIntent !== null`, compute schedule (`SRAlgorithmOsr.cardGetResetSchedule` for `intent.kind === "reset"`, else `applyResponse`), `writeGradedResponse`, `session.confirmWritten(item)`, then `shiftLocationsForDelta(session.heldLocations(), item.card, item.filePath, delta)` (session-wide).
- Sentence step: `.ef-cs-word-list` with an optional `.ef-cc-pill` (drawn uniformly from `constraintPool`, redrawn on every sentence render), one `renderWordRow` per pick. Footer is `Regenerate` (key `1`, left) + `Good` (key `2`, right) — matching Conjure Sentences' order (fixed after the initial Continue/Regenerate ordering was reversed from the spec).
- Edit pencil: opens `EditCardModal` with SR-stripped text; on save re-parses, re-attaches schedules via `withUpdatedSchedules`, `writeCardBack`, mutates the shared `ParsedCard` in place, and shifts session-wide via `shiftLocationsForDelta(session.heldLocations(), ...)`.
- Done screen: `Completed N group(s).` + Back to Explorer.
- Back-arrow: `fadeOutThen` into a fresh `ExplorerModal`.

Modified:
- `src/ui/conjure-sentences/index.ts` — swapped in the shared helpers; dropped now-unused `frontFace`/`backFace`/`cardReveal` imports. Behaviour unchanged.
- `src/ui/explorer/index.ts` — `openTargetModal` now instantiates `LearnModal` (was a no-op stub in Phase 4).

## Phase 6 — Styles + EF.md — DONE

- `styles.css`: no changes. Learn borrows `.ef-review-*`, `.ef-card-*`, `.ef-cs-word-list` (inheriting its `--ef-stagger-mult: 1.8` for the sentence view), `.ef-cc-pill*`, `.ef-btn*`, `.ef-progress-flash`, `.ef-anim-*`, `.ef-modal-fullscreen`, `.ef-modal-leaving`. `LearnModal.onOpen` sets `this.contentEl.addClass("ef-review")` so every review-scoped rule applies.
- `EF.md` updated in the same commit as required by invariant 21:
  - §1: mentions Learn mode in the feature list; version bumped `1.3.0` → `1.3.1`.
  - §2: repo layout expanded to include `src/learn/*`, `src/utils/*`, `src/ui/learn/`, `src/ui/shared/*`, and `src/scheduling/due.ts` + `src/scheduling/session-helpers.ts`. Test count updated 95 → 144.
  - §5: added the Learn flow paragraph (session state machine, face/sentence step routing, writeIntent → schedule computation, session-wide line-shift, sentence footer order `Regenerate` (1) / `Good` (2), permanent chrome staggers first-render-only).
  - §9: added invariants 22–25 (write-eligibility fixed at load + `writtenFaces` gate; session-wide `shiftLocationsForDelta`; carryover at most once per card per session; sentence tasks never write). The pre-existing "no `.style.*`" invariant was renumbered from 22 to 26 and the cross-reference inside invariant 21 was updated to point at the new number.

## Phase 7 — Manual smoke test — TODO

Only vault-side verification remains. Blueprint §12 checklist to walk through:
- Open Explorer → switch to Learn → deck click.
- Complete a group: Again on some faces (verify min-lag reinsertion), watch the sentence task fire at ~70% and again with T=2/3 by seeding fragile groups.
- Complete a second group after an Again pattern that carries over the leech (verify slot 0 in group 2).
- Second Learn session same day: verify no schedules are re-written (SR comment unchanged, histogram unchanged).
- Toggle `enableConstructionConstraints` and verify pill draws on sentence tasks.
- Toggle `animationDurationMs = 0`; toggle `prefers-reduced-motion`; verify animations disable.
- Mobile: initial modal preroll fires once, subsequent taps don't lag.
- Edit pencil during Learn: modify a card whose file also holds other pool cards below it, confirm downstream `startLine` shifts propagate to remaining queue + pools.

## Design notes worth keeping in mind

- `session.getGroupProgress()` returns `{ cleared, total }` in **face** units; the modal composes the two-line "faces / groups" display from `getGroupProgress()` + `getGroupsCompleted()` + `getGroupLimit()`.
- `computeTaskCount` is recomputed inside `enqueueDueSentenceTasks` on every answer, so a group that becomes more fragile mid-run (more Agains land) can enlarge T retroactively. Thresholds regenerate; already-fired tasks stay fired via `thresholdCursor`. Spec-consistent.
- `session.regenerateSentence()` rolls back appearance counts for the outgoing pick and re-bumps for the new pick. Sentence-planner's word selection is deterministic given `rng`, so re-draws behave predictably in tests.
- `writeGradedResponse` still calls `plugin.saveData_()` fire-and-forget when load balancing is on (matches the pre-existing behaviour in `ReviewModal.writeSchedule`).
- Review's card render was NOT extracted into a shared helper — LearnModal duplicates the face render because a caller-flag-heavy `renderCardFace` would have started drifting. Two ~200-line renders that stay in sync via visual review beat one 400-line render full of branches.

## How to resume

1. Read `LEARN.md` (the plan) and this file.
2. `git status` / `git diff` (nothing committed yet — the whole learn-mode work is uncommitted).
3. Run `npm test && npm run build && grep -rn "\.style\." src/ --include="*.ts"` — all should be green / silent.
4. Only Phase 7 (manual smoke test) is outstanding. If everything checks out, the branch is ready to commit and merge.
