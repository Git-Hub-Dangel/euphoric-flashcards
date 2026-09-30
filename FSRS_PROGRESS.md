# FSRS Progress — Euphoric Flashcards

Companion to `FSRS_IMPLEMENTATION_PLAN.md`. That file holds the work to do; this one records what is done, what was learned doing it, and what the next agent must not re-derive. The plan still wins on intent; this file wins on current state.

**Status: Phases 1–2 complete. Phase 3 is next.**

| | Baseline | After P1 | After P2 |
|---|---|---|---|
| Tests | 170 / 11 files | 183 / 12 | **237 / 13** |
| `tsc --noEmit --skipLibCheck` | clean | clean | clean |
| `npm run build` | clean | clean | clean |
| `main.js` | 125,913 B | 126,681 B | **128,473 B** |
| `dataVersion` | — | 2 | **3** |

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

Uncommitted at time of writing.

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

- **P3.10** — reword the `maximumInterval` setting description when FSRS takes over scheduling (finding 1).
- **P4.2b** — assert New faces never enter the retrievability ranking (finding 2), plus the flooring note (finding 3).

---

## EF.md deltas

Corrected in P1.7 and kept current through Phase 2. Version was already `1.4.1`, so that item was moot.

- **Invariant 22 was wrong on both halves.** `writeEligible` is fixed per **group** at `beginNextGroup`, not once at session load, and its predicate reads `card.schedules[faceIndex]` **live** — so a card written in group 1 and reappearing in group 3 is correctly re-evaluated. Rewritten, with the identity-key requirement folded in.
- **The settings-tab order was wrong in four ways.** There is no "Review" group (`showIntervalOnButtons`/`showKeybindingsOnDesktop` are in Appearance); Appearance is **last**, below Load Balancing, not above; it has three controls, not one; `defaultCardSide` has no settings row at all. Actual order: Resources → Decks → Card Types → Learn → Conjure Sentences → Construction Constraints → Scheduling → Load Balancing → Appearance.
- Test counts, the `easyBonus` formula in §4, the `PluginData` shape and both migration steps in §7, `learnGroupsPerSession` 1–10 → 1–5, `startOfDay`'s inert status, the `Reset` enum member, `fsrs.ts` and `plugin-data.ts` in §2, the Cram label, and §8's first-runtime-dependency note with the exact-pin rationale and the `Date.prototype` disclosure.

Still outstanding, by design: **§0 and §10 both still say FSRS was rejected.** That is P7.9's job, not Phase 1's.

---

## Next: PHASE 3 — Data model and persistence

Preconditions met. The largest phase: redefining `ScheduleInfo` makes `tsc` enumerate every consumer.

Start with **P3.1** — rewrite `src/learn/test-helpers.ts`'s `sched()` *first*. Every Learn fixture flows through it, so a good FSRS replacement turns ~29 mechanical updates into a one-file change.

Two shapes to carry in: ts-fsrs `Card.last_review` is **optional** (`Date | undefined`), whereas B4 specifies `Date | null` — reconcile deliberately in P3.2. And `Card.learning_steps` exists on the type but is always `0` under B1 and is not persisted (B4).
