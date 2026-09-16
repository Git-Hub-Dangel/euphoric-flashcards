import {
    DUMMY_DUE_DATE_FOR_NEW_CARD,
    PREFERRED_DATE_FORMAT,
    SR_COMMENT_FINDER,
    SR_HTML_COMMENT_BEGIN,
    SR_HTML_COMMENT_END,
} from "src/scheduling/constants";
import { DateUtil, globalDateProvider } from "src/scheduling/dates";
import { RepItemScheduleInfoOsr } from "src/scheduling/osr";

export type ScheduleInfo = RepItemScheduleInfoOsr;

// parsing

// parse the SR HTML comment on a card line, returning one ScheduleInfo per card.
// positional: segment[0] is front, segment[1] is back.
// a segment matching the dummy "new card" date returns null.
export function parseScheduleComment(comment: string): (ScheduleInfo | null)[] {
    const inner = comment
        .replace(/^<!--SR:/, "")
        .replace(/-->$/, "");

    return inner
        .split("!")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map(parseSegment);
}

function parseSegment(segment: string): ScheduleInfo | null {
    const [dueDateStr, intervalStr, easeStr] = segment.split(",");
    return parseSM2Segment(dueDateStr ?? "", parseInt(intervalStr ?? "0"), parseInt(easeStr ?? "0"));
}

function parseSM2Segment(
    dueDateStr: string,
    interval: number,
    ease: number,
): RepItemScheduleInfoOsr | null {
    const dueDate = DateUtil.dateStrToMoment(dueDateStr);
    if (!dueDate.isValid()) return null;
    if (dueDate.format(PREFERRED_DATE_FORMAT) === DUMMY_DUE_DATE_FOR_NEW_CARD) return null;
    const delayBeforeReviewTicks = dueDate.valueOf() - globalDateProvider.today.valueOf();
    return new RepItemScheduleInfoOsr(dueDate, interval, ease, delayBeforeReviewTicks);
}

// writing

// serialise an array of ScheduleInfo objects (positionally ordered) into an SR HTML comment string
export function buildScheduleComment(schedules: (ScheduleInfo | null)[], baseEase: number): string {
    const segments = schedules
        .map((s) =>
            s !== null
                ? s.formatScheduleAsSRHtmlComment()
                : `!${DUMMY_DUE_DATE_FOR_NEW_CARD},${RepItemScheduleInfoOsr.initialInterval},${baseEase}`,
        )
        .join("");
    return SR_HTML_COMMENT_BEGIN + segments + SR_HTML_COMMENT_END;
}

// note level helpers

/** extract the first SR comment from a line of note text, or null */
export function extractCommentFromLine(line: string): string | null {
    const match = line.match(/<!--SR:!.+?-->/);
    return match ? match[0] : null;
}

/** replace (or append) the SR comment on a given line */
export function replaceCommentOnLine(line: string, newComment: string): string {
    if (SR_COMMENT_FINDER.test(line)) {
        SR_COMMENT_FINDER.lastIndex = 0;
        return line.replace(/\s?<!--SR:!.+?-->/, " " + newComment);
    }
    SR_COMMENT_FINDER.lastIndex = 0;
    return line + " " + newComment;
}
