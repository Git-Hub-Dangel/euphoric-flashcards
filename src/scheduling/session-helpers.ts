import type EuphoricFlashcardsPlugin from "src/main";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { globalDateProvider } from "src/scheduling/dates";
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
// hand out an empty histogram.
//
// NOTE: under FSRS this is not yet consulted. Load balancing is re-pointed at
// the returned `due: Date` in P5.1; until then the histogram's increment /
// decrement / rebuild bookkeeping stays correct (so no counts are lost) but no
// jitter is applied. `enable_fuzz` remains false, so the histogram is still the
// only place jitter will ever come from (§B6).
export function histogramFor(plugin: EuphoricFlashcardsPlugin): DueDateHistogram {
    if (!plugin.data.settings.loadBalance) return new DueDateHistogram();
    return plugin.histogramStore.toRelativeHistogram(globalDateProvider.today);
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
    return out;
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
    return toScheduleInfo(engine.schedule(cardFor(schedule, now), ratingFor(response), now));
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
