import type EuphoricFlashcardsPlugin from "src/main";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { globalDateProvider, startOfDay } from "src/scheduling/dates";
import { TICKS_PER_DAY } from "src/scheduling/constants";
import {
    emptyCard,
    FSRS_GRADES,
    FsrsEngine,
    ratingFor,
    toCard,
    toScheduleInfo,
} from "src/scheduling/fsrs";
import type { Card, GradeRecord, ScheduleInfo } from "src/scheduling/fsrs";
import type { ReviewResponse } from "src/scheduling/review-response";

// Load-balancing histogram for the current session. When the toggle is off we
// hand out an empty histogram, which makes every balancing scan a no-op rather
// than needing a branch at each call site.
//
// `today` must be the same instant the caller measures its day offsets against.
// The histogram is keyed in days-from-today, so two different "todays" would
// silently shift every offset by a day.
export function histogramFor(
    plugin: EuphoricFlashcardsPlugin,
    today: Date = globalDateProvider.today,
): DueDateHistogram {
    if (!plugin.data.settings.loadBalance) return new DueDateHistogram();
    return plugin.histogramStore.toRelativeHistogram(today);
}

// Days from today to a due date. Measured between local midnights, exactly as
// HistogramStore.toRelativeHistogram keys the histogram, so the lookup and the
// key cannot drift.
function dayOffset(due: Date, today: Date): number {
    return Math.round((startOfDay(due).valueOf() - startOfDay(today).valueOf()) / TICKS_PER_DAY);
}

// Intervals of a week or less are never moved. Nudging a one or two day lapse
// interval is a pedagogical decision, not load balancing.
const BALANCE_MIN_OFFSET = 7;

// The fuzz window, transferred verbatim from the deleted osrSchedule so the
// spread behaviour a 1.4.1 user already had is unchanged. Only the quantity it
// measures moved, from an SM-2 interval to the day offset of the FSRS due date.
function fuzzFor(offset: number): number {
    if (offset <= 21) return 1;
    if (offset <= 180) return Math.min(3, Math.floor(offset * 0.05));
    return Math.min(7, Math.floor(offset * 0.025));
}

// Nudge one due date toward a less crowded day within its fuzz window (§B6,
// P5.1). The scan itself is untouched: nearest empty day, earlier day wins a
// tie, and it only moves on a strict improvement.
//
// The result is shifted by whole days rather than rebuilt from midnight. `due`
// carries the review's time of day and `scheduledDays` floors last_review -> due,
// so snapping to midnight would shave a day off the interval rendered on the
// button while the stored calendar date kept the full one.
// `now` separates two quantities that are the same number until a startOfDay
// boundary is set (P6.3). The histogram is keyed in days from the session day,
// so the scan must use that offset. The no-balance gate and the fuzz width are
// properties of the interval the button shows the user, which is measured from
// the actual clock. Before the cutoff the session day is yesterday, so the two
// differ by one day, and reading the offset as the interval would widen the fuzz
// window a notch early and let a 7-day interval through the gate. It defaults to
// `today`, which is the no-boundary case and leaves the arithmetic untouched.
export function balanceDue(
    due: Date,
    histogram: DueDateHistogram,
    today: Date,
    now: Date = today,
): Date {
    const offset = dayOffset(due, today);
    const interval = offset - dayOffset(now, today);
    if (interval <= BALANCE_MIN_OFFSET) return due;
    const balanced = histogram.findLeastUsedIntervalOverRange(offset, fuzzFor(interval));
    const delta = balanced - offset;
    if (delta === 0) return due;
    return new Date(due.valueOf() + delta * TICKS_PER_DAY);
}

// Balance all four grades off one histogram snapshot, holding each at or after
// the grade below it so the previews stay in order (§4.4).
//
// The ordering clamp is **defensive, not a fix for a reachable bug.** Scanning
// each grade independently looks like it should be able to cross two of them,
// since a saturated card's grades sit one day apart and the fuzz window is up to
// seven days wide. It cannot: adjacent grades probe overlapping neighbourhoods,
// and any day empty enough to pull the higher grade down is a day the lower
// grade's own scan would have stopped at first. A search over 7 million random
// histograms plus an exhaustive occupancy sweep around every fuzz-ladder
// boundary produced no crossing. The clamp costs nothing, matches the repair
// ts-fsrs applies to its own intervals, and means a future change to the ladder
// or the scan cannot reintroduce the hazard silently. Equal days are allowed.
function balanceAll(
    record: GradeRecord<ScheduleInfo>,
    histogram: DueDateHistogram,
    today: Date,
    now: Date,
): GradeRecord<ScheduleInfo> {
    let floor = -Infinity;
    // FSRS_GRADES is ascending in quality, so this walks Again -> Easy.
    for (const grade of FSRS_GRADES) {
        const s = record[grade];
        let due = balanceDue(s.due, histogram, today, now);
        let offset = dayOffset(due, today);
        if (offset < floor) {
            due = new Date(due.valueOf() + (floor - offset) * TICKS_PER_DAY);
            offset = floor;
        }
        floor = offset;
        record[grade] = { ...s, due };
    }
    return record;
}

function cardFor(schedule: ScheduleInfo | null, now: Date): Card {
    return schedule === null ? emptyCard(now) : toCard(schedule, now);
}

// Every outcome of the current face, from a single repeat() call.
//
// This is the seam the FSRS plan (P3.5) funnels *all* writes through, and the
// single call is the point: previously the preview and the write each built their
// own algorithm instance and re-snapshotted the histogram independently, so the
// interval shown on a button could differ from the interval actually written.
// Callers take one snapshot when the answer is revealed, render previews from it,
// and then write the very entry they rendered.
export function previewAll(
    schedule: ScheduleInfo | null,
    plugin: EuphoricFlashcardsPlugin,
    now: Date = globalDateProvider.now,
): GradeRecord<ScheduleInfo> {
    const engine = new FsrsEngine(plugin.data.settings);
    const cards = engine.previewAll(cardFor(schedule, now), now);
    const out = {} as GradeRecord<ScheduleInfo>;
    for (const grade of FSRS_GRADES) {
        out[grade] = toScheduleInfo(cards[grade]);
    }
    // Load balancing belongs here and nowhere later (P5.1). The caller renders
    // its button previews from this record and then writes the very entry it
    // rendered, so balancing the due date at write time instead would store a
    // day the button never showed. One histogram snapshot serves all four grades.
    //
    // `today` is the session day and `now` the instant being reviewed. They sit
    // on the same calendar day unless a startOfDay boundary is set, and the
    // histogram snapshot and the offsets must both come from the former.
    const today = globalDateProvider.today;
    return balanceAll(out, histogramFor(plugin, today), today, now);
}

// The schedule a single response would produce. Kept for callers that have no
// snapshot to hand; anything rendering a preview should use previewAll and write
// from that same record instead.
export function applyResponse(
    schedule: ScheduleInfo | null,
    response: ReviewResponse,
    plugin: EuphoricFlashcardsPlugin,
    now: Date = globalDateProvider.now,
): ScheduleInfo {
    const engine = new FsrsEngine(plugin.data.settings);
    const out = toScheduleInfo(engine.schedule(cardFor(schedule, now), ratingFor(response), now));
    // Balanced too, so this can never become the one path that writes an
    // unbalanced date. It sees a single grade, so there is no ordering to repair.
    const today = globalDateProvider.today;
    return { ...out, due: balanceDue(out.due, histogramFor(plugin, today), today, now) };
}

// Probability of recalling this face right now, in [0, 1]. A face with no
// schedule is New, which FSRS reports as exactly 0 — see the warning on
// FsrsEngine.retrievability before sorting on this.
export function retrievabilityOf(
    schedule: ScheduleInfo | null,
    plugin: EuphoricFlashcardsPlugin,
    now: Date = globalDateProvider.now,
): number {
    const engine = new FsrsEngine(plugin.data.settings);
    return engine.retrievability(cardFor(schedule, now), now);
}
