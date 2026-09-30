import type { ScheduleInfo } from "src/scheduling/fsrs";

// The shared definition of "due", for Review and Learn alike. A face is due when
// it has no schedule yet (new) or its due instant has passed.
//
// Compared against `now`, not against midnight. Under B1 every due date is
// day-granular, so for a card due today the two agree — but `now` is the honest
// comparison, it is what Phase 6's startOfDay boundary will shift, and it means
// this predicate no longer depends on callers having floored their clock first.
export function isFaceDue(schedule: ScheduleInfo | null, now: Date): boolean {
    return schedule === null || schedule.due.valueOf() <= now.valueOf();
}
