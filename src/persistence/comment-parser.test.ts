import { describe, expect, it, beforeEach } from "vitest";

import {
    buildScheduleComment,
    parseScheduleComment,
    extractCommentFromLine,
    replaceCommentOnLine,
} from "src/persistence/comment-parser";
import { DUMMY_DUE_DATE_FOR_NEW_CARD } from "src/scheduling/constants";
import { setupStaticDateProvider, formatDate } from "src/scheduling/dates";
import { State } from "src/scheduling/fsrs";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { sched } from "src/learn/test-helpers";

beforeEach(() => {
    setupStaticDateProvider("2023-09-06");
});

// The B4 format:
//   !<due>,<stability>,<difficulty>,<reps>,<lapses>,<state>,<last_review>
const FRONT = "!2023-09-10,4.5,5.2,3,1,2,2023-09-06";
const BACK = "!2023-09-12,6.25,4.1,5,0,2,2023-09-06";

describe("parseScheduleComment — one face", () => {
    it("parses all seven fields", () => {
        const result = parseScheduleComment(`<!--SR:${FRONT}-->`);
        expect(result).toHaveLength(1);
        const s = result[0] as ScheduleInfo;
        expect(formatDate(s.due.valueOf())).toBe("2023-09-10");
        expect(s.stability).toBe(4.5);
        expect(s.difficulty).toBe(5.2);
        expect(s.reps).toBe(3);
        expect(s.lapses).toBe(1);
        expect(s.state).toBe(State.Review);
        expect(formatDate(s.last_review!.valueOf())).toBe("2023-09-06");
    });

    it("returns null for the dummy new-card date", () => {
        const comment = `<!--SR:!${DUMMY_DUE_DATE_FOR_NEW_CARD},0,0,0,0,0,-->`;
        expect(parseScheduleComment(comment)[0]).toBeNull();
    });

    it("reads an empty last_review as null rather than a bogus date", () => {
        const s = parseScheduleComment("<!--SR:!2023-09-10,4,5,1,0,2,-->")[0] as ScheduleInfo;
        expect(s).not.toBeNull();
        expect(s.last_review).toBeNull();
    });

    // P1.2's lesson, now load-bearing: stability and difficulty are fractional.
    // parseInt would read 4.5 as 4 and silently shorten every interval.
    it("preserves fractional stability and difficulty", () => {
        const s = parseScheduleComment("<!--SR:!2023-09-10,12.3456,7.8901,2,1,2,2023-09-01-->")[0] as ScheduleInfo;
        expect(s.stability).toBeCloseTo(12.3456, 4);
        expect(s.difficulty).toBeCloseTo(7.8901, 4);
    });

    it("rejects a segment with too few fields", () => {
        // The SM-2 shape: three fields. It must not be half-read as FSRS state.
        expect(parseScheduleComment("<!--SR:!2023-09-10,4,270-->")[0]).toBeNull();
    });

    it("rejects an unparseable due date", () => {
        expect(parseScheduleComment("<!--SR:!not-a-date,4,5,1,0,2,-->")[0]).toBeNull();
    });

    it("falls back to State.Review for an unrecognised state field", () => {
        const s = parseScheduleComment("<!--SR:!2023-09-10,4,5,1,0,99,2023-09-01-->")[0] as ScheduleInfo;
        expect(s.state).toBe(State.Review);
    });

    it("clamps reps and lapses to non-negative integers", () => {
        const s = parseScheduleComment("<!--SR:!2023-09-10,4,5,-3,2.7,2,2023-09-01-->")[0] as ScheduleInfo;
        expect(s.reps).toBe(0);
        expect(s.lapses).toBe(3);
    });
});

describe("parseScheduleComment — both faces (two segments)", () => {
    it("parses front as segment 0 and back as segment 1", () => {
        const result = parseScheduleComment(`<!--SR:${FRONT}${BACK}-->`);
        expect(result).toHaveLength(2);
        const front = result[0] as ScheduleInfo;
        const back = result[1] as ScheduleInfo;
        expect(front.stability).toBe(4.5);
        expect(front.reps).toBe(3);
        expect(back.stability).toBe(6.25);
        expect(back.reps).toBe(5);
    });

    it("allows front new, back scheduled — positions are preserved", () => {
        const comment = `<!--SR:!${DUMMY_DUE_DATE_FOR_NEW_CARD},0,0,0,0,0,${BACK}-->`;
        const result = parseScheduleComment(comment);
        expect(result).toHaveLength(2);
        expect(result[0]).toBeNull();
        expect((result[1] as ScheduleInfo).stability).toBe(6.25);
    });
});

describe("buildScheduleComment — round trip", () => {
    const front = sched("2023-09-10", 4.5, { difficulty: 5.2, reps: 3, lapses: 1 });
    const back = sched("2023-09-12", 6.25, { difficulty: 4.1, reps: 5, lapses: 0 });

    it("emits exactly seven comma-separated fields per segment", () => {
        const comment = buildScheduleComment([front]);
        const inner = comment.replace("<!--SR:!", "").replace("-->", "");
        expect(inner.split(",")).toHaveLength(7);
    });

    // §C2: the wrapper and both delimiters are unchanged from the SM-2 format so
    // that all eleven hand-inlined <!--SR:! regexes keep matching.
    it("keeps the <!--SR:! wrapper and the ! segment delimiter unchanged", () => {
        const comment = buildScheduleComment([front, back]);
        expect(comment.startsWith("<!--SR:!")).toBe(true);
        expect(comment.endsWith("-->")).toBe(true);
        // Two faces → two "!"-introduced segments inside the wrapper.
        const inner = comment.replace(/^<!--SR:/, "").replace(/-->$/, "");
        expect(inner.split("!").filter((x) => x.length > 0)).toHaveLength(2);
        // And the canonical finder still matches the whole thing.
        expect(/<!--SR:!.+?-->/.test(comment)).toBe(true);
    });

    it("round-trips one face with every field intact", () => {
        const parsed = parseScheduleComment(buildScheduleComment([front]))[0] as ScheduleInfo;
        expect(parsed.due.valueOf()).toBe(front.due.valueOf());
        expect(parsed.stability).toBeCloseTo(front.stability, 4);
        expect(parsed.difficulty).toBeCloseTo(front.difficulty, 4);
        expect(parsed.reps).toBe(front.reps);
        expect(parsed.lapses).toBe(front.lapses);
        expect(parsed.state).toBe(front.state);
        expect(parsed.last_review!.valueOf()).toBe(front.last_review!.valueOf());
    });

    it("round-trips both faces independently", () => {
        const parsed = parseScheduleComment(buildScheduleComment([front, back]));
        expect((parsed[0] as ScheduleInfo).stability).toBeCloseTo(4.5, 4);
        expect((parsed[1] as ScheduleInfo).stability).toBeCloseTo(6.25, 4);
    });

    // The plan's exit criterion: floats survive to at least two decimal places.
    // The writer rounds to four, which this asserts is enough headroom.
    it("preserves stability and difficulty to at least 2 dp through a write/read cycle", () => {
        const s = sched("2026-01-01", 123.456789, { difficulty: 6.987654 });
        const parsed = parseScheduleComment(buildScheduleComment([s]))[0] as ScheduleInfo;
        expect(parsed.stability).toBeCloseTo(123.456789, 2);
        expect(parsed.difficulty).toBeCloseTo(6.987654, 2);
        // ...and in fact to four, which is what fmtFloat promises
        expect(parsed.stability).toBeCloseTo(123.4568, 4);
    });

    it("survives repeated write/read cycles without drifting", () => {
        let s: ScheduleInfo = sched("2026-01-01", 40.1234, { difficulty: 5.5678 });
        for (let i = 0; i < 5; i++) {
            s = parseScheduleComment(buildScheduleComment([s]))[0] as ScheduleInfo;
        }
        expect(s.stability).toBeCloseTo(40.1234, 4);
        expect(s.difficulty).toBeCloseTo(5.5678, 4);
    });

    it("a null face serialises to the dummy date and reads back as null", () => {
        const comment = buildScheduleComment([null]);
        expect(comment).toContain(DUMMY_DUE_DATE_FOR_NEW_CARD);
        expect(parseScheduleComment(comment)[0]).toBeNull();
    });

    // Dates, not instants. B1 makes scheduling day-granular, so both due and
    // last_review are stored as calendar dates and a time component is dropped
    // on the way out. FSRS then measures elapsed time in whole calendar days
    // from that date — which is also why retrievability ties fall on day
    // boundaries rather than straddling midnight.
    it("truncates a last_review instant to its calendar date", () => {
        const s = sched("2026-01-10", 5, { lastReview: new Date(2026, 0, 5, 14, 30, 0) });
        const parsed = parseScheduleComment(buildScheduleComment([s]))[0] as ScheduleInfo;
        expect(formatDate(parsed.last_review!.valueOf())).toBe("2026-01-05");
        expect(parsed.last_review!.getHours()).toBe(0);
    });

    it("a null last_review round-trips as null", () => {
        const s = sched("2026-01-01", 10, { lastReview: null });
        const parsed = parseScheduleComment(buildScheduleComment([s]))[0] as ScheduleInfo;
        expect(parsed.last_review).toBeNull();
    });

    it("mixed null + scheduled round-trips with positions intact", () => {
        const comment = buildScheduleComment([null, back]);
        const parsed = parseScheduleComment(comment);
        expect(parsed[0]).toBeNull();
        expect((parsed[1] as ScheduleInfo).stability).toBeCloseTo(6.25, 4);
    });

    it("emits a single line — never a wrapped or per-face one", () => {
        const comment = buildScheduleComment([front, back]);
        expect(comment).not.toContain("\n");
    });
});

describe("extractCommentFromLine", () => {
    it("extracts comment when present", () => {
        const line = `some word - translation <!--SR:${FRONT}-->`;
        expect(extractCommentFromLine(line)).toBe(`<!--SR:${FRONT}-->`);
    });

    it("returns null when no comment", () => {
        expect(extractCommentFromLine("some word - translation")).toBeNull();
    });
});

describe("replaceCommentOnLine", () => {
    it("replaces existing comment", () => {
        const line = `word - translation <!--SR:!2023-09-01,2,5,1,0,2,2023-08-30-->`;
        const newComment = `<!--SR:${FRONT}-->`;
        expect(replaceCommentOnLine(line, newComment)).toBe("word - translation " + newComment);
    });

    it("appends comment when none present", () => {
        const newComment = `<!--SR:${FRONT}-->`;
        expect(replaceCommentOnLine("word - translation", newComment)).toBe("word - translation " + newComment);
    });
});
