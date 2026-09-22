import type { ScheduleInfo } from "src/persistence";

// A face is due when it has no schedule yet (new) or its due date is at or
// before the given day. Callers pass the "today" Date they already resolved
// through globalDateProvider so behaviour stays identical across modals.
export function isFaceDue(schedule: ScheduleInfo | null, today: Date): boolean {
    return schedule === null || schedule.dueDate.valueOf() <= today.valueOf();
}
