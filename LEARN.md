# Learn Mode — Implementation Plan

## Context

Euphoric Flashcards currently ships two review paths driven from the Explorer: `ReviewModal` (SM-2 scheduled review + Cram) and `ConjureSentencesModal` (word-prompt sentence generation). Learn mode fuses the two into one adaptive session — cards are drawn in groups of up to 8, faces are reviewed as in Review, and sentence tasks that prioritise words of the current group are interleaved once group progress crosses adaptive thresholds. A session ends after a configurable number of completed groups (default 3, overridable per-session in the Explorer).

Design authority: the blueprint in the user prompt is the specification. It is internally consistent with EF.md (`ReviewMode` enum, declarative settings, per-mode `cardSide` in `explorerState`, animation invariants, no `element.style.*`). Suggested names are adopted only where they slot cleanly into existing conventions; otherwise adapt.

## Sequential build order

Each phase must end with `npm run build` + `npx tsc --noEmit --skipLibCheck` + `npm test` all green, and a `grep -rn "\.style\." src/ --include="*.ts"` audit with no new hits (invariant 22). Do not proceed to the next phase until the current one is clean.

---

### Phase 1 — Extract shared primitives (no behaviour change)

Refactor so Learn can reuse Review's write path and Conjure Sentences' word-selection primitives without duplication. Review and Conjure Sentences must keep byte-identical behaviour.

**New: `src/scheduling/due.ts`**
- Export `isFaceDue(schedule: ScheduleInfo | null, today: Date): boolean` matching the inline predicate in `src/ui/review/index.ts:36-37`.
- Replace the inline in `buildReviewQueue` (`src/ui/review/index.ts:36`).

**New: `src/utils/shuffle.ts`**
- Export `fisherYates<T>(arr: T[], rng: () => number = Math.random): T[]` (in-place shuffle returning the same array).
- Replace the local copy in `src/ui/conjure-sentences/index.ts:25-31` and the inline shuffle in `src/ui/review/index.ts:55-59`.
- The `rng` seam is required for deterministic Learn tests.

**Extract shared scheduling helpers**
- Move `histogramFor`, `previewInterval`, `applyResponse` from `src/ui/review/index.ts:67-92` to `src/scheduling/session-helpers.ts` (or `src/scheduling/review-runtime.ts` — pick whichever fits). Re-import in `ReviewModal`.
- Keep the free-function shape — Learn will import the same three.

**Extract shared write path**
- Extract `ReviewModal.writeSchedule` (`src/ui/review/index.ts:418-448`) into a free async function `writeGradedResponse({ plugin, fileCache, item, newSchedule, otherHeldLocations })` in `src/ui/shared/write-schedule.ts`:
  - Same steps: `withUpdatedSchedules` → `writeCardBack` → histogram increment/decrement + `saveData_` → in-place `rawLines`/`endLine`/`schedules[fi]` mutation.
  - Returns `{ delta }` so the caller decides how to apply the shift.
- Generalise `shiftQueueForDelta` (`src/ui/review/index.ts:453-465`): export `shiftLocationsForDelta(locations: Iterable<{ card: ParsedCard; filePath: string }>, changedCard, filePath, delta)` in the same file. `ReviewModal` keeps its `shiftQueueForDelta` wrapper delegating to it over `this.queue`. Learn will pass the union of its pools + queue + carryover + anchors + writtenFaces holders.

**Extract Review's card view (rendering only)**
- Pull the DOM/keymap for the *card face* view — prompt, hidden answer with type badge and `cardReveal`, Show Answer + reveal-on-Space/Enter, header (deck path, edit pencil, progress counter), footer action row with Again/Okay/Good, post-Again Again/OK, key badges + gating, interval previews — out of `ReviewModal.renderCard` (`src/ui/review/index.ts:212-329`) into `src/ui/shared/card-view.ts` as a `renderCardFace(opts)` helper that takes callbacks (`onAgain`, `onOkay`, `onGood`, `onReset`, `onOpenEdit`) plus flags (`showIntervalPreviews`, `mode`, `progressText`, `isPostAgain`).
- If clean extraction is disruptive, keep it *inside* `ReviewModal` but make its methods `protected static` free helpers imported by Learn. Prefer extraction only when it stays a straight refactor. If it starts changing behaviour, defer and let Learn temporarily duplicate the render function — invariants say aesthetic + animations must match, not that the DOM must share a file.

**Verification for Phase 1**
- `npm test` — all 95 tests still pass unchanged.
- `npm run build` — clean.
- `grep -rn "\.style\." src/ --include="*.ts"` — no new hits.
- Manual: open Explorer → Review a card → Again + Okay + Good all still write correctly, edit pencil still round-trips.

---

### Phase 2 — Pure Learn modules with vitest coverage

All modules under `src/learn/` are Obsidian-free (like `src/scheduling/`). Each ships with a co-located `*.test.ts` using the `obsidian` alias to `tests/obsidian-stub.ts` and a seeded `rng` (mulberry32 in `src/utils/rng.ts` is enough — a 20-line PRNG suffices).

**`src/learn/constants.ts`**
```
LEARN_GROUP_SIZE = 8
LEARN_MATURE_INTERVAL_DAYS = 21
LEARN_SENTENCE_TRIGGER = 0.7
LEARN_AGAIN_MIN_LAG = 3
LEARN_CARRYOVER_MIN_AGAINS = 2
```

**`src/learn/pool.ts`**
- Types: `LearnPools = { newCards, matureDue, youngDue, youngFiller, matureAnchors: Array<{ card, interval }> }`.
- `classifyPools(cards: ReviewCard[], today: Date, rng): LearnPools`:
  - Per card compute `hasNewFace`, `hasDueFace`, `minSeenInterval` (min interval among non-null schedules).
  - Bucket per section 3 of the blueprint.
  - Rank due pools by overdue ratio `o = (todayMs - lastMs) / interval` (max over faces), ties broken by lowest ease.
  - `newCards` shuffled with `rng`. `youngFiller` sorted ascending by min ease. `matureAnchors` carries `interval = minSeenInterval` for weighting.
- Tests cover: new / due / mature / young / anchor classification against a small parsed corpus; overdue-ratio ranking; anchor split at exactly 21d.

**`src/learn/group-builder.ts`**
- `buildLearnGroup(pools, used: Set<ParsedCard>, carryover: ParsedCard | null, rng): ParsedCard[]`:
  - Slot 0 = carryover (removed from any pool it still sits in), exempt from `used`.
  - Compute remaining due pools' sizes, then `m = round(G * matureDue.remaining / dueRemaining)` capped by `matureDue.remaining`; if any mature-due exists then `m >= 1`.
  - Fill `m` from `matureDue`, up to `floor(G/2)` from `newCards`, then `youngDue`, then overflow from `matureDue`, then `newCards`, then `youngFiller`.
  - Each drawn card is spliced from its pool and added to `used`.
- Tests: exact fill order across contrived pool sizes; the `m` formula; last group short when pools run out; carryover never double-inserted; `used` is honoured for non-carryover slots.

**`src/learn/group-state.ts`**
- `LearnItem = { card: ParsedCard; filePath: string; faceIndex: 0 | 1; writeEligible: boolean }`.
- `LearnCardHistory = { againCount, lastAgainSeq, worst: ReviewResponse | null, wasNew: boolean, pendingFaces: Set<0|1>, facesCleared: [boolean, boolean] }`.
- `GroupState.initialQueue(cards, rng)` — enqueue both faces of every card, shuffle, then repair so adjacent items are not the same `ParsedCard`. Repair: single pass swapping colliding pairs with the next non-colliding successor; fall back to interleaving if the group has only one card left (edge case).
- `GroupState.recordAgain(item, seqCounter)` — bumps `againCount`, stamps `lastAgainSeq`, marks `pendingFaces`, calls `reinsertWithMinLag(queue, item, minLag=LEARN_AGAIN_MIN_LAG, rng)` (new helper in `src/utils/queue.ts`, also usable by Review with `minLag=0` for parity).
- `GroupState.recordClear(item, response)` — flips `facesCleared[fi]`, updates `worst`, removes from `pendingFaces`.
- Group-complete predicate + progress helper (`cleared / totalFaces`).
- `eligibleForSentences(card)` — at least one cleared face and no pending face.
- Tests: initial-queue repair keeps front/back apart; `reinsertWithMinLag` respects minimum lag and clamps at queue end; `pendingFaces` transitions; progress formula.

**`src/learn/sentence-planner.ts`**
- `computeTaskCount(group, histories): number` — `T = min(1 + [f>=2] + [f>=4], ceil(G/2))` where `f` counts `wasNew || againCount>=1`.
- `computeThresholds(T): number[]` — one entry per task following the spec (T=1 → [0.7]; T>=2 → 0.7 + 0.3·(k-1)/(T-1)).
- `nextDueTasks(progress, thresholdsCursor)` — returns how many tasks fire on this answer (handles multi-crossings).
- `pickSentenceWords(opts)`:
  - `opts`: eligibleGroupCards, wordCount `w`, cardSide, appearanceCounts (per card in this group), matureAnchors (excluding current-group cards), rng.
  - Base weights: 4 if `againCount>=1`, else 3 if `wasNew`, else 2 if `worst===Hard`, else 1.
  - Effective weight = `base * 0.5^appearanceCount`.
  - Weighted sampling without replacement for `w-1` group slots (or all candidates if fewer).
  - Anchor slot: weighted by `1/interval` from `matureAnchors`; if empty, replace with one more group word.
  - `w=1` → single slot is a group word.
  - Orientation: reuse the Conjure Sentences resolver (Front/Back/Shuffle → per-draw `faceIndex`, matching `src/ui/conjure-sentences/index.ts:209-212`) via a small shared helper `resolveFaceIndex(side, rng)` in `src/utils/face.ts` — also used by Conjure Sentences after extraction.
- Tests: T over f-values and group sizes; thresholds for T=1..3; multi-crossing on a single answer; weight table and 0.5^u decay; anchor fallback when `matureAnchors` empty; `w=1` path.

**`src/learn/carryover.ts`** (or a function inside `group-state.ts`)
- `selectCarryover(histories, carriedSoFar: Set<ParsedCard>): ParsedCard | null` — highest `againCount >= 2`, tie-break by larger `lastAgainSeq`, excluding `carriedSoFar`. Carried card's face-cleared flags reset (state responsibility of the caller when it starts the next group), history preserved.
- Tests: threshold, tie-break, once-per-session exclusion.

**`src/learn/session.ts`**
- `LearnSession`:
  - Owns `pools`, `used`, `carried`, `writtenFaces: Set<string>` (key `filePath|startLine|faceIndex`).
  - Owns `groupLimit`, `groupsCompleted`, `seqCounter`, current `GroupState`, pending sentence-task queue.
  - `start()` builds first group.
  - `nextStep(): LearnStep` — discriminated union `{ kind: "face"; item } | { kind: "sentence"; words; constraintLabel } | { kind: "done"; groupsCompleted }`.
  - `submitAnswer(item, response)` — routes to face vs post-Again vs Cram-style paths, calls Phase 1's `writeGradedResponse` when `item.writeEligible && !writtenFaces.has(key)`, updates histories and pool locations, checks whether a sentence task fires (via `sentence-planner`), advances to next group + selects carryover when the current group is cleared.
  - `end` condition: `groupsCompleted === groupLimit` or `buildLearnGroup` returns empty.
- Tests: session-wide write-eligibility (a second run same-day writes nothing on a corpus where all faces became due mid-session — none write); carryover exemption from `used`; `writtenFaces` gate on both faces of a carried card.

---

### Phase 3 — Settings + PluginData additions

- `src/settings/index.ts`:
  - `ReviewMode` gains `"Learn"` (`src/settings/index.ts:2`).
  - `EuphoricSettings`: `learnGroupsPerSession: number` (default `3`, range 1–10), `defaultLearnSide: CardSide` (default `"Shuffle"`).
  - Extend `DEFAULT_SETTINGS`.
  - File stays free of `obsidian` imports (invariant 1).
- `src/settings/settings-tab.ts`:
  - Add a `group: "Learn"` block (placed just after the Conjure Sentences group, before Construction Constraints) with:
    - `dropdown` or `slider` for `learnGroupsPerSession` (1–10; a slider fits the existing style and covers the range cleanly — mirror `baseEase` slider shape at `src/settings/settings-tab.ts:255-260`).
    - `dropdown` for `defaultLearnSide` (Front / Back / Shuffle) — matches the Conjure Sentences card-side dropdown at `src/settings/settings-tab.ts:175-183`.
  - No `setDynamicTooltip()`.
- `src/main.ts`:
  - `ExplorerState` (`src/main.ts:7-13`) gains `learnCardSide?: CardSide`. Reads on construction: `saved?.learnCardSide ?? settings.defaultLearnSide` (`src/ui/explorer/index.ts:33-39` pattern).
  - Do not persist `learnGroupsPerSession` on `ExplorerState` — the blueprint is explicit that the per-session override lives only in the modal instance and never persists (§10). It is initialised from `settings.learnGroupsPerSession` every time `ExplorerModal` opens.
  - `PluginData` structural change is additive only; no migration needed.
- Update EF.md §6 (settings + new group), §7 (explorerState addition), and any invariant that grows.

---

### Phase 4 — Explorer wiring

`src/ui/explorer/index.ts`:
- Track `learnSide: CardSide` and `learnGroups: number` on the instance (like `wordCount` at `src/ui/explorer/index.ts:39` — settings-derived, non-persisted for groups; persisted for side).
- Add `"Learn"` to the mode dropdown at `src/ui/explorer/index.ts:116-120`.
- Extend `renderSettingsPanel` (`src/ui/explorer/index.ts:176-191`): under `mode === "Learn"`, render Card Side dropdown (persist via `learnCardSide` in `ExplorerState`) and a **Groups** dropdown of integers 1..10, initial value = `learnGroups`, on-change updates the instance field only (no `persistState()`).
- Extend `openTargetModal` (`src/ui/explorer/index.ts:277-289`) to dispatch to `LearnModal` when `mode === "Learn"`, passing `{ cardSide: learnSide, groupLimit: learnGroups, selectionDeckTag: node.tag }`.
- `persistState` (`src/ui/explorer/index.ts:42-51`) writes `learnCardSide` (mirrors the other per-mode sides). Never writes `learnGroups`.

Back-arrow return still opens a fresh `ExplorerModal`, which re-reads `learnGroupsPerSession` from settings — so overrides reset naturally without any extra code.

---

### Phase 5 — `LearnModal`

`src/ui/learn/index.ts` — new fullscreen modal.

- `onOpen`: `modalEl.addClass("ef-modal-fullscreen")`, `preventBgTapDismiss`, `addCloseButton(this)`, `applyAnimationDuration(this.containerEl, settings.animationDurationMs)`. Loads via `loadCardsForDeck(vault, node, rootTags)` (`src/ui/review/load-cards.ts:41`), passes into `classifyPools`, hands to a `LearnSession`. Errors render like Review's onOpen catch.
- Layout:
  - Header (`.ef-review-header` reused) = deck path + edit pencil + progress (`cleared / totalFaces` in current group, `groupsCompleted / groupLimit`). Reuse `.ef-progress-flash` for progress bumps.
  - Body = swaps between face-view and sentence-view containers. Only the freshly rendered container calls `staggerIn` (§21 first-render rule applies to permanent chrome; body containers stagger every swap).
  - Footer = mode-specific action row. For face: Again/Okay/Good, or Again/OK after an Again, mirroring `ReviewModal.renderResponseButtons` (`src/ui/review/index.ts:291-329`). For sentence: `Continue` + optional `Regenerate` mirroring `ConjureSentencesModal`'s footer buttons.
- Face view: use the Phase 1 shared card-view helper if extraction succeeded; otherwise render inline duplicating `ReviewModal.renderCard` structure. Interval previews only when `item.writeEligible`.
- Sentence view: reuse `.ef-cs-word-list` DOM shape (per-row Reveal via `renderWordItem`-equivalent, `.ef-cc-pill` when applicable, `.ef-fading` cross-fade on `Regenerate`). Extract `renderWordItem` (`src/ui/conjure-sentences/index.ts:248-294`) into `src/ui/shared/word-row.ts` — this piece is self-contained per the exploration.
- Key bindings: 1/2/3 for face view; 1 for Continue / 2 for Regenerate on sentence view (mirrors Conjure Sentences).
- Edit pencil: opens `EditCardModal` exactly like Review (`src/ui/review/index.ts:467-509`). On save, apply `writeGradedResponse`-equivalent line-delta shift across **every session-held location collection**, not just the current queue — call `shiftLocationsForDelta` (from Phase 1) with `[...queue, ...pools.newCards, ...pools.matureDue, ...pools.youngDue, ...pools.youngFiller, ...pools.matureAnchors, ...carriedHolder]` flattened to `{ card, filePath }` shape. This satisfies invariant §2 (session-wide line-shift compensation).
- Done screen: mirror `ReviewModal.renderDone` (`src/ui/review/index.ts:511-524`), text = `Completed N group(s).` Reached when session says `done`.
- Back-arrow: opens a fresh `ExplorerModal` via `fadeOutThen` (same as Review).
- Animation invariants (§21): permanent header + action row stagger on first render only (add a `firstRender` flag); face body and sentence body stagger on every swap (matches spec that switching views staggers new content); reveal animates only `.ef-answer`.
- Every dynamic style routes through `setCssStyles` / `setCssProps` / class toggling. No `.style.foo` writes.

---

### Phase 6 — Styles + EF.md

- `styles.css`: reuse existing `.ef-review-*`, `.ef-cs-*`, `.ef-cc-*`, `.ef-btn`, `.ef-progress-flash`, `.ef-stagger-*`, `.ef-anim-in`, `.ef-modal-fullscreen`, `.ef-modal-leaving` classes. Add only what is genuinely new — a `.ef-learn-*` namespace only if a new layout container needs it. Do not scale response-button `:active` transitions or `.ef-progress-flash` by `animationDurationMs` (§21).
- If `.ef-cs-word-list`'s `--ef-stagger-mult: 1.8` should also apply to Learn's sentence view, either reuse the class name (preferred) or duplicate the override under a Learn-specific selector.
- EF.md (invariant 21 stresses this is mandatory): update §1 (feature description), §2 (add `src/learn/` and `src/ui/learn/`), §5 (add Learn flow after Conjure Sentences), §6 (new settings + declarative entries), §7 (`explorerState.learnCardSide`), §9 (new invariants: (a) write-eligibility fixed at load and gated by `writtenFaces`, (b) session-wide line-shift compensation across pools/queue/carryover/anchors, (c) carryover at most once per card per session, (d) sentence tasks never write schedules).

---

### Phase 7 — End-to-end verification

- `npx tsc --noEmit --skipLibCheck` clean.
- `npm test` — new vitest coverage per §12 of the blueprint (pool classification, `m` formula + fill order, face-repair, min-lag reinsertion, `T` + thresholds, sampling weights + decay, anchor fallback, carryover tie-break + once-per-session).
- `npm run build` clean; artefacts land in `build/euphoric-flashcards/`.
- `grep -rn "\.style\." src/ --include="*.ts"` — zero hits (invariant 22).
- Manual smoke test in a real vault:
  - Open Explorer → switch to Learn → deck click.
  - Complete a group: Again on some faces, verify min-lag reinsertion feels distinct from Review; watch the sentence task fire at 70% and repeat with T=2/3 by seeding fragile groups (mix of new + Again cards).
  - Complete a second group after an Again pattern that should carry over the leech, verify the leech slots at position 1.
  - Second Learn session same day: verify no schedules are written (check a card's SR comment did not shift, verify histogram unchanged).
  - Toggle `enableConstructionConstraints` and verify pill draws on sentence tasks.
  - Toggle `animationDurationMs = 0` and confirm animations off; then set `prefers-reduced-motion` and confirm the same.
  - Mobile check: initial modal preroll fires once; subsequent taps do not lag.
  - Edit pencil during Learn: modify a card in a file that also holds other pool cards below it, confirm downstream `startLine` shifts propagate to remaining queue + pools (invariant §2 session-wide shift).

## Critical files (touched or created)

Created:
- `src/scheduling/due.ts`
- `src/utils/shuffle.ts`, `src/utils/rng.ts`, `src/utils/queue.ts`, `src/utils/face.ts`
- `src/scheduling/session-helpers.ts` (or equivalent naming)
- `src/ui/shared/write-schedule.ts`, `src/ui/shared/card-view.ts` (if extraction stays clean), `src/ui/shared/word-row.ts`
- `src/learn/constants.ts`, `pool.ts`, `group-builder.ts`, `group-state.ts`, `sentence-planner.ts`, `carryover.ts`, `session.ts`
- `src/learn/*.test.ts` for every non-trivial module
- `src/ui/learn/index.ts` (`LearnModal`)

Modified:
- `src/settings/index.ts` — `ReviewMode`, `EuphoricSettings`, `DEFAULT_SETTINGS`.
- `src/settings/settings-tab.ts` — new "Learn" group.
- `src/main.ts` — `ExplorerState.learnCardSide`.
- `src/ui/explorer/index.ts` — mode entry, panel, dispatch, `persistState`.
- `src/ui/review/index.ts` — replace inlines with the extracted helpers; keep behaviour identical.
- `src/ui/conjure-sentences/index.ts` — swap local `fisherYates` and `renderWordItem` for shared imports; face-index resolver replaced by `resolveFaceIndex`.
- `styles.css` — only additive, if truly needed.
- `EF.md` — required update, same commit.

## Existing utilities reused (do not reinvent)

- `loadCardsForDeck` (`src/ui/review/load-cards.ts:41`), `writeCardBack` (`src/ui/review/load-cards.ts:92`) — respect nested-tag boundaries.
- `withUpdatedSchedules`, `frontFace`, `backFace`, `cardReveal`, `parseCard` (`src/parsing/card-parser.ts:217-265`).
- `SRAlgorithmOsr.cardGetNewSchedule / cardCalcUpdatedSchedule / cardGetResetSchedule` (`src/scheduling/osr.ts:145-193`) + `textInterval`.
- `HistogramStore.increment / decrement / toRelativeHistogram` (`src/scheduling/histogram-store.ts`).
- `globalDateProvider.today`, `DateUtil` (`src/scheduling/dates.ts`).
- `preventBgTapDismiss`, `addCloseButton`, `applyAnimationDuration`, `staggerIn`, `fadeOutThen` (`src/ui/modal-utils.ts`).
- `EditCardModal` (`src/ui/edit-card/index.ts`).
- `buildDeckTree` + `DeckNode` + `flattenDeckTree` (`src/decks/`).
- Prefix-on-slash construction-constraint pool logic (`src/ui/conjure-sentences/index.ts:114-128`) — reuse by extracting `buildConstructionConstraintPool(settings, selectionDeckTag)` into `src/ui/shared/construction-constraints.ts` and importing from both modals.

## Notes and tradeoffs

- **Extraction versus duplication of the card view.** The single biggest judgement call. If the shared card-view helper starts requiring branching per-caller (Cram Easy button vs Learn's write-eligibility toggle vs Review's plain writeSchedule), stop and duplicate. Two 250-line render functions that stay in sync via visual review are better than one 400-line function full of caller-flags. Same reasoning applies to `writeGradedResponse`: extract only if it stays a straight relocation.
- **Instance-only `learnGroupsPerSession`.** No persistence path — session ends, Explorer reopens, dropdown re-reads the setting. Zero migration risk.
- **Session-wide `shiftLocationsForDelta`.** `ReviewModal`'s existing shift is scoped to `this.queue`; Learn genuinely holds more references (pools + carryover + anchors), so passing all of them into a shared function is safer than adding a second bespoke shifter. This is invariant §2 in EF.md addition (b) of Phase 6.
- **Sentence tasks never write.** Enforced structurally by not calling `writeGradedResponse` from the sentence-view code path, not by a runtime flag.
- **Weighted sampling without replacement.** Use the standard exponential-jump trick (`-log(u) / weight`) picking the smallest; keeps the implementation to ~10 lines and testable.
