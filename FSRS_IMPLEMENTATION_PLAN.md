# FSRS Implementation Plan — Euphoric Flashcards

> **Agent onboarding.** Read §A (context), §B (locked decisions) and §C (guardrails) before touching any file. Then execute phases in order. Do not start a phase whose preconditions are unmet. Every phase ends with `npm test` green and `npx tsc --noEmit --skipLibCheck` clean; a phase is not complete otherwise.
>
> Companion document: `FSRS_MIGRATION.md` holds the analysis this plan derives from. This file holds the work. Where they disagree, this file wins.

---

## A. Context

| Key | Value |
|---|---|
| Plugin | Euphoric Flashcards `1.4.1`, Obsidian min `1.13.0` |
| Migrating from | SM-2 / OSR (`interval` days + `ease` integer percent) |
| Migrating to | `ts-fsrs@5.4.2` (stability / difficulty / state / reps / lapses) |
| Baseline | 170 tests passing, `tsc` clean, `main.js` ~123 KB |
| Reference clone | `/ts-fsrs` at repo root, gitignored, reference only. Never import from it |
| Scope of change | ~50% of `src/`. See §D for the untouched list |

**Behavioural consequence to expect and not misdiagnose.** The existing `delayDays` overdue-credit terms have never executed in production (sign inversion between `osr.ts:28` and `comment-parser.ts:43`, then clamped by `Math.max(0, …)`). FSRS's `elapsed_days` works correctly. Therefore **every overdue card's interval will change after migration**. This is the feature working for the first time, not an FSRS regression. Do not "fix" it.

---

## B. Locked decisions

These are settled. Do not re-open, re-litigate, or silently deviate. If implementation reveals one is impossible, stop and report rather than substituting.

### B1. FSRS parameters

| Parameter | Value | Exposed to user? |
|---|---|---|
| `enable_short_term` | `false` | No. Hardcoded |
| `learning_steps` | `[]` | No. Hardcoded |
| `relearning_steps` | `[]` | No. Hardcoded |
| `enable_fuzz` | `false` | **No. Hardcoded, and it must not appear in settings, settings UI, or `PluginData`.** Jitter is the load balancer's domain |
| `request_retention` | default `0.9` | **Yes.** Slider, range `0.70`–`0.99` |
| `maximum_interval` | from existing `settings.maximumInterval` | Yes, existing key and slider, 1:1 mapping, no rename |
| `w` | ts-fsrs defaults | **No. Never rendered.** A "Reset to FSRS defaults" action row is the only affordance |

`enable_short_term: false` selects `LongTermScheduler`, which forces every outcome including `Again` into `State.Review` with a ≥1-day interval. Consequences relied upon throughout this plan: day granularity survives, `State.Learning`/`State.Relearning` never occur, `scheduled_days >= 1` always, `textInterval` keeps working.

### B2. Rating contract (D1)

- **The first answer on a face writes. Nothing else in that session does.**
- `Again` writes `Rating.Again` immediately.
- The in-session reshuffle remains, as pure drill, with no second write.
- **Deleted:** the post-Again `OK` button, `renderPostAgainButtons`, `handleReset`, `WriteIntent.kind === "reset"`, `cardGetResetSchedule`, `settings.lapsesIntervalChange`, and the hardcoded `"1d"` preview string.
- Lapse severity comes from FSRS, which floors stability at `S / e^(w17*w18)` rather than collapsing to 1 day.
- Button set stays **three**: `Again` / `Okay` / `Good` on keys 1/2/3. `Rating.Easy` is deliberately not exposed. Adding it later is one `renderResponseButton` call plus one `addKey`; do not pre-build for it.
- **Preview rule, applies everywhere:** an interval preview is rendered if and only if a write will occur. The re-drill therefore shows three bare buttons.

### B3. Learn taxonomy (D2, D3)

- Maturity: `min stability across faces >= 21`. **Not** `scheduled_days`.
- Anchor floor: `min stability across faces >= 12`. Same quantity as maturity, preserving the 12/21 overlap band and invariant 33.
- **Preserve the min-across-faces rule** (`pool.ts:26-32`): a card is only as mature as its weaker direction. This is a pedagogical decision, absent from EF.md, and easy to lose.
- Due ranking: `fsrs.get_retrievability(card, now, false)`, **ascending** (lowest recall probability first). Replaces `overdueRatio` entirely.
- Tie-break and `youngFiller` ordering: `difficulty` **descending**. ⚠️ Sign flip from ease. Low ease = shaky = **high** difficulty.

### B4. Persistence format

```
<!--SR:!<due>,<stability>,<difficulty>,<reps>,<lapses>,<state>,<last_review>!<same for back face>-->
```

- Seven fields per segment. Positional. Front = segment 0, back = segment 1.
- `elapsed_days` and `scheduled_days` are **recomputed at load**, never stored.
- Per-card `learning_steps` is always `0` under B1 and is not stored.
- **`parseFloat`, never `parseInt`.** `stability` and `difficulty` are fractional; `parseInt` would destroy them.
- The `<!--SR:` prefix, `!` segment delimiter and `,` field delimiter are **unchanged** so all eleven existing regexes keep working (§C2).
- Parser is **FSRS-only**. No dual-format runtime path, no legacy branch in the hot path.

### B5. Converter

- A standalone, explicitly invoked command. **Not** a load-time hook.
- Reads two legacy shapes: upstream OSR single-segment `<!--SR:!2024-01-02,25,249-->` (front seeded, back left New) and EF two-segment `<!--SR:!2026-09-26,5,203!2026-09-30,6,223-->`.
- Dummy date `2000-01-01` in a slot means that face is New.
- Seeding: `stability = interval`, `difficulty` from a linear map of `ease [130,350] → [10,1]`, `last_review = due − interval days`, `state = Review`, `reps = 0`, `lapses = 0`.
- **No stability floor. No special handling for recently-lapsed cards.** A card sitting at `interval = 1` migrates as low-retention. This is intentional and honest.
- Dry-run count first, then a loud one-way confirmation.
- **Rebuild the histogram from the converted data** once conversion completes.

### B6. Load balancing (D4)

- Kept. The histogram owns all jitter.
- `HistogramStore` and its increment/decrement/rebuild lifecycle survive largely intact.
- `findLeastUsedIntervalOverRange` is re-pointed at the returned `due: Date` rather than an interval in days.
- Mutating `due` post hoc is safe: the scheduler reads `last_review`, not `due`.
- `enable_fuzz` stays `false` so there is exactly one source of jitter and the seeded-`rng` test seam stays authoritative.

### B7. `startOfDay`

Currently inert: `setDayBoundary()` has zero call sites, so `today` is always literal midnight. **Build it for real** in Phase 6. It is a new feature, not a port. Until then, note its status in EF.md.

### B8. `overdueRatio` zero-division

**No guard will be added.** Resolved twice over: `enable_short_term: false` guarantees `scheduled_days >= 1`, and D3 deletes the function outright. Recorded here so it is not re-introduced as a "fix".

---

## C. Guardrails

### C1. Never break these

| Guardrail | Why |
|---|---|
| `src/settings/index.ts` stays free of `obsidian` imports | Tests import it (EF.md invariant 1) |
| SR comment is always the card's **single last line** | `withUpdatedSchedules` returns `[...textLines, comment]`. The line-delta and `shiftLocationsForDelta` machinery depends on exactly one line. **Never soft-wrap, never emit one line per face** |
| Positional front = 0 / back = 1 | SR segments, `ParsedCard.schedules`, and `src/utils/face.ts` all share this contract |
| No `element.style.*` writes, property or method form | Marketplace linter `obsidianmd/no-static-styles-assignment`. Use `setCssStyles` / `setCssProps` / classes. Verify with `grep -rn "\.style\." src/ --include="*.ts"` |
| Animation hooks on every new UI surface | `applyAnimationDuration`, `staggerIn`, `fadeOutThen`, `renderResponseButton` |
| One renderer per shared surface | EF.md invariant 29 |
| `PluginData` deletions require a migration | EF.md invariant 11. Phase 1 introduces the `dataVersion` machinery that makes later deletions legal |

### C2. The eleven regexes

The literal `<!--SR:!` sentinel is hand-inlined in eleven places across seven files. B4 keeps the sentinel precisely so these need no change. **If anyone proposes altering the wrapper, all eleven must change together.** A missed one does not error; it silently reads as *"all my cards became new."*

`src/scheduling/constants.ts:10` · `src/persistence/comment-parser.ts:20,65,73` · `src/parsing/card-parser.ts:41,42,43` · `src/scheduling/histogram-store.ts:9` · `src/decks/deck-tree.ts:37,38` · `src/ui/review/index.ts:59` · `src/ui/learn/index.ts:32` (plus raw prefix checks at `review/index.ts:63`, `learn/index.ts:36`).

### C3. Silent-failure landmines

| Landmine | Detail |
|---|---|
| **`worstOf` polarity** | `ReviewResponse` is `Easy=0…Again=3`; FSRS `Rating` is `Again=1…Easy=4`. **`Hard=2` in both**, so a naive swap inverts three of four values while `Hard` keeps working. Guarded only by `group-state.test.ts:100` — migrate that test, never delete it |
| **Difficulty sign flip** | B3. Reversed, the engine prioritises the user's *easiest* cards and no test catches it |
| **Invariant 33 sampler properties** | The 4× clamp, the ±0.35 per-draw jitter, session-wide `0.5^seen` damping, and the sub-maturity pool floor are properties of the *sampler*, not of SM-2. Transfer verbatim. A bare `1/x` weight was tried and rejected. Guarded by `sentence-planner.test.ts:210-238` (600 draws, `max share < 0.45`) — preserve that test |
| **Migration ordering** | The `PluginData` migration must run **before** `new HistogramStore(this.data.histogram)` (`main.ts:41`), which captures the object by reference. No compile-time protection |
| **Nested mutable defaults** | `loadData_`'s `Object.assign` is two levels deep and `DEFAULT_DATA.histogram` is a shared literal. Any new nested mutable key needs the same defensive clone |
| **`deck-tree` silent under-count** | It delegates parsing to `comment-parser`. If the due date stops being field 0, cards vanish from Due/New while Total stays correct. Add an explicit test |

### C4. Accepted, disclosed

`ts-fsrs` assigns `scheduler`, `diff`, `format`, `dueFormat` onto `Date.prototype` at import time (`src/help.ts`, re-exported by `src/index.ts:7`). Nothing in the library uses them; they are deprecated and slated for removal in FSRS 6.0.0. The `exports` map declares only `"."`, so deep imports cannot avoid it, and there is no `sideEffects: false`. **Decision: accept it, and disclose it in the Community Plugin submission notes.** Do not vendor the source to work around it.

### C5. Test policy

Tests are updated **within the phase that changes the behaviour**, never deferred to a cleanup phase. Every phase exits green.

Write the replacement for `src/learn/test-helpers.ts:10` (`sched()`) **first, in Phase 3**. Every Learn fixture flows through that one function; a good FSRS replacement turns ~29 mechanical updates into a single-file change.

---

## D. Files that must not change

Verified free of scheduling coupling. If a diff touches these, something has gone wrong.

`src/ui/shared/sentence-renderer/index.ts` · `word-row.ts` · `deposit.ts` · `src/ui/modal-utils.ts` · `src/ui/shared/construction-constraints.ts` · `src/ui/edit-card/index.ts` · `src/ui/explorer/index.ts` · `src/utils/shuffle.ts` · `src/utils/queue.ts` · `src/utils/face.ts` · `src/utils/deposit-text.ts` · `src/learn/group-builder.ts` · `src/learn/carryover.ts`

`src/ui/shared/response-button.ts` changes only if a button's *shape* changes; it renders whatever interval string it is handed.

---

# PHASE 1 — Pre-FSRS hardening

**Goal.** Fix real bugs and remove dead weight while the SM-2 engine is still in place. No `ts-fsrs` dependency. Every change here is independently valuable and independently revertible.

**Precondition.** Clean working tree, 170 tests green.

| ID | Task | Files |
|---|---|---|
| P1.1 | **Fix `writtenFaces` identity bug.** Re-key from `` `${filePath}|${startLine}|${faceIndex}` `` to `ParsedCard` identity + `faceIndex` (e.g. `Map<ParsedCard, Set<0\|1>>`). `startLine` is mutated by `shiftLocationsForDelta`, so the current key moves and the no-double-write gate fails open | `src/learn/session.ts` (`faceKey`, `shouldWrite`, `confirmWritten`) |
| P1.2 | **`parseInt` → `parseFloat`** in `parseSegment`. Fixes existing fractional-interval truncation when `loadBalance` is off, and is mandatory before FSRS floats land | `src/persistence/comment-parser.ts:32` |
| P1.3 | **Introduce `dataVersion`.** Add the key to `PluginData`, write the migration runner, and place the call **before** `new HistogramStore(...)` at `main.ts:41`. Ship it with a no-op v1→v2 step so the ordering and the plumbing are proven before anything depends on them | `src/main.ts` |
| P1.4 | **Remove `easyBonus`.** Delete the setting, its settings-tab row, the `ReviewResponse.Easy` branch in `osrSchedule`, and the two tests that reach it. Delete the `PluginData` key via the P1.3 migration | `src/settings/index.ts`, `settings-tab.ts`, `src/scheduling/osr.ts`, `scheduling.test.ts` |
| P1.5 | **Delete dead state.** `ReviewResponse.Reset` · `MULTI_SCHEDULING_EXTRACTOR` · `buryDate` / `buryList` (via migration) · `RepItemScheduleInfoOsr.isDue` · `setupStaticDateProvider20230906` · `DueDateHistogram.dueNowNDays` and `dueNotesCount` | `review-response.ts`, `constants.ts`, `main.ts`, `osr.ts`, `dates.ts`, `due-date-histogram.ts` |
| P1.6 | **Rename Cram's "Easy" to "Got it".** It writes nothing (`handleCramEasy`); once `Easy` becomes a real FSRS rating word the label is actively misleading. Cram stays non-writing | `src/ui/review/index.ts:297` |
| P1.7 | **Correct EF.md.** Version 1.3.1 → 1.4.1 · test count → measured · settings-tab order → actual `getSettingDefinitions()` order · `learnGroupsPerSession` range 1–10 → 1–5 · record that `startOfDay` is inert and scheduled for implementation · fix invariant 22's wording (`writeEligible` is fixed **per group** at `beginNextGroup`, reading live schedules, not at session load) | `EF.md` |
| P1.8 | Update and extend tests for all of the above. Add a regression test for P1.1 | co-located `*.test.ts` |

**Do not** fix the `delayDays` sign inversion here. The entire mechanism is deleted in Phase 3; do not repair what you are about to remove.

**Exit criteria.**
- `npm test` green, `tsc` clean.
- `grep -rn "easyBonus\|MULTI_SCHEDULING_EXTRACTOR\|buryDate\|ReviewResponse.Reset" src/` returns nothing.
- A card written in Learn, followed by a line-count-changing write to a card above it in the same file, is provably not written twice.
- `data.json` from a 1.4.1 install loads, migrates to `dataVersion: 2`, and loses no live key.

---

# PHASE 2 — Dependency and scheduling engine

**Goal.** `ts-fsrs` becomes a real dependency and a working, tested FSRS engine module exists. **Nothing consumes it yet.** The plugin still schedules with SM-2 and still passes every test.

**Precondition.** Phase 1 complete.

| ID | Task | Files |
|---|---|---|
| P2.1 | `npm install ts-fsrs@5.4.2` as a **runtime `dependency`** — the plugin's first. Confirm esbuild bundles it (it is not in the externals list and must not be added). Record the `main.js` size delta | `package.json` |
| P2.2 | Confirm `/ts-fsrs` stays gitignored and that nothing in `src/` or `tsconfig.json` paths into it | `.gitignore`, `tsconfig.json` |
| P2.3 | **Create `src/scheduling/fsrs.ts`.** The single wrapper around ts-fsrs. Owns parameter construction per B1, exposes `schedule(card, rating, now)`, `previewAll(card, now)` (one `repeat()` returning all four grades), `retrievability(card, now)`, and `emptyCard()`. **No other module may import `ts-fsrs` directly** | new file |
| P2.4 | **Add `request_retention`.** Slider `0.70`–`0.99`, step `0.01`, default `0.9`, in the Scheduling group. Seed it in the P1.3 migration | `src/settings/index.ts`, `settings-tab.ts` |
| P2.5 | **Do not add `enable_fuzz`** to settings or `PluginData`. Hardcode `false` in P2.3 | — |
| P2.6 | Add a "Reset FSRS parameters to defaults" action row | `settings-tab.ts` |
| P2.7 | Unit-test `src/scheduling/fsrs.ts` in isolation: parameter construction, the four ratings from a known card, retrievability, and that `enable_short_term: false` never yields `State.Learning`/`Relearning` or `scheduled_days < 1` | new `fsrs.test.ts` |

**Exit criteria.**
- `npm test` green (new tests added, none broken), `tsc` clean.
- `npm run build` succeeds; bundle size delta recorded.
- The plugin still schedules identically to Phase 1 — the engine is live but unwired.
- `grep -rn "from \"ts-fsrs\"" src/` matches **only** `src/scheduling/fsrs.ts`.

---

# PHASE 3 — Data model and persistence

**Goal.** Replace the card state type and the on-disk format. This is the largest single phase; changing `ScheduleInfo` makes `tsc` enumerate every consumer.

**Precondition.** Phase 2 complete.

| ID | Task | Files |
|---|---|---|
| P3.1 | **Rewrite `src/learn/test-helpers.ts` `sched()` first.** New signature seeds FSRS state with sensible defaults. Do this before touching fixtures | `src/learn/test-helpers.ts` |
| P3.2 | **Redefine `ScheduleInfo`** as FSRS card state: `due: Date`, `stability`, `difficulty`, `reps`, `lapses`, `state`, `last_review: Date \| null`. `Moment` leaves the type | `src/scheduling/` |
| P3.3 | **Rewrite `comment-parser.ts`** to B4. Parse and write the seven-field format, `parseFloat` throughout. Recompute `elapsed_days` / `scheduled_days` at load. Keep the wrapper, delimiters and positional contract exactly | `src/persistence/comment-parser.ts` |
| P3.4 | **Rewrite `due.ts`.** Two lines, and the highest-leverage change in the migration: it is the shared definition of "due" for both modes. Compare against `now`, not midnight | `src/scheduling/due.ts` |
| P3.5 | **Reshape `session-helpers.ts`.** `previewInterval(schedule, response)` → `previewAll(card, now)` returning a grade-keyed record from one `repeat()`. This also closes an existing bug where the previewed interval and the written interval could disagree because each re-snapshotted the histogram independently. Funnel every write through here; the reset path currently bypasses the seam | `src/scheduling/session-helpers.ts` |
| P3.6 | **Delete `src/scheduling/osr.ts`** and `scheduling.test.ts`'s SM-2 arithmetic suite. `delayDays` dies here; `elapsed_days` takes over inside ts-fsrs | `src/scheduling/osr.ts` |
| P3.7 | Fix the mechanical fallout across `card-parser.ts`, `write-schedule.ts`, `histogram-store.ts`, `deck-tree.ts`. `withUpdatedSchedules`' `baseEase` parameter becomes vestigial — remove it | various |
| P3.8 | Shrink `dates.ts`: `moment` leaves the scheduling core. Keep multi-format legacy date parsing **only** where Phase 5's converter will need it | `src/scheduling/dates.ts` |
| P3.9 | Rewrite `comment-parser.test.ts`, `card-parser.test.ts`, and the affected `decks.test.ts` fixture. Add the `deck-tree` due/new regression test from C3 | tests |

**Exit criteria.**
- `npm test` green, `tsc` clean.
- A card round-trips: write → read → identical FSRS state, floats preserved to ≥2 dp.
- `withUpdatedSchedules` still emits exactly one trailing SR line; line deltas unchanged.
- All eleven regexes still match (C2).

---

# PHASE 4 — Behaviour: Learn engine, rating contract, UI

**Goal.** The pedagogy moves onto FSRS quantities and the B2 rating contract ships.

**Precondition.** Phase 3 complete.

| ID | Task | Files |
|---|---|---|
| P4.1 | **`classifyPools` predicates.** `hasNew` → `state === State.New`. Maturity → `min stability >= 21`. Anchor floor → `min stability >= 12`. **Keep min-across-faces.** Delete `minSeenEase` and `overdueRatio` | `src/learn/pool.ts` |
| P4.2 | **Due ranking → retrievability ascending**; tie-break and `youngFiller` order → `difficulty` **descending**. ⚠️ Verify the sign with an explicit test asserting the *hardest* card ranks first | `src/learn/pool.ts` |
| P4.3 | **Anchor weight → stability.** Rename `LEARN_ANCHOR_REF_DAYS` to reflect stability. **Transfer the clamp, jitter and `0.5^seen` damping verbatim** (C3) | `src/learn/sentence-planner.ts`, `constants.ts` |
| P4.4 | **`worstOf` polarity.** Whether `ReviewResponse` is replaced by `Rating` or kept as an internal enum, prove the ordering explicitly. Migrate `group-state.test.ts:100` | `src/learn/group-state.ts` |
| P4.5 | **Implement B2 in the session.** `Again` produces a write intent; `WriteIntent.kind === "reset"` is deleted; the first answer per face writes and subsequent in-session answers do not | `src/learn/session.ts` |
| P4.6 | **Rewrite the button sets.** Three buttons everywhere in Review and Learn. Delete `renderPostAgainButtons`, `handleReset`, the `"1d"` string. The re-drill shows the same three buttons with **no previews** | `src/ui/review/index.ts`, `src/ui/learn/index.ts` |
| P4.7 | **Previews from one `previewAll` call.** Apply the B2 rule: preview iff a write will occur | both modals |
| P4.8 | `wasNew` becomes `state === State.New`. Keep `againCount` / `wasNew` as the primary fragility signal — **do not** replace them with `difficulty`; the sentence planner's purpose is session-local consolidation | `src/learn/group-state.ts`, `sentence-planner.ts` |
| P4.9 | Rewrite `pool.test.ts`; re-fixture `sentence-planner.test.ts` and `session.test.ts`. **Preserve the invariant-33 spread test** (C3). Rewrite `session.test.ts:73` properly against the P1.1 identity key rather than porting it | tests |

**Exit criteria.**
- `npm test` green, `tsc` clean.
- A manual Learn session: `Again` writes once and increments `lapses`; the re-drill writes nothing; a second same-day session on the same deck produces zero writes.
- Anchor draws over 600 samples still satisfy `max share < 0.45`, `min share > 0.05`.

---

# PHASE 5 — Load balancing and the one-time converter

**Goal.** Load balancing works against FSRS output, and existing vaults can be converted.

**Precondition.** Phase 4 complete.

| ID | Task | Files |
|---|---|---|
| P5.1 | **Re-point the histogram.** `findLeastUsedIntervalOverRange` operates on the returned `due: Date`. Keep the scan logic (nearest empty day, earlier-wins tie-break) intact | `due-date-histogram.ts`, `histogram-store.ts` |
| P5.2 | Confirm `enable_fuzz` remains `false` and that the histogram is the sole jitter source | `src/scheduling/fsrs.ts` |
| P5.3 | **Build the converter command.** Its own self-contained legacy parser per B5. Handles single-segment, two-segment, and dummy-date slots | new `src/migration/` |
| P5.4 | Dry-run pass reporting card and file counts before any write. Explicit one-way confirmation | new |
| P5.5 | Convert, writing through the existing `writeCardBack` path so `fileCache` semantics hold | new |
| P5.6 | **Rebuild the histogram from converted data** on completion | `histogram-store.ts` |
| P5.7 | Tests: both legacy shapes, dummy-date handling, the `ease → difficulty` map at boundaries (130 and 350), idempotency, and that already-FSRS comments are left untouched | new `*.test.ts` |

**Exit criteria.**
- `npm test` green, `tsc` clean.
- A backup copy of a real 1.4.1 vault converts with zero parse failures and zero data loss outside the documented `reps`/`lapses` loss.
- Running the converter twice is a no-op the second time.
- Load balancing measurably spreads due dates (assert on a synthetic clustered histogram).

---

# PHASE 6 — `startOfDay`

**Goal.** Implement the day-boundary feature that has never worked.

**Precondition.** Phase 5 complete. Deferrable — nothing else depends on it.

| ID | Task | Files |
|---|---|---|
| P6.1 | Wire `settings.startOfDay` through to `globalDateProvider.setDayBoundary()`. It currently has **zero call sites** | `src/main.ts`, `settings-tab.ts` |
| P6.2 | Make `StaticDateProvider` honour the boundary so the feature is testable at all — it currently stores the field and ignores it | `src/scheduling/dates.ts` |
| P6.3 | Reconcile the boundary with B1's day granularity and with `due.ts`'s `now` comparison | `src/scheduling/due.ts` |
| P6.4 | Tests across the boundary, including the before-cutoff previous-day case | new tests |
| P6.5 | Document in EF.md as implemented | `EF.md` |

**Exit criteria.** With `startOfDay = "04:00:00"`, a review at 02:00 resolves to the previous day and cards due "today" behave accordingly. Tested, not just observed.

---

# PHASE 7 — Closing scan

**Goal.** Prove nothing was missed. No new functionality.

| ID | Check |
|---|---|
| P7.1 | `grep -rn "\.style\." src/ --include="*.ts"` — zero hits outside comments |
| P7.2 | `grep -rn "from \"ts-fsrs\"" src/` — only `src/scheduling/fsrs.ts` |
| P7.3 | `grep -rni "ease\|osr\|interval.*change\|lapsesInterval" src/` — no surviving SM-2 concepts outside the converter's legacy parser |
| P7.4 | All eleven `<!--SR:!` regexes still present and consistent (C2) |
| P7.5 | `npm test` green; every previously-existing behaviour has a test or a documented deletion. Reconcile the final count against the 170 baseline and explain the delta |
| P7.6 | `npm run build` clean; record final `main.js` size |
| P7.7 | Manual pass on **desktop and iOS**: Review, Cram, Learn (face + sentence steps), Conjure Sentences, Explorer, edit-card, deposit bar |
| P7.8 | Animation audit: initial batch animates once, subsequent interactions carry no mobile preroll, `:active` press feedback survives (the `animation-fill-mode: backwards` invariant) |
| P7.9 | **EF.md rewrite.** §0 and §10 both state FSRS was rejected — both must change. §1, §2, §4, §5, §6, §7, §8 need edits. Invariant 19 retires. New invariants: `w` is never rendered; `enable_fuzz` stays false and the histogram owns jitter; the first answer per face writes; maturity is stability-based |
| P7.10 | Delete `FSRS_MIGRATION.md` and this file, or fold both into EF.md |
| P7.11 | Version bump, `versions.json` entry, and a release note disclosing the first third-party runtime dependency and its `Date.prototype` side effect (C4) |

---

## E. Phase dependency graph

```
P1 (bugs, dead code, dataVersion)
 └─> P2 (ts-fsrs dep + engine module, unwired)
      └─> P3 (ScheduleInfo + comment format + due + session-helpers; delete osr.ts)
           └─> P4 (Learn predicates, rating contract, buttons)
                └─> P5 (load balancing re-point + converter)
                     ├─> P6 (startOfDay)        [deferrable]
                     └─> P7 (closing scan)
```

P1 and P2 are independently shippable. P3 and P4 should land together in a user-facing release: between them the plugin reads the new format but still carries old pedagogy.
