import { describe, expect, it, beforeEach } from "vitest";

import { buildScheduleComment, parseScheduleComment, extractCommentFromLine, replaceCommentOnLine } from "src/persistence/comment-parser";
import { RepItemScheduleInfoOsr } from "src/scheduling/osr";
import { DUMMY_DUE_DATE_FOR_NEW_CARD } from "src/scheduling/constants";
import { setupStaticDateProvider } from "src/scheduling/dates";
import { DEFAULT_SETTINGS } from "src/settings";

beforeEach(() => {
    setupStaticDateProvider("2023-09-06");
});

describe("parseScheduleComment — OSR single card", () => {
    it("parses a single OSR segment", () => {
        const result = parseScheduleComment("<!--SR:!2023-09-10,4,270-->");
        expect(result).toHaveLength(1);
        const info = result[0] as RepItemScheduleInfoOsr;
        expect(info).not.toBeNull();
        expect(info.interval).toBe(4);
        expect(info.latestEase).toBe(270);
    });

    it("returns null for dummy new-card date", () => {
        const comment = `<!--SR:!${DUMMY_DUE_DATE_FOR_NEW_CARD},1,250-->`;
        const result = parseScheduleComment(comment);
        expect(result[0]).toBeNull();
    });
});

describe("parseScheduleComment — both-sided card (two segments)", () => {
    it("parses Front (seg[0]) and Back (seg[1]) schedules independently", () => {
        const result = parseScheduleComment("<!--SR:!2023-09-10,4,270!2023-09-12,6,250-->");
        expect(result).toHaveLength(2);
        const front = result[0] as RepItemScheduleInfoOsr;
        const back = result[1] as RepItemScheduleInfoOsr;
        expect(front.interval).toBe(4);
        expect(front.latestEase).toBe(270);
        expect(back.interval).toBe(6);
        expect(back.latestEase).toBe(250);
    });

    it("allows front new, back scheduled", () => {
        const comment = `<!--SR:!${DUMMY_DUE_DATE_FOR_NEW_CARD},1,250!2023-09-12,6,250-->`;
        const result = parseScheduleComment(comment);
        expect(result[0]).toBeNull();
        expect(result[1]).not.toBeNull();
    });
});

describe("buildScheduleComment — round trip", () => {
    it("single schedule round-trips", () => {
        const info = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270, 0);
        const comment = buildScheduleComment([info], DEFAULT_SETTINGS.baseEase);
        expect(comment).toBe("<!--SR:!2023-09-10,4,270-->");
    });

    it("two schedules (Front+Back) round-trip", () => {
        const front = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270, 0);
        const back = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-12", 6, 250, 0);
        const comment = buildScheduleComment([front, back], DEFAULT_SETTINGS.baseEase);
        expect(comment).toBe("<!--SR:!2023-09-10,4,270!2023-09-12,6,250-->");

        const parsed = parseScheduleComment(comment);
        expect((parsed[0] as RepItemScheduleInfoOsr).interval).toBe(4);
        expect((parsed[1] as RepItemScheduleInfoOsr).interval).toBe(6);
    });

    it("null (new card) serialises to dummy date", () => {
        const comment = buildScheduleComment([null], DEFAULT_SETTINGS.baseEase);
        expect(comment).toContain(DUMMY_DUE_DATE_FOR_NEW_CARD);
    });

    it("mixed null+scheduled round-trip", () => {
        const back = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-12", 6, 250, 0);
        const comment = buildScheduleComment([null, back], DEFAULT_SETTINGS.baseEase);
        const parsed = parseScheduleComment(comment);
        expect(parsed[0]).toBeNull();
        expect((parsed[1] as RepItemScheduleInfoOsr).interval).toBe(6);
    });
});

describe("extractCommentFromLine", () => {
    it("extracts comment when present", () => {
        const line = "some word - translation <!--SR:!2023-09-10,4,270-->";
        expect(extractCommentFromLine(line)).toBe("<!--SR:!2023-09-10,4,270-->");
    });

    it("returns null when no comment", () => {
        expect(extractCommentFromLine("some word - translation")).toBeNull();
    });
});

describe("replaceCommentOnLine", () => {
    it("replaces existing comment", () => {
        const line = "word - translation <!--SR:!2023-09-01,2,250-->";
        const newComment = "<!--SR:!2023-09-10,4,270-->";
        const result = replaceCommentOnLine(line, newComment);
        expect(result).toBe("word - translation " + newComment);
    });

    it("appends comment when none present", () => {
        const line = "word - translation";
        const newComment = "<!--SR:!2023-09-10,4,270-->";
        const result = replaceCommentOnLine(line, newComment);
        expect(result).toBe("word - translation " + newComment);
    });
});
