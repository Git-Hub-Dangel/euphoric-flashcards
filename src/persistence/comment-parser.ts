import {
    DUMMY_DUE_DATE_FOR_NEW_CARD,
    PREFERRED_DATE_FORMAT,
    SR_COMMENT_FINDER,
    SR_HTML_COMMENT_BEGIN,
    SR_HTML_COMMENT_END,
} from "src/scheduling/constants";
import { formatDate, parsePreferredDate } from "src/scheduling/dates";
import { State } from "src/scheduling/fsrs";
import type { ScheduleInfo } from "src/scheduling/fsrs";

// The on-disk format (FSRS plan §B4):
//
//   <!--SR:!<due>,<stability>,<difficulty>,<reps>,<lapses>,<state>,<last_review>!<back face>-->
//
// Seven fields per segment, positional. Front is segment 0, back is segment 1.
// The `<!--SR:` prefix, the `!` segment delimiter and the `,` field delimiter are
// unchanged from the SM-2 format precisely so the eleven hand-inlined regexes
// elsewhere in the codebase keep matching (plan §C2). If the wrapper ever
// changes, all eleven change together — a missed one does not error, it silently
// reads as "all my cards became new".
//
// elapsed_days and scheduled_days are absent by design: they are derived from
// last_review and the clock, and are recomputed on the way into ts-fsrs rather
// than stored, so the file can never disagree with the calendar. learning_steps
// is always 0 under B1 and is likewise not stored.
//
// This parser is FSRS-only. There is no dual-format runtime path and no legacy
// branch here; reading pre-FSRS comments is the explicitly-invoked converter's
// job (Phase 5), and it carries its own parser.

const FIELDS_PER_SEGMENT = 7;

// Stability and difficulty are fractional, so every numeric read goes through
// parseFloat. parseInt would silently truncate a stability of 12.7 to 12 —
// the same class of bug P1.2 fixed for SM-2 intervals.
function num(field: string | undefined, fallback = 0): number {
    const v = parseFloat(field ?? "");
    return Number.isFinite(v) ? v : fallback;
}

// Written with four decimals. ts-fsrs carries stability and difficulty at eight
// (roundTo(x, 8)), but these comments sit in the user's own notes and stay
// readable at four, which is 8.6 seconds of stability and a thousandth of a
// difficulty point — far below the day granularity B1 guarantees, and well past
// the >=2 dp the round-trip must preserve.
function fmtFloat(n: number): string {
    return String(Math.round(n * 10000) / 10000);
}

// parsing

// Parse the SR HTML comment on a card line, returning one ScheduleInfo per face.
// Positional: segment[0] is front, segment[1] is back.
// A segment carrying the dummy "new card" date returns null.
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
    const f = segment.split(",");
    if (f.length < FIELDS_PER_SEGMENT) return null;

    const due = parsePreferredDate(f[0] ?? "");
    if (due === null) return null;
    if (formatDate(due.valueOf(), PREFERRED_DATE_FORMAT) === DUMMY_DUE_DATE_FOR_NEW_CARD) return null;

    // last_review is empty for a face that has a due date but no recorded
    // review. Absent it, FSRS treats elapsed time as zero rather than guessing.
    const lastReview = parsePreferredDate(f[6] ?? "");

    return {
        due,
        stability: num(f[1]),
        difficulty: num(f[2]),
        reps: Math.max(0, Math.round(num(f[3]))),
        lapses: Math.max(0, Math.round(num(f[4]))),
        state: stateFrom(num(f[5], State.Review)),
        last_review: lastReview,
    };
}

// State is persisted as its numeric enum value. Anything unrecognised reads as
// Review: under B1 that is the only state a face with a real due date can be in,
// so it is the safe interpretation of a corrupted or hand-edited field.
function stateFrom(v: number): State {
    switch (Math.round(v)) {
        case State.New: return State.New;
        case State.Learning: return State.Learning;
        case State.Relearning: return State.Relearning;
        default: return State.Review;
    }
}

// writing

function formatSegment(s: ScheduleInfo): string {
    const due = formatDate(s.due.valueOf(), PREFERRED_DATE_FORMAT);
    const lastReview = s.last_review === null
        ? ""
        : formatDate(s.last_review.valueOf(), PREFERRED_DATE_FORMAT);
    return `!${due},${fmtFloat(s.stability)},${fmtFloat(s.difficulty)},${s.reps},${s.lapses},${s.state},${lastReview}`;
}

// A face with no schedule yet. The dummy date is what marks it New on the way
// back in, and the remaining fields are zeroed — including state, which is
// State.New (0). Emitting a placeholder rather than omitting the segment is what
// keeps front=0 / back=1 positional when only the back has been reviewed.
const NEW_FACE_SEGMENT = `!${DUMMY_DUE_DATE_FOR_NEW_CARD},0,0,0,0,${State.New},`;

// Serialise schedules (positionally ordered) into an SR HTML comment string.
export function buildScheduleComment(schedules: (ScheduleInfo | null)[]): string {
    const segments = schedules
        .map((s) => (s !== null ? formatSegment(s) : NEW_FACE_SEGMENT))
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
