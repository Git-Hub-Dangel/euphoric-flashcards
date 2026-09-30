# FSRS Progress — Euphoric Flashcards

Companion to `FSRS_IMPLEMENTATION_PLAN.md`. That file holds the work to do; this one records what is done, what was learned doing it, and what the next agent must not re-derive. The plan still wins on intent; this file wins on current state.

**Status: Phases 1–3 complete. Phase 4 is next.**

| | Baseline | After P1 | After P2 | After P3 |
|---|---|---|---|---|
| Tests | 170 / 11 files | 183 / 12 | 237 / 13 | **284 / 14** |
| `tsc --noEmit --skipLibCheck` | clean | clean | clean | clean |
| `npm run build` | clean | clean | clean | clean |
| `main.js` | 125,913 B | 126,681 B | 128,473 B | **191,203 B** |
| `dataVersion` | — | 2 | 3 | **3** (unchanged) |

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

**3. `date_diff(..., 'days')` floors, measured from the `last_review` instant** (not a calendar boundary). Retrievability ties for any two reads inside the same 24-hour window after the last review — a window that straddles midnight. Ties are therefore common, so P4.2's `difficulty`-descending tie-break is load-bearing, not incidental.

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

- **P4.0 (new, Phase 4's first task)** — delete `baseEase`, `defaultIntervalChange`
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

Still outstanding, by design: **§0 and §10 both still say FSRS was rejected.** That is P7.9's job, not Phase 1's.

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
- **New invariants earned in Phase 3:** `ScheduleInfo` is the only card-state type
  and it lives beside its converters; `elapsed_days` and `scheduled_days` are never
  persisted; both stored dates are calendar dates, so FSRS measures elapsed time in
  whole calendar days; a preview and the write it leads to come from one snapshot.

---

## PHASE 3 — Data model and persistence ✅

Uncommitted at time of writing. The largest phase, as predicted: redefining
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
- **Both dates are stored as calendar dates (`YYYY-MM-DD`), not instants.** B1 makes
  scheduling day-granular, so a time component has nothing to contribute and would
  only make the comments unreadable. This has a *good* consequence worth knowing:
  because `last_review` reads back as local midnight, FSRS measures elapsed time in
  whole **calendar** days, so the retrievability ties of finding 3 now fall on day
  boundaries instead of straddling midnight. The truncation is explicitly tested.
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

### ⚠️ Debt deliberately left for Phase 4

**Load balancing applies no jitter right now.** The histogram's
increment / decrement / rebuild bookkeeping is fully correct and no counts are
lost, but nothing consults it when scheduling, because re-pointing
`findLeastUsedIntervalOverRange` at the returned `due: Date` is P5.1. `histogramFor`
is still exported and tested; it simply has no caller inside the scheduling path
yet. `enable_fuzz` remains `false`, so the histogram is still the only place jitter
will ever come from.

**Three settings keys now have zero consumers:** `baseEase`,
`defaultIntervalChange` and `lapsesIntervalChange`. Their sliders still render in
the Scheduling group and do **nothing**. They were left in place because deleting
`PluginData` keys requires a migration (EF.md invariant 11) and B2 already assigns
`lapsesIntervalChange`'s deletion to Phase 4 — all three should go together in one
v3→v4 step, with their three settings rows and the three lines in "Restore Default
Settings". Nothing user-facing ships before then: the plan has P3 and P4 landing in
the same release.

**Existing vaults read as un-scheduled until the converter exists.** A pre-FSRS
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

## Next: PHASE 4 — Behaviour: Learn engine, rating contract, UI

Preconditions met. Read the **Debt** section above first: three of its items are
Phase 4's opening moves.

The groundwork Phase 3 laid that P4 should build on rather than redo:

- `previewAll` already returns all four grades from one call, so **P4.7 is mostly
  done** — what remains is B2's rule that a preview renders *iff* a write will
  occur, which means the re-drill's three buttons show none.
- `ratingFor` already exists and is exhaustively tested, so **P4.4**'s job is to
  decide whether `ReviewResponse` survives at all, not to build the mapping.
- The `difficulty`-descending tie-break and its sign tests already landed, so
  **P4.2** is the retrievability ranking plus P4.2b's New-face assertion.
- `pool.ts` still holds `minSeenStability` / `maxSeenDifficulty` / `overdueRatio`
  and the `>= 21` / `>= 12` thresholds against `LEARN_MATURE_INTERVAL_DAYS` and
  `LEARN_ANCHOR_MIN_INTERVAL_DAYS`, which **P4.1/P4.3 should rename** now that they
  measure stability.

Do not forget finding 4 when writing the P4 exit criterion: **`Again` on a
`State.New` card gives `lapses: 0`**. Only a `State.Review` card increments, and
`session-helpers.test.ts` now pins both halves of that.
