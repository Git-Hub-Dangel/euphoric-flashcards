import type { ScheduleInfo } from "src/scheduling/fsrs";
import { startOfDay } from "src/scheduling/dates";

// The shared definition of "due", for Review and Learn alike. A face is due when
// it has no schedule yet (new) or its due day has arrived.
//
// Compared day against day, not instant against instant (P6.3). Every stored due
// date is a calendar date at local midnight (invariant 40) and B1's
// enable_short_term: false guarantees scheduled_days >= 1, so under the default
// 00:00:00 boundary this is the same answer the old instant comparison gave.
// What it adds is the day boundary. `today` comes from
// globalDateProvider.today, which resolves to the previous calendar day before
// the cutoff, and an instant comparison against a raw clock would ignore that
// shift entirely.
//
// `today` is floored defensively so a caller holding an instant rather than a
// session day cannot change the answer.
export function isFaceDue(schedule: ScheduleInfo | null, today: Date): boolean {
    if (schedule === null) return true;
    return startOfDay(schedule.due).valueOf() <= startOfDay(today).valueOf();
}
