// Interval display helper, used for review and Learn button labels. Moved out of
// the deleted osr.ts (FSRS plan P3.6) unchanged: it formats a number of days and
// never knew which algorithm produced them.
//
// It keeps working under FSRS because B1's enable_short_term: false guarantees
// scheduled_days >= 1, so there is never a sub-day interval to render.
export function textInterval(interval: number | null | undefined, short = true): string {
    if (interval === null || interval === undefined) return "New";

    const m: number = Math.round(interval / 3.04375) / 10;
    const y: number = Math.round(interval / 36.525) / 10;

    if (short) {
        if (m < 1.0) return `${interval}d`;
        else if (y < 1.0) return `${m}mo`;
        else return `${y}yr`;
    } else {
        if (m < 1.0) return `${interval} day(s)`;
        else if (y < 1.0) return `${m} month(s)`;
        else return `${y} year(s)`;
    }
}
