# FSRS Progress — Euphoric Flashcards

Companion to `FSRS_IMPLEMENTATION_PLAN.md`. That file holds the work to do; this one records what is done, what was learned doing it, and what the next agent must not re-derive. The plan still wins on intent; this file wins on current state.

**Status: Phases 1–5 complete. Phase 6 (`startOfDay`) is next, then Phase 7 (closing scan).**

| | Baseline | After P1 | After P2 | After P3 | After P4 | After P5 |
|---|---|---|---|---|---|---|
| Tests | 170 / 11 files | 183 / 12 | 237 / 13 | 284 / 14 | 302 / 14 | **373 / 17** |
| `tsc --noEmit --skipLibCheck` | clean | clean | clean | clean | clean | clean |
| `npm run build` | clean | clean | clean | clean | clean | clean |
| `main.js` | 125,913 B | 126,681 B | 128,473 B | 191,203 B | 190,465 B | **199,498 B** |
| `dataVersion` | — | 2 | 3 | 3 | 4 | **4** |

The `main.js` jump of **+62,730 B** is ts-fsrs entering the bundle for the first
time, and it lands within 2 KB of the 60,929 B the Phase 2 probe predicted. Phase
2's tree-shaking is over: the engine is wired.

---

## PHASE 1 — Pre-FSRS hardening ✅

Committed as `36e5426`.

- **P1.1** `writtenFaces` re-keyed from `` `${filePath}|${startLine}|${faceIndex}` `` to `Map<ParsedCard, Set<0|1>>`; `faceKey` deleted. The old key moved whenever `shiftLocationsForDelta` mutated `startLine`, so the no-double-write gate failed open.
- **P1.2** `parseSegment` uses `parseFloat` for interval *and* ease.
- **P1.3** New `src/persistence/plugin-data.ts`: `PluginData`, `DEFAULT_DATA`, `CURRENT_DATA_VERSION`, `migratePluginData`. Kept out of `main.ts` so it is testable without the `obsidian` import. Called in `onload` between `loadData_()` and `new HistogramStore(...)`.
- **P1.4** `easyBonus` deleted from settings, defaults, the tab, restore-defaults, and `osrSchedule`.
- **P1.5** Deleted `ReviewResponse.Reset`, `MULTI_SCHEDULING_EXTRACTOR`, `buryDate`/`buryList`, `isDue`, `setupStaticDateProvider20230906`, `dueNowNDays`, `dueNotesCount`.
- **P1.6** Cram's second button is now **"Got it"**.
- **P1.7** EF.md corrected (see *EF.md deltas* below).
- **P1.8** Tests added; the two upstream `Easy` cases removed.

### Decisions taken in Phase 1

- **`ReviewResponse.Easy` was kept as enum member `0`** even though nothing emits it. Deleting it would shift `Good`/`Hard`/`Again` down and break `worstOf`'s ordering — and C3's warning that `Hard = 2` in both enums. Only the `osrSchedule` branch went.
- **The v1→v2 migration step is not a no-op.** P1.3 says to ship one, but P1.4/P1.5 say to delete their keys "via the P1.3 migration" and the exit criterion demands `dataVersion: 2`. Those cannot all hold with a no-op v2, so v1→v2 performs the deletions.

### Bug found that the plan did not list

`loadData_`'s `Object.assign({}, DEFAULT_DATA, saved)` would have handed every pre-existing install `dataVersion: 2` before the runner saw it, silently skipping all migrations forever. `loadData_` now forces `dataVersion = 1` when the saved object lacks the key; a fresh install (`saved === null`) stays current and never migrates. Both paths tested. Same class of hazard as C3's migration-ordering landmine, equally invisible to `tsc`.

### Verification worth keeping

The P1.1 regression test was proven to catch the bug: reverting to the positional key makes it fail with `expected { kind: 'graded', response: 1 } to be null` — a real second write.

---

## PHASE 2 — Dependency and scheduling engine ✅

Committed as `b417a50`.

- **P2.1** `ts-fsrs` installed as the first runtime `dependency`, **pinned exactly to `5.4.2`** (no caret). Not in esbuild's externals.
- **P2.2** reference clone confirmed isolated — see *The reference clone* below.
- **P2.3** `src/scheduling/fsrs.ts` — the sole `ts-fsrs` boundary. `buildFsrsParameters`, `FsrsEngine.{schedule, previewAll, retrievability}`, `emptyCard`, `fsrsDefaultWeights`, re-exported `Rating`/`State`/`Card`/`Grade`, `FSRS_GRADES`.
- **P2.4** `requestRetention` (default `0.9`); "Target retention" slider `0.70–0.99` step `0.01` in the Scheduling group; seeded by a v2→v3 migration step.
- **P2.5** `enable_fuzz` hardcoded `false`. Absent from settings and `PluginData`.
- **P2.6** "Reset FSRS parameters to defaults" action row (resets `requestRetention` and `maximumInterval`; the weights `w` are not stored, not rendered, not resettable).
- **P2.7** `src/scheduling/fsrs.test.ts`, 43 tests.

### Decisions taken in Phase 2

- **`fsrs.ts` is deliberately NOT re-exported from `src/scheduling/index.ts`.** The barrel is imported by modules that only want constants; re-exporting would drag `ts-fsrs` into their graph. Phase 3 consumers import `src/scheduling/fsrs` directly.
- **`REQUEST_RETENTION_MIN`/`MAX`/`STEP` live in `src/settings/index.ts`**, not the engine, so the settings tab and the data migration reach them without importing `ts-fsrs`.
- **`buildFsrsParameters` clamps defensively** — `requestRetention` into range (non-finite → min), `maximum_interval` floored at 1 — so a hand-edited `data.json` cannot skew or throw inside the scheduler at review time.
- **The v2→v3 step is not redundant.** `Object.assign` already supplies an absent key; the step exists for a key that is *present but unusable* (`null`, a string, `NaN`, out of range).
- **Exact pin, not `^5.4.2`.** ts-fsrs ships FSRS weight changes in minor releases; a floating range would silently reschedule every user's cards on a fresh install. `5.4.2` is the newest **stable** (`latest` dist-tag); everything newer is a `6.0.0-beta.x` prerelease. `fsrs.test.ts` pins concrete intervals so a deliberate bump surfaces as a failure.

### B1 verified empirically, not assumed

`enable_short_term: false` was checked against the real library over 440+ transitions across all four grades, 40 consecutive `Again`s, and 10 `Again`s at the same instant:

- no `State.Learning` / `State.Relearning`, ever
- every outcome from a New card lands in `State.Review`, `Again` included
- `scheduled_days >= 1` everywhere
- `learning_steps` always `0`, so the field never needs persisting
- stability floors rather than collapsing to zero on repeated failure

All of these are now permanent tests, not one-off probes.

---

## Findings that change later phases

**1. `maximum_interval` is a soft ceiling.** `LongTermScheduler.next_interval` clamps each grade to `maximum_interval`, then enforces `again < hard < good < easy` by bumping each past the previous. Saturated, the grades land on `max`, `max+1`, `max+2`, `max+3`. With B2's three buttons the worst real overshoot is `Good = max+2`. **Do not clamp it away** — that destroys the ordering the previews depend on. The `maximumInterval` row still promises "Cards will not be scheduled beyond this many days", true under SM-2 and false once FSRS owns scheduling. → **plan amended: P3.10.**

**2. `get_retrievability` returns exactly `0` for `State.New`.** In an ascending sort that is the *most urgent* slot, so a New face leaking into the due ranking silently jumps the queue. Asserted at the engine level in `fsrs.test.ts`; the pool-level assertion is → **plan amended: P4.2b.**

**3. `date_diff(..., 'days')` floors.** Ties are therefore common, so P4.2's `difficulty`-descending tie-break is load-bearing, not incidental — and P4.2b's test asserts that two same-day, same-stability faces return *byte-identical* retrievability (`toBe`, not `toBeCloseTo`).

> **Superseded mechanism, conclusion unchanged.** As measured in Phase 2 this floored from the `last_review` *instant*, so ties fell inside a rolling 24-hour window that straddled midnight. Phase 3 stores `last_review` as a calendar date (per B4/B5), so the flooring now runs from local midnight and ties land on calendar-day boundaries instead. Ties became *more* common, not less.

**4. FSRS does not count a failed New card as a lapse.** `Again` on `State.New` gives `lapses: 0`; only a `State.Review` card increments. **Phase 4's exit criterion "`Again` writes once and increments `lapses`" must be checked against a learned card**, or it fails for the wrong reason.

**5. Bundle size is not yet informative.** `main.js` at 128,473 B contains **no ts-fsrs** — esbuild tree-shakes `fsrs.ts` because nothing in `main.ts`'s graph imports it, which is exactly P2's "live but unwired". Measured separately with a probe entry that does import the wrapper: esbuild bundles `node_modules/ts-fsrs/dist/index.mjs`, and **ts-fsrs alone costs 60,929 B unminified**. Expect `main.js` to jump by roughly that in Phase 3. The production build is unminified, so that is close to the real cost.

---

## The reference clone

`/reference_only_ts-fsrs` is a gitignored reference clone of the upstream monorepo (`.gitignore:39-40`). It is read, never imported.

> **On the rename.** The plan's §A and P2.2 still call this `/ts-fsrs`. The rename escaped `.gitignore`'s root-anchored `/ts-fsrs` entry, which briefly exposed 233 third-party files to `git add -A`; both names are ignored now. If it is ever renamed again, add the new name there — nothing else in the project references the directory, so a missed entry fails silently and only as a bloated commit.

Verified:

- `require.resolve("ts-fsrs")` → `node_modules/ts-fsrs/dist/index.cjs`
- `node_modules/ts-fsrs` is a real directory, **not** a symlink to the clone
- it is the published tarball — `dist/` present, no `src/`; the clone's root is `ts-fsrs-monorepo@0.0.0`, `private: true`
- `tsc --traceResolution` → `node_modules/ts-fsrs/dist/index.d.ts`, Package ID `@5.4.2`
- esbuild metafile → `node_modules/ts-fsrs/dist/index.mjs`
- `tsconfig` paths are only `{"src/*": ["./src/*"]}`
- **the clone was moved out of the repo entirely** and `tsc`, the full suite and a production build all stayed clean with a byte-identical `main.js`

---

## Plan amendments

Added to `FSRS_IMPLEMENTATION_PLAN.md`:

- **P3.10** — reword the `maximumInterval` setting description when FSRS takes over scheduling (finding 1). ✅ done in Phase 3.
- **P4.2b** — assert New faces never enter the retrievability ranking (finding 2), plus the flooring note (finding 3).

Phase 3 additions:

- **P4.0 (new, Phase 4's first task)** ✅ done — delete `baseEase`, `defaultIntervalChange`
  and `lapsesIntervalChange`: the three `PluginData` keys, their three settings
  rows, and their three lines in "Restore Default Settings", via a v3→v4 migration
  step. All three have had zero consumers since `osr.ts` was deleted. B2 only names
  `lapsesIntervalChange`; the other two fell out of the same deletion.
- **P7.3 amendment** — the grep for surviving SM-2 concepts will also hit prose in
  comments that deliberately explain what was replaced (`fsrs.ts`'s ScheduleInfo
  note, both modals' reset-path notes). Those are documentation, not residue.
- **P5.3 note** — the converter's legacy parser can use `parseLegacyDate` from
  `src/scheduling/dates.ts`, which already handles all three
  `ALLOWED_DATE_FORMATS` shapes without `moment`. It was kept for exactly this.

---

## EF.md deltas

Corrected in P1.7 and kept current through Phase 2. Version was already `1.4.1`, so that item was moot.

- **Invariant 22 was wrong on both halves.** `writeEligible` is fixed per **group** at `beginNextGroup`, not once at session load, and its predicate reads `card.schedules[faceIndex]` **live** — so a card written in group 1 and reappearing in group 3 is correctly re-evaluated. Rewritten, with the identity-key requirement folded in.
- **The settings-tab order was wrong in four ways.** There is no "Review" group (`showIntervalOnButtons`/`showKeybindingsOnDesktop` are in Appearance); Appearance is **last**, below Load Balancing, not above; it has three controls, not one; `defaultCardSide` has no settings row at all. Actual order: Resources → Decks → Card Types → Learn → Conjure Sentences → Construction Constraints → Scheduling → Load Balancing → Appearance.
- Test counts, the `easyBonus` formula in §4, the `PluginData` shape and both migration steps in §7, `learnGroupsPerSession` 1–10 → 1–5, `startOfDay`'s inert status, the `Reset` enum member, `fsrs.ts` and `plugin-data.ts` in §2, the Cram label, and §8's first-runtime-dependency note with the exact-pin rationale and the `Date.prototype` disclosure.

**Resolved ahead of P7.9.** §0 and §10 were rewritten and now state that FSRS ships; `FSRS_MIGRATION.md` was archived into the gitignored `old_md_files/`. P7.9's remaining job is the stale-passage list below, not the rejection text. Invariant 10 was also corrected on 2026-10-02: it claimed load balancing was "fully wired end-to-end", which contradicted §4.8: it is bookkeeping only until P5.1.

### Newly stale after Phase 3 — all for P7.9

Phase 3 changed enough of the architecture that these EF.md passages are now
actively wrong rather than merely incomplete. Listed so P7.9 does not have to
rediscover them:

- **The data model.** Anything describing `interval` + `ease`, `RepItemScheduleInfoOsr`,
  or the three-field SR comment. The format is seven fields and documented at the
  top of `comment-parser.ts`.
- **§2's module list.** `src/scheduling/osr.ts` is gone; `interval-text.ts`,
  `session-helpers.test.ts` and `src/scheduling/fsrs.ts`'s expanded role are new.
  `ScheduleInfo` moved from `src/persistence` to `src/scheduling/fsrs`.
- **Invariant 19** retires as planned (it concerns SM-2 ease).
- **Any claim that `moment` is used.** It is out of `src/` entirely; `dates.ts` no
  longer imports `obsidian` either.
- **The settings-tab inventory.** The `maximumInterval` description changed (P3.10),
  and three Scheduling rows are slated for deletion in P4.0.
### Newly stale after Phase 4 — also for P7.9

- **Invariant 19 is now genuinely dead** (SM-2 ease has no readers at all).
- **The rating contract.** Anything describing the post-Again `OK` button, a
  two-button post-Again surface, or `Again` as non-writing. Three buttons now,
  everywhere, and the first answer on a face writes.
- **The Learn taxonomy.** Maturity and the anchor floor are stability thresholds;
  the due ranking is retrievability ascending with a difficulty tie-break.
- **Settings.** Three Scheduling rows are gone; `dataVersion` is 4.
- **New invariants earned in Phase 4:** the first answer per face writes and
  nothing else in the session does; an interval preview is rendered iff a write
  will occur; a New face never enters the due ranking; response-quality ordering
  is an explicit table, not the enum's numeric values.

- **New invariants earned in Phase 3:** `ScheduleInfo` is the only card-state type
  and it lives beside its converters; `elapsed_days` and `scheduled_days` are never
  persisted; both stored dates are calendar dates, so FSRS measures elapsed time in
  whole calendar days; a preview and the write it leads to come from one snapshot.

---

## PHASE 3 — Data model and persistence ✅

Committed as `5659e5a`. The largest phase, as predicted: redefining
`ScheduleInfo` made `tsc` enumerate 15 consumer files, and every one of them was a
real consumer.

- **P3.1** `sched()` rewritten first, before any fixture. New signature
  `sched(dueStr, stability, opts?)` with `opts: {difficulty, reps, lapses, lastReview, state}`.
  Only 4 of the 29 call sites needed more than the positional `interval → stability`
  reinterpretation — the four that spoke *ease*.
- **P3.2** `ScheduleInfo` redefined as FSRS card state and **moved to
  `src/scheduling/fsrs.ts`**, beside the converters. `src/persistence` no longer
  re-exports it (see decisions).
- **P3.3** `comment-parser.ts` rewritten to the seven-field B4 format, `parseFloat`
  throughout, `elapsed_days` / `scheduled_days` recomputed at load.
- **P3.4** `due.ts` rewritten to two lines, comparing against `now`.
- **P3.5** `previewInterval` → `previewAll`, plus `applyResponse` and
  `retrievabilityOf`. Both modals now take **one snapshot per revealed face** and
  write the entry they rendered.
- **P3.6** `osr.ts` deleted. `textInterval` moved to new `src/scheduling/interval-text.ts`.
- **P3.7** Fallout fixed across `card-parser.ts`, `write-schedule.ts`,
  `histogram-store.ts`, `deck-tree.ts`. `withUpdatedSchedules`' and
  `buildScheduleComment`'s `baseEase` parameters removed.
- **P3.8** `dates.ts` rewritten: native `Date`, **no `moment`, no `obsidian` import**.
- **P3.9** `comment-parser.test.ts` and `scheduling.test.ts` rewritten;
  `card-parser.test.ts`, `pool.test.ts`, `sentence-planner.test.ts` and
  `decks.test.ts` re-fixtured. New `session-helpers.test.ts`. The `deck-tree`
  due/new regression suite from §C3 added.
- **P3.10** `maximumInterval` description reworded for the soft ceiling.

### Decisions taken in Phase 3

- **`ScheduleInfo` lives in `src/scheduling/fsrs.ts`, not `src/persistence`.** It is
  FSRS card state, and it belongs beside the two converters that are the only code
  allowed to know both spellings. `src/persistence/index.ts` deliberately no longer
  re-exports the type, so there is exactly one source of truth; the nine importers
  were updated rather than left pointing at a barrel that no longer owns it.
- **`last_review` is `Date | null`, per B4, not ts-fsrs's `Date | undefined`.** It
  survives JSON, cannot be produced by a mistyped property name, and makes the
  "never reviewed" case explicit at every read site. `toCard` omits the property
  entirely when null (ts-fsrs checks truthiness) and `toScheduleInfo` maps
  `undefined → null`. Those two functions are the only place the spellings meet.
- **Both dates are stored as calendar dates (`YYYY-MM-DD`), not instants —
  implementing the plan, not choosing freely.** B1 relies on day granularity
  throughout, and B5's converter seeding spells the format out: `last_review =
  due − interval days` is date arithmetic yielding a date, so there is no instant
  for the field to hold. `<last_review>` also sits in the same positional field
  list as `<due>`, which was always `YYYY-MM-DD`.

  The mechanical consequence to know: ts-fsrs sets `card.last_review` to the actual
  review *instant* when it schedules, so the in-memory value carries a time that
  the write truncates. That is correct per the format, and it changes what
  finding 3 describes — elapsed time is now measured in whole **calendar** days, so
  retrievability ties land on day boundaries rather than straddling midnight. The
  truncation is explicitly tested.
- **Floats are written at 4 dp.** ts-fsrs carries stability and difficulty at 8
  (`roundTo(x, 8)`). Four keeps the comment readable in the user's own note while
  costing 8.6 seconds of stability and a thousandth of a difficulty point — far
  below day granularity, and double the ≥2 dp the exit criterion demands. Tested
  for drift across five write/read cycles.
- **A New face still emits a placeholder segment**, `!2000-01-01,0,0,0,0,0,`. The
  dummy date is what marks it New on the way back in, and emitting it rather than
  omitting it is what keeps front = 0 / back = 1 positional when only the back has
  been reviewed.
- **The parser rejects any segment with fewer than seven fields.** A legacy SM-2
  comment therefore reads as `null` — *not* as a new card. This is the correct
  pre-converter state and is asserted, but see the warning below.
- **`reset` (the post-Again OK) now writes `Rating.Again`.** `cardGetResetSchedule`
  died with `osr.ts`, and `lapsesIntervalChange` has no FSRS equivalent. B2 already
  specifies that lapse severity comes from FSRS's stability floor, so routing the
  intent through the seam as a genuine `Again` is the honest stopgap. P4.5 deletes
  the intent kind outright. The hardcoded `"1d"` preview went with it — it became a
  lie the moment FSRS owned scheduling, so both re-drill buttons now show the real
  Again interval.
- **`pool.ts` was ported mechanically, with one exception.** Thresholds
  (`>= 21` / `>= 12`) and the overdue-ratio ranking keep their Phase 3 shape for
  P4.1/P4.2 to replace. The exception is the **tie-break sign**: leaving a
  wrongly-signed `minSeenEase`-shaped function over `difficulty` would have been
  precisely the §C3 landmine, invisible to every other test. So the tie-break and
  `youngFiller` order flipped to `difficulty` **descending** now, with three
  explicit ordering tests including one that pins the min-vs-max-across-faces
  asymmetry.
- **`AnchorLocation.interval` renamed to `.stability`.** A field named `interval`
  holding a stability value is the kind of mislabel that survives for years. P4.3
  now only has to change the weighting maths, not the name.
- **A temporary `Math.max(1, stability)` floor in `overdueRatio`.** FSRS stability
  can sit below 1 day for a badly lapsed card where SM-2's interval could not, and
  an unfloored divisor lets one such face swamp the ranking. Dies with the function
  in P4.2.

### ⚠️ Debt left for Phase 4 — now resolved except where noted

> Phase 4 closed the settings item (as P4.0) and inherited the other two. Kept
> here as the record of what Phase 3 knowingly deferred.

**Load balancing applies no jitter right now.** → **still open, now Phase 5 (P5.1).** The histogram's
increment / decrement / rebuild bookkeeping is fully correct and no counts are
lost, but nothing consults it when scheduling, because re-pointing
`findLeastUsedIntervalOverRange` at the returned `due: Date` is P5.1. `histogramFor`
is still exported and tested; it simply has no caller inside the scheduling path
yet. `enable_fuzz` remains `false`, so the histogram is still the only place jitter
will ever come from.

**Three settings keys now have zero consumers** → **resolved in P4.0.** `baseEase`,
`defaultIntervalChange` and `lapsesIntervalChange`. Their sliders still render in
the Scheduling group and do **nothing**. They were left in place because deleting
`PluginData` keys requires a migration (EF.md invariant 11) and B2 already assigns
`lapsesIntervalChange`'s deletion to Phase 4 — all three should go together in one
v3→v4 step, with their three settings rows and the three lines in "Restore Default
Settings". Nothing user-facing ships before then: the plan has P3 and P4 landing in
the same release.

**Existing vaults read as un-scheduled until the converter exists.** → **still open, Phase 5.** A pre-FSRS
comment now parses to `null` on both faces. Deck Total still counts those cards,
but Due and New both show 0 for them, so a 1.4.1 vault opened on this build looks
like a deck of cards that are neither new nor due. That is Phase 5's entire reason
to exist, and it is asserted in `decks.test.ts` so it cannot be mistaken for a
regression — but **do not ship Phase 3 or 4 to a user without Phase 5**.

### Findings from Phase 3

**6. `withUpdatedSchedules` had a latent preview/write disagreement, now closed.**
The old `previewInterval` and `applyResponse` each constructed their own
`SRAlgorithmOsr` and re-snapshotted the histogram, so a button could advertise one
interval and write another. `previewAll` takes a single `repeat()` and both modals
now render from and write to that one record. `session-helpers.test.ts` asserts the
two paths agree field-by-field for all four grades.

**7. The comment is now ~2.1× longer.** A two-face comment went from 44 characters
(`<!--SR:!2026-09-20,4,270!2026-09-25,6,250-->`) to 94
(`<!--SR:!2026-11-01,23.9931,2.1112,2,0,2,2026-10-08!2026-10-01,0.212,6.4133,1,0,2,2026-09-30-->`).
Unavoidable at seven fields, and it stays on the card's single last line, but it is
worth a word in the release notes since users see these comments in their notes.

**8. `moment` is gone from `src/` entirely** — not just from the scheduling core.
`dates.ts` was the last consumer and no longer imports `obsidian` either. `moment`
remains a devDependency because `tests/obsidian-stub.ts` still re-exports it; the
stub is now vestigial for the current test graph but harmless, and it is what any
future UI test would need.

**9. The SM-2 arithmetic tests' load-balancing cases had no direct coverage.** They
exercised `findLeastUsedIntervalOverRange` only through `osrSchedule`. They are now
five direct tests of the scan itself, which is the part that survives untouched
into P5.1 — including the two behaviours easiest to get wrong when re-pointing it:
earlier-day-wins on a tie, and *keeping the requested day* when nothing in the
window is strictly better.

---

## PHASE 4 — Behaviour: Learn engine, rating contract, UI ✅

Committed as `16e4782`.

- **P4.0** (added in Phase 3) `baseEase`, `defaultIntervalChange` and
  `lapsesIntervalChange` deleted: interface, defaults, three settings rows, three
  lines of "Restore Default Settings", and a **v3→v4 migration** step.
  `CURRENT_DATA_VERSION` is now `4`.
- **P4.1** `classifyPools` predicates on FSRS quantities. New face → `isFaceNew`
  (null *or* `State.New`); maturity → `min stability >= LEARN_MATURE_STABILITY`;
  anchor floor → `min stability >= LEARN_ANCHOR_MIN_STABILITY`. Min-across-faces
  preserved. `minSeenEase` and `overdueRatio` deleted.
- **P4.2** Due ranking → **retrievability ascending**, tie-broken by `difficulty`
  descending. `RetrievabilityFn` is injected, not constructed in `pool.ts`.
- **P4.2b** Four assertions that no New face reaches the due ranking.
- **P4.3** `anchorWeight` reads stability; constants renamed
  (`LEARN_ANCHOR_REF_DAYS` → `LEARN_ANCHOR_REF_STABILITY`, and the two threshold
  constants). Clamp, jitter and `0.5^seen` damping transferred verbatim.
- **P4.4** `worstOf` no longer leans on the enum's numeric values; an explicit
  `QUALITY_RANK` table plus exported `isWorseThan`, with ordering tests.
- **P4.5** B2 in the session: `Again` produces a write intent, `WriteIntent.kind`
  deleted, `FaceAnswer` loses `"OK"`, new public `willWrite`.
- **P4.6** Three buttons everywhere. `renderPostAgainButtons`, `handleReset` and
  the `"1d"` string are gone; Review's `againItems` became `writtenItems`.
- **P4.7** Previews from the one snapshot, rendered iff a write will occur.
- **P4.8** `wasNew` → `isFaceNew`, so it cannot drift from `classifyPools`.
- **P4.9** `pool.test.ts` ranking suite rewritten; `session.test.ts` gained a B2
  suite; invariant 33's spread test preserved and passing.

### Decisions taken in Phase 4

- **`RetrievabilityFn` is injected into `classifyPools`,** not built there.
  `pool.ts` stays pure ranking logic, the modal passes a closure over the live
  engine, and — importantly — **the tests pass the real engine too.** A hand-rolled
  monotonic stub would satisfy a *reversed* comparison just as happily as a correct
  one, which is precisely the bug P4.2 exists to prevent.
- **`isFaceNew` covers both spellings of "new"** (a `null` schedule and a stored
  `State.New`) and lives in `fsrs.ts` beside `ScheduleInfo`. `classifyPools` and
  `makeInitialStates` both call it, so the pool predicate and `wasNew` cannot
  drift apart — they were independently written before.
- **`minRetrievability` skips New faces rather than trusting the pool split.**
  Defensive on purpose: `get_retrievability` returns exactly `0` for `State.New`
  and `0` sorts *first* in an ascending ranking, so the failure mode is a Learn
  session quietly serving new words ahead of forgotten ones — no error, no type
  complaint.
- **`worstOf` got an explicit rank table** rather than being migrated to `Rating`.
  `ReviewResponse` stays the internal "what the user pressed" enum; what changed is
  that its *numeric values stopped being load-bearing*. A bare `next > prev` was
  correct only by coincidence of `Easy=0..Again=3`.
- **Review's `againItems` became `writtenItems`.** Same set, inverted meaning:
  it no longer records "this got an Again" but "this face has been written", which
  is what B2 actually needs for both the no-second-write gate and the preview rule.
  It is added to only *after* `writeGradedResponse` resolves, so a failed write
  leaves the face writable.
- **Cram keeps a separate `handleCramAgain`.** Cram must never write, in any
  circumstance; giving it its own handler means the shared path can write
  unconditionally on first answer without a mode test inside it.

### ✅ Resolved 2026-10-02 — the one unconfirmed pedagogical call

**How should `difficulty` be aggregated across a card's two faces?** B3 fixes the
sort *direction* (descending) and separately mandates min-across-faces for
stability, but says nothing about difficulty. Phase 4 chose **max across faces**,
mirroring the stability rule: one shaky direction is enough to promote a card.
Pinned by `pool.test.ts` → "takes a card's difficulty from its hardest face, not
its easiest".

**Confirmed by the maintainer on 2026-10-02: keep max.** It matters for asymmetric cards,
which are the norm in language decks where recognition and production diverge
sharply — a word you recognise instantly but cannot produce ranks as hard under
max-across-faces, and as middling under a mean. The alternatives were a mean (asymmetry stops
being a promotion signal) and ranking on the face actually being drilled. Max won as
the deliberate mirror of the min-across-faces stability rule, and because
under-drilled production is the failure mode that actually costs a language learner.

**Do not revisit this without the maintainer.** `maxSeenDifficulty` in `pool.ts` and
`pool.test.ts`'s "takes a card's difficulty from its hardest face" are the two places
that encode it. Note also that difficulty only ever orders cards *within* a pool that
`LEARN_MATURE_STABILITY` (21) and `LEARN_ANCHOR_MIN_STABILITY` (12) have already
partitioned, so no difficulty rule can promote a young card into a mature slot.

### Findings from Phase 4

**10. Retrievability and the old overdue ratio are closer than they look — and
where they differ matters.** FSRS's forgetting curve is a function of `t/S` alone,
where `t` runs from **last_review**. `overdueRatio` measured lateness from the
**due date**. So the two agree whenever a card's scheduled interval equals its
stability, and diverge when it does not — which is exactly what `maximum_interval`
saturation produces (finding 1) and what Phase 5's converter will produce while it
seeds stability from an SM-2 interval. The first fixture written to show the
difference asserted the wrong sign and failed; the test that replaced it
(`ranks on time since last review, not lateness against a clamped due date`) pins
the real distinction. **Worth knowing in Phase 5:** converted cards will rank by
`(days_overdue + old_interval) / stability`, so a vault converted with
`stability = interval` ranks almost exactly as SM-2 would have. That is a feature,
not a coincidence to design around.

**11. The `difficulty` tie-break is reached constantly, not rarely.** ts-fsrs
floors elapsed time to whole days, so two faces last reviewed on the same day with
equal stability return *byte-identical* retrievability — `toBe`, not `toBeCloseTo`.
Asserted directly in `pool.test.ts`.

---

## Next: PHASE 5 — Load balancing and the one-time converter

Preconditions met. Two of Phase 3's three deferred items are Phase 5's opening
work, and both are described in the Debt section above:

- **P5.1** re-point `findLeastUsedIntervalOverRange` at the returned `due: Date`.
  `histogramFor` is already exported and tested and has no caller in the
  scheduling path; the five direct scan tests in `scheduling.test.ts` (finding 9)
  are the baseline it must still satisfy afterwards.
- **P5.3–P5.7** the converter. Use `parseLegacyDate` from
  `src/scheduling/dates.ts` — it already handles all three `ALLOWED_DATE_FORMATS`
  shapes without `moment`, and was kept for exactly this.

Do not ship any of Phases 3–4 without Phase 5: a pre-FSRS vault currently reads as
cards that are neither new nor due.
---

## Phase 5 prep — superseded by the Phase 5 section below

> Kept for the reasoning it records, **not** for its current-state claims. The
> "confirmed absent" list below was true before Phase 5 and is now false on every
> line except the `setDayBoundary` one. Both decisions at the end are resolved.

Preconditions re-verified rather than assumed: `tsc --noEmit --skipLibCheck` clean,
302/302 tests green across 14 files, working tree clean, Phase 4 committed as
`16e4782`. P7.2's boundary grep already passes (`ts-fsrs` imported only by
`src/scheduling/fsrs.ts`).

**What is confirmed absent**, so no one re-greps it:

- `findLeastUsedIntervalOverRange` (`due-date-histogram.ts:34`) has **no caller**
  outside `scheduling.test.ts`. `histogramFor` (`session-helpers.ts:23`) has no
  non-test caller either. P5.1 is untouched.
- `src/migration/` does not exist. P5.3–P5.7 are untouched.
- `setDayBoundary` appears only in its own three declarations in `dates.ts` plus
  `scheduling.test.ts:223`. Phase 6 is untouched.

**The unit mismatch P5.1 has to resolve.** `DueDateHistogram` is keyed in
**days-from-today** (`Map<number, number>`) and `findLeastUsedIntervalOverRange`
takes and returns a day offset. FSRS hands back a `due: Date`. `HistogramStore` is
keyed by **ISO date string**, and `toRelativeHistogram(today)` is the existing
bridge between the two. So the re-point converts `due` to a day offset relative to
`globalDateProvider.today`, scans, and converts back. The scan logic itself
(nearest empty day, earlier-wins tie-break, strict-improvement-only) does not
change, and the six tests at `scheduling.test.ts:74–124` remain its contract.

**Where the jitter has to be applied.** `writeGradedResponse`
(`ui/shared/write-schedule.ts`) is the single write funnel and already decrements
the old `due` and increments the new one under `settings.loadBalance`. But it
receives `newSchedule` **already chosen by the caller from the `previewAll`
snapshot**, and invariant 37 requires the rendered interval and the written
interval to come from that one snapshot. So **the jitter must not be applied inside
`writeGradedResponse`** — that would store a date the button never showed. It
belongs where the snapshot is taken, so the previews themselves show balanced
dates. This is the one real design constraint in P5.1 and the plan text does not
mention it.

**Converter seeding is fully specified** by B5 and needs no invention:
`stability = interval`, `difficulty` from a linear `ease [130,350] → [10,1]` map,
`last_review = due − interval days`, `state = Review`, `reps = 0`, `lapses = 0`,
no stability floor. Use `parseLegacyDate` (`dates.ts:50`), kept alive for exactly
this. Write through `writeCardBack` so `fileCache` semantics hold, and emit through
`buildScheduleComment` rather than hand-rolling the seven-field format.

Note for P5.7's idempotency test: `parseSegment` rejects a legacy three-field
segment via `f.length < FIELDS_PER_SEGMENT` (`comment-parser.ts:70`), so
"already converted" is cheaply detectable as "parses to a non-null `ScheduleInfo`".

### ✅ Both decisions resolved 2026-10-02

1. **Where the converter is invoked from.** B5 says "a standalone, explicitly
   invoked command", but EF.md §1 states only one command is registered
   (`Euphoric Flashcards: Review`) and `src/main.ts:33` is the only `addCommand`
   site. A second command contradicts §1; a settings button does not, and the
   Scheduling group already has two precedent `action` rows
   (`settings-tab.ts:291,305`). **Resolved: a settings button, last group in the
   tab, no command, and no confirmation step for now.**
2. **Whether the user-facing load-balancing copy is reworded now or at P5.1.**
   `settings-tab.ts:356` and `:360` already describe the toggle as spreading cards
   across nearby days, which was P5.1's behaviour and not that day's. **Resolved:
   left alone, and P5.1 has now made the existing copy true.**

---

## PHASE 5 — Load balancing and the one-time converter ✅

Uncommitted at time of writing. `dataVersion` is unchanged at 4: the converter
rewrites note text, not `PluginData`.

- **P5.1** Load balancing re-pointed at the FSRS `due: Date`. `balanceDue` and
  `balanceAll` live in `session-helpers.ts`; `previewAll` and `applyResponse` both
  balance. `histogramFor` gained an optional `today` parameter so the snapshot and
  the offset arithmetic cannot use two different todays.
- **P5.2** Nothing to do. `enable_fuzz: false` was already asserted three ways in
  `fsrs.test.ts:401–431` (determinism over 8 repeats, determinism over a 50-step
  walk, and absence from `DEFAULT_SETTINGS`).
- **P5.3** `src/migration/legacy-sr.ts`, the self-contained legacy parser and the
  B5 seeding rules. Obsidian-free.
- **P5.4/P5.5** `src/migration/convert-vault.ts`. One walk, `write: false` for the
  dry run and `write: true` to persist, through `vault.process`.
- **P5.6** The histogram is rebuilt after a successful conversion.
- **P5.7** 43 new tests across `legacy-sr.test.ts` (34) and `convert-vault.test.ts`
  (9), plus 12 added to `session-helpers.test.ts` for P5.1.
- **P5.8** (added) `test-deck.test.ts`, 16 tests reading the real pre-FSRS note at
  `test_vault_files/Test Deck.md` off disk. This is the plan's real-vault exit
  criterion, scaled to one file, and it found two things the hand-built fixtures
  did not (findings 14 and 15).

### Decisions taken in Phase 5

- **Balancing happens at the `previewAll` snapshot, not in `writeGradedResponse`.**
  This is the one real design constraint in P5.1 and the plan text does not mention
  it. `writeGradedResponse` looks like the obvious home — it is the single write
  funnel and already maintains the histogram counts — but it receives a
  `newSchedule` the caller already picked from the snapshot it rendered buttons
  from. Balancing there would store a date the button never showed, which is
  exactly the drift invariant 37 exists to prevent. Balancing at the snapshot means
  the previews themselves show the balanced days and both modals got it with no
  changes at all.
- **The fuzz ladder was transferred verbatim** from the deleted `osrSchedule`
  (recovered from `36e5426:src/scheduling/osr.ts`), including the `interval > 7`
  gate. A 1.4.1 user's spread behaviour is therefore unchanged; only the measured
  quantity moved, from an SM-2 interval to the due date's day offset. Inventing a
  new ladder would have been an unannounced behaviour change on top of a migration
  that already changes every overdue card's interval.
- **The balanced date is shifted by whole days, never rebuilt from midnight.**
  `due` carries the review's time of day and `scheduledDays` floors
  `last_review → due`, so a midnight rebuild shaves a day off the rendered interval
  while the stored calendar date keeps the full one. Pinned by a test that asserts
  the hours and minutes survive.
- **The grade-ordering clamp in `balanceAll` is defensive, and was verified to be
  defensive rather than assumed.** It looked like a live bug: a saturated card's
  grades sit one day apart (§4.4) and the fuzz window reaches up to seven. It is
  not reachable. Adjacent grades probe overlapping neighbourhoods, so any day empty
  enough to pull a higher grade down is a day the lower grade's own scan would have
  broken on first. 7M random histograms (sparse, and dense with varied counts to
  exercise the min-tracking path) plus an exhaustive occupancy sweep around every
  ladder boundary produced no crossing. The clamp stays because it is free and
  because a later change to the ladder or the scan must not be able to reintroduce
  the hazard silently. **The comment says defensive; do not rewrite it as a bug
  fix.**
- **The field count is the only legacy/FSRS discriminator.** B4 deliberately kept
  the `<!--SR:` wrapper and both delimiters identical, so nothing else
  distinguishes the formats. 3 fields is legacy, ≥7 is FSRS, anything else is
  malformed and left untouched. A **mixed** comment (one face each way) cannot be
  produced by either version of the plugin and is treated as damage rather than
  half-converted in place.
- **Conversion is a textual substitution, not a `parseCard` round trip.** Only the
  inside of the comment changes, so a note's line count cannot change, none of the
  `shiftLocationsForDelta` machinery is involved, and a card the parser would
  reject for unrelated reasons still gets its schedule converted. This is why P5.5
  does **not** go through `writeCardBack`: that path splices `ParsedCard` line
  ranges and exists to keep a live review queue consistent, and the converter runs
  outside any session with no `fileCache` to honour. `vault.process` is the atomic
  read-modify-write and is what the converter uses instead.
- **`last_review` rounds to whole days while `stability` keeps the fraction.** The
  old writer rounded intervals to one decimal, so `interval = 1.5` is real.
  Invariant 40 requires both stored dates to be calendar dates, so only the date
  arithmetic rounds.
- **The entry point is a settings button, by maintainer decision (2026-10-02).**
  B5 said "a standalone, explicitly invoked command", but §1's single-command rule
  stands and the Scheduling group already had two `action`-row precedents. It is
  the last group in the tab. Per the same decision the button **converts on first
  click with no confirmation**; the dry run that precedes it exists only so an
  already-converted vault can report that without writing. Safeguards and final
  copy are the maintainer's follow-up, not an oversight here.

### Findings from Phase 5

**12. The `interval > 7` gate is what protects short intervals, and it is load
bearing for a reason that is easy to miss.** Under SM-2 an `Again` returned
`interval = 0`; under FSRS `enable_short_term: false` guarantees
`scheduled_days >= 1`. Either way a lapse lands inside the no-balance window, so
the histogram never moves a card the user has just failed. Had the gate been
dropped as an SM-2 artefact, load balancing would have started nudging lapse
intervals by a day, which is a pedagogical change disguised as jitter.

**13. The converter and the runtime parser agree because the converter emits
through `buildScheduleComment`.** It would have been easy to hand-roll the
seven-field string in `legacy-sr.ts`. Reusing the writer means the output format
cannot drift from the reader, and the round-trip test (`parseScheduleComment` on a
converted comment returns two real `State.Review` schedules, where the same call on
the legacy comment returns `[null, null]`) is a genuine end-to-end check rather
than a restatement of the converter's own formatting.

**14. EF.md §4.10 was wrong about `New`, and the real note is what showed it.**
The claim was that an unconverted vault reports both Due and New as `0`. Due is
`0`; New is not, whenever a deck holds **multi-line** cards. The deck tree walks
line by line, so every continuation line except the one directly above the SR
comment is counted as a separate new card. The fixture's three multi-line cards
report `new = 10` between them. This is invariant 9's documented approximation
rather than a scheduling bug, conversion neither causes nor fixes it, and §4.10
has been corrected. Pinned by a test that asserts the number **does not move**
across conversion, and that the single-line `learn-test` decks do report `0`.

**15. One real vault already contains a corrupted due date, and the lenient date
parser is what saves it.** Line 32 of the fixture holds
`<!--SR:!2026-09-26,3,250!2026-/09-24,1,250-->`, with a stray slash. It survives
because `parseLegacyDate` falls through to the native `Date` constructor, which
recovers Sep 24 2026. A stricter parser would return `null`, and **`null` is
indistinguishable from the dummy date in `parseLegacySegment`**, so that face
would have silently reset to New. That is data loss outside the documented
`reps`/`lapses` loss, and nothing would have reported it. Pinned by name in
`test-deck.test.ts`. If the date parsing is ever tightened, this is the case that
decides whether a corrupt date must be counted as `malformed` instead of New.

---

## Next: PHASE 6 — `startOfDay`

Preconditions met. Deferrable: nothing else depends on it.

- `setDayBoundary` still has **zero production call sites** — only its three
  declarations in `dates.ts` and one test at `scheduling.test.ts:223`.
- `StaticDateProvider.today` still ignores the boundary (the NOTE in `dates.ts`
  marks the spot), which is why the feature is currently untestable.
- P5.1 added a second consumer of "today": `previewAll` passes
  `globalDateProvider.today` to both `histogramFor` and the offset arithmetic. Once
  the boundary is live, `today` stops being `startOfDay(now)` and those offsets
  shift with it. That is correct, but it means **P6.3's reconciliation now covers
  load balancing as well as `due.ts`**, and the `histogramFor`/`balanceAll` pairing
  is the place to check it.

Phase 7's scans were spot-checked while Phase 5 was in progress and currently pass:
`ts-fsrs` is imported only by `src/scheduling/fsrs.ts` (P7.2), there are zero
`.style.` writes in `src/` (P7.1), and every surviving mention of `ease` or `osr`
outside `src/migration/` is in a comment describing the historical SM-2 concept
(P7.3). P7.9's EF.md rewrite is largely done; §2, §4.8, §4.10/§4.11, §6, §8 and
invariant 10 were all updated with Phase 5.
