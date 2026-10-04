import { describe, expect, it } from "vitest";

import {
    classifySegment,
    convertComment,
    convertContent,
    difficultyFromEase,
    parseLegacySegment,
    seedFromLegacy,
} from "src/migration/legacy-sr";
import { parseScheduleComment } from "src/persistence/comment-parser";
import { State } from "src/scheduling/fsrs";
import { TICKS_PER_DAY } from "src/scheduling/constants";

// The two legacy shapes the converter has to read (plan §B5).
const UPSTREAM_ONE_SEGMENT = "<!--SR:!2024-01-02,25,249-->";
const EUPHORIC_TWO_SEGMENT = "<!--SR:!2026-09-26,5,203!2026-09-30,6,223-->";
const ALREADY_FSRS = "<!--SR:!2026-10-12,9.4211,5.2,4,1,2,2026-10-02!2026-10-15,11.2,4.8,3,0,2,2026-10-02-->";

describe("difficultyFromEase", () => {
    // The boundaries the plan pins by name. ⚠️ Downhill: low ease meant a card
    // the user kept failing, and high difficulty means the same thing.
    it("maps the ease floor to maximum difficulty", () => {
        expect(difficultyFromEase(130)).toBe(10);
    });

    it("maps the ease ceiling to minimum difficulty", () => {
        expect(difficultyFromEase(350)).toBe(1);
    });

    it("is monotonically decreasing in between", () => {
        const samples = [130, 170, 210, 250, 290, 330, 350].map(difficultyFromEase);
        for (let i = 1; i < samples.length; i++) {
            expect(samples[i]!).toBeLessThan(samples[i - 1]!);
        }
    });

    it("lands mid-scale for the old default ease of 250", () => {
        const d = difficultyFromEase(250);
        expect(d).toBeGreaterThan(4);
        expect(d).toBeLessThan(6);
    });

    it("clamps an ease outside the legacy range into [1, 10]", () => {
        expect(difficultyFromEase(50)).toBe(10);
        expect(difficultyFromEase(9000)).toBe(1);
    });

    it("falls back to the default ease when the field is unreadable", () => {
        expect(difficultyFromEase(NaN)).toBe(difficultyFromEase(250));
    });
});

describe("classifySegment", () => {
    it("reads a three-field segment as legacy", () => {
        expect(classifySegment("2024-01-02,25,249")).toBe("legacy");
    });

    it("reads a seven-field segment as FSRS", () => {
        expect(classifySegment("2026-10-12,9.42,5.2,4,1,2,2026-10-02")).toBe("fsrs");
    });

    it("reads anything else as malformed", () => {
        expect(classifySegment("2024-01-02")).toBe("malformed");
        expect(classifySegment("2024-01-02,25")).toBe("malformed");
    });
});

describe("parseLegacySegment", () => {
    it("reads due, interval and ease", () => {
        const seg = parseLegacySegment("2024-01-02,25,249");
        expect(seg).not.toBeNull();
        expect(seg!.interval).toBe(25);
        expect(seg!.ease).toBe(249);
        expect(seg!.due.getFullYear()).toBe(2024);
        expect(seg!.due.getMonth()).toBe(0);
        expect(seg!.due.getDate()).toBe(2);
    });

    it("returns null for the dummy date, which marked a never-reviewed face", () => {
        expect(parseLegacySegment("2000-01-01,0,250")).toBeNull();
    });

    it("tolerates the legacy date shapes a 1.4.1 vault can hold", () => {
        expect(parseLegacySegment("02-01-2024,25,249")).not.toBeNull();
        expect(parseLegacySegment("Wed Sep 06 2023,25,249")).not.toBeNull();
    });

    // parseFloat, not parseInt: the old writer rounded to one decimal.
    it("keeps a fractional interval", () => {
        expect(parseLegacySegment("2024-01-02,1.5,249")!.interval).toBe(1.5);
    });

    it("floors a negative interval at zero", () => {
        expect(parseLegacySegment("2024-01-02,-5,249")!.interval).toBe(0);
    });
});

describe("seedFromLegacy", () => {
    const legacy = parseLegacySegment("2026-09-26,5,203")!;

    it("seeds stability from the interval with no floor", () => {
        expect(seedFromLegacy(legacy).stability).toBe(5);
    });

    it("seeds difficulty from the ease", () => {
        expect(seedFromLegacy(legacy).difficulty).toBe(difficultyFromEase(203));
    });

    it("lands the card in Review, which is the only state B1 allows", () => {
        expect(seedFromLegacy(legacy).state).toBe(State.Review);
    });

    // The one documented data loss: SM-2 never recorded either number.
    it("zeroes reps and lapses rather than guessing them", () => {
        const s = seedFromLegacy(legacy);
        expect(s.reps).toBe(0);
        expect(s.lapses).toBe(0);
    });

    it("sets last_review to due minus the interval", () => {
        const s = seedFromLegacy(legacy);
        const days = (s.due.valueOf() - s.last_review!.valueOf()) / TICKS_PER_DAY;
        expect(days).toBe(5);
    });

    it("keeps last_review on a calendar date when the interval is fractional", () => {
        // Invariant 40: both stored dates are calendar dates. Only the date
        // arithmetic rounds; stability keeps the fraction.
        const s = seedFromLegacy(parseLegacySegment("2026-09-26,1.5,249")!);
        expect(s.stability).toBe(1.5);
        expect(s.last_review!.getHours()).toBe(0);
        expect(s.last_review!.getMinutes()).toBe(0);
    });

    // Plan §B5, stated outright: a lapsed card migrates as low-retention and is
    // not quietly inflated to look healthier than it is.
    it("migrates an interval-zero card with stability zero", () => {
        expect(seedFromLegacy(parseLegacySegment("2026-09-26,0,130")!).stability).toBe(0);
    });
});

describe("convertComment", () => {
    it("converts the Euphoric two-segment shape on both faces", () => {
        const result = convertComment(EUPHORIC_TWO_SEGMENT);
        expect(result.status).toBe("converted");
        expect(result.seededFaces).toBe(2);
        const schedules = parseScheduleComment(result.comment!);
        expect(schedules[0]).not.toBeNull();
        expect(schedules[1]).not.toBeNull();
        expect(schedules[0]!.stability).toBe(5);
        expect(schedules[1]!.stability).toBe(6);
    });

    it("converts the upstream single-segment shape, leaving the back New", () => {
        const result = convertComment(UPSTREAM_ONE_SEGMENT);
        expect(result.status).toBe("converted");
        expect(result.seededFaces).toBe(1);
        const schedules = parseScheduleComment(result.comment!);
        expect(schedules[0]!.stability).toBe(25);
        // Positional front=0/back=1 survives: the back is emitted as a dummy-dated
        // placeholder, which reads back as null rather than shifting the front.
        expect(schedules[1]).toBeNull();
    });

    it("leaves a dummy-dated front slot New and still seeds the back", () => {
        const result = convertComment("<!--SR:!2000-01-01,0,250!2026-09-30,6,223-->");
        expect(result.status).toBe("converted");
        expect(result.seededFaces).toBe(1);
        const schedules = parseScheduleComment(result.comment!);
        expect(schedules[0]).toBeNull();
        expect(schedules[1]!.stability).toBe(6);
    });

    it("reports an already-FSRS comment without rewriting it", () => {
        const result = convertComment(ALREADY_FSRS);
        expect(result.status).toBe("already-fsrs");
        expect(result.comment).toBeNull();
    });

    it("refuses a mixed comment rather than half-converting it", () => {
        const mixed = "<!--SR:!2026-09-26,5,203!2026-10-15,11.2,4.8,3,0,2,2026-10-02-->";
        expect(convertComment(mixed).status).toBe("malformed");
    });

    it("refuses a segment with an unreadable field count", () => {
        expect(convertComment("<!--SR:!2026-09-26,5-->").status).toBe("malformed");
    });

    // The round trip is what matters: whatever the converter writes, the runtime
    // FSRS parser must read back as a real schedule. Before conversion the same
    // parser returns null on both faces, which is the bug Phase 5 exists to fix.
    it("produces a comment the FSRS runtime parser can read", () => {
        expect(parseScheduleComment(EUPHORIC_TWO_SEGMENT)).toEqual([null, null]);
        const converted = convertComment(EUPHORIC_TWO_SEGMENT).comment!;
        const schedules = parseScheduleComment(converted);
        expect(schedules[0]!.state).toBe(State.Review);
        expect(schedules[1]!.state).toBe(State.Review);
    });
});

describe("convertContent", () => {
    const ROOTS = ["#espanol"];
    const note = [
        "#espanol/verbos",
        "",
        "hablar - to speak",
        EUPHORIC_TWO_SEGMENT,
        "",
        "comer - to eat",
        UPSTREAM_ONE_SEGMENT,
        "",
        "beber - to drink",
        ALREADY_FSRS,
        "",
    ].join("\n");

    it("converts every legacy comment and leaves FSRS ones alone", () => {
        const result = convertContent(note, ROOTS);
        expect(result.commentsConverted).toBe(2);
        expect(result.facesSeeded).toBe(3);
        expect(result.alreadyFsrs).toBe(1);
        expect(result.malformed).toBe(0);
        expect(result.content).toContain(ALREADY_FSRS);
    });

    it("does not change the note's line count", () => {
        const result = convertContent(note, ROOTS);
        expect(result.content.split("\n").length).toBe(note.split("\n").length);
    });

    it("leaves the card text untouched", () => {
        const result = convertContent(note, ROOTS);
        expect(result.content).toContain("hablar - to speak");
        expect(result.content).toContain("#espanol/verbos");
    });

    // Plan §P5.7 exit criterion: running the converter twice is a no-op the
    // second time.
    it("is idempotent", () => {
        const once = convertContent(note, ROOTS);
        const twice = convertContent(once.content, ROOTS);
        expect(twice.commentsConverted).toBe(0);
        expect(twice.content).toBe(once.content);
        expect(twice.alreadyFsrs).toBe(3);
    });

    it("counts an unreadable comment without touching it", () => {
        const broken = "#espanol\npalabra - word\n<!--SR:!2026-09-26,5-->\n";
        const result = convertContent(broken, ROOTS);
        expect(result.malformed).toBe(1);
        expect(result.commentsConverted).toBe(0);
        expect(result.content).toBe(broken);
    });

    it("returns a note with no cards unchanged", () => {
        const plain = "# Notes\n\nnothing to see\n";
        const result = convertContent(plain, ROOTS);
        expect(result.content).toBe(plain);
        expect(result.commentsConverted).toBe(0);
    });
});

// Deck scoping. The converter is an irreversible in-place rewrite, so it must
// touch only what belongs to the plugin. An <!--SR:!...-->-shaped comment is not
// proof of ownership: another tool, or the user's own notes, can carry one.
describe("convertContent deck scoping", () => {
    const ROOTS = ["#espanol"];
    const legacy = "<!--SR:!2026-09-26,5,203!2026-09-30,6,223-->";

    it("leaves a note with no deck tag completely untouched", () => {
        const note = `uno - one\n${legacy}\n`;
        const result = convertContent(note, ROOTS);
        expect(result.content).toBe(note);
        expect(result.commentsConverted).toBe(0);
        expect(result.inScope).toBe(false);
    });

    it("leaves a note tagged only with an unrecognised tag untouched", () => {
        const note = `#journal\nmy note - with a dash\n${legacy}\n`;
        const result = convertContent(note, ROOTS);
        expect(result.content).toBe(note);
        expect(result.commentsConverted).toBe(0);
        expect(result.inScope).toBe(false);
    });

    it("converts under a subdeck of a root tag", () => {
        const result = convertContent(`#espanol/verbos\nhablar - to speak\n${legacy}\n`, ROOTS);
        expect(result.commentsConverted).toBe(1);
        expect(result.inScope).toBe(true);
    });

    it("matches a root tag case-insensitively", () => {
        const result = convertContent(`#ESPANOL\nuno - one\n${legacy}\n`, ROOTS);
        expect(result.commentsConverted).toBe(1);
    });

    it("does not treat a tag that merely shares a prefix as a subdeck", () => {
        // #espanolito is not #espanol or #espanol/anything.
        const note = `#espanolito\nuno - one\n${legacy}\n`;
        const result = convertContent(note, ROOTS);
        expect(result.content).toBe(note);
        expect(result.commentsConverted).toBe(0);
    });

    it("converts only the part of a mixed note that follows the deck tag", () => {
        const note = [
            "private - not a card",
            legacy,
            "",
            "#espanol",
            "uno - one",
            legacy,
            "",
        ].join("\n");
        const result = convertContent(note, ROOTS);
        expect(result.commentsConverted).toBe(1);
        const after = result.content.split("\n");
        // The pre-tag comment survives byte for byte, the post-tag one does not.
        expect(after[1]).toBe(legacy);
        expect(after[5]).not.toBe(legacy);
    });

    it("converts nothing at all when no root tags are configured", () => {
        const note = `#espanol\nuno - one\n${legacy}\n`;
        const result = convertContent(note, []);
        expect(result.content).toBe(note);
        expect(result.commentsConverted).toBe(0);
        expect(result.inScope).toBe(false);
    });

    it("ignores whitespace-only root tag entries", () => {
        const note = `#espanol\nuno - one\n${legacy}\n`;
        expect(convertContent(note, ["   ", ""]).commentsConverted).toBe(0);
    });

    it("is lossless on CRLF notes outside scope", () => {
        const note = `private - x\r\n${legacy}\r\n`;
        expect(convertContent(note, ROOTS).content).toBe(note);
    });
});
