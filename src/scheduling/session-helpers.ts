import type EuphoricFlashcardsPlugin from "src/main";
import type { ScheduleInfo } from "src/persistence";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { SRAlgorithmOsr } from "src/scheduling/osr";
import { globalDateProvider } from "src/scheduling/dates";
import type { ReviewResponse } from "src/scheduling/review-response";

// Load-balancing histogram for the current session. When the toggle is off
// we hand out an empty histogram so the algorithm's fuzz branch no-ops.
export function histogramFor(plugin: EuphoricFlashcardsPlugin): DueDateHistogram {
    if (!plugin.data.settings.loadBalance) return new DueDateHistogram();
    return plugin.histogramStore.toRelativeHistogram(globalDateProvider.today);
}

// Interval (in days) that a given response would produce, used for button previews.
export function previewInterval(
    schedule: ScheduleInfo | null,
    response: ReviewResponse,
    plugin: EuphoricFlashcardsPlugin,
): number {
    const algo = new SRAlgorithmOsr(plugin.data.settings);
    const h = histogramFor(plugin);
    if (schedule === null) return algo.cardGetNewSchedule(response, h).interval;
    return algo.cardCalcUpdatedSchedule(response, schedule, h).interval;
}

// New schedule the response would produce. Same routing as previewInterval
// but returns the full ScheduleInfo (used at write time).
export function applyResponse(
    schedule: ScheduleInfo | null,
    response: ReviewResponse,
    plugin: EuphoricFlashcardsPlugin,
): ScheduleInfo {
    const algo = new SRAlgorithmOsr(plugin.data.settings);
    const h = histogramFor(plugin);
    if (schedule === null) return algo.cardGetNewSchedule(response, h);
    return algo.cardCalcUpdatedSchedule(response, schedule, h);
}
