import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { convertContent, difficultyFromEase } from "src/migration/legacy-sr";
import { buildScheduleComment, parseScheduleComment } from "src/persistence/comment-parser";
import { buildDeckTree, flattenDeckTree } from "src/decks/deck-tree";
import { State } from "src/scheduling/fsrs";
import { TICKS_PER_DAY } from "src/scheduling/constants";

// Phase 5's real-vault exit criterion, scaled to one real note.
//
// Every other migration test uses hand-built fixtures, which only ever contain
// the shapes the author thought to write. This one reads an actual pre-FSRS
// Euphoric note off disk: multi-line cards, `=type` markers, `::` example
// sentences, Spanish and Polish diacritics, nested deck tags, and one corrupted
// due date that a real vault really does contain.
//
// The file is a committed fixture, not a scratch file. If it goes missing the
// test fails loudly rather than skipping, because a silent skip here would read
// as "the real vault converts cleanly" when nothing was checked.
const FIXTURE = join(process.cwd(), "test_vault_files", "Test Deck.md");

const SR_LINE = /<!--SR:!.+?-->/;
// Root deck tags carry the "#", which is how settings stores them and what
// findRoot compares against. The returned tree is keyed by the canonical tag.
const ROOT_TAGS = ["#español", "#learn-test"];

// The cards are due 2026-09-24 through 2026-09-26, so this lands two of the
// three due dates in the past and leaves the third in the future.
const TODAY = new Date(2026, 8, 25);

let original: string;
let originalLines: string[];
let srLines: string[];

beforeAll(() => {
    original = readFileSync(FIXTURE, "utf8");
    originalLines = original.split("\n");
    srLines = originalLines.filter(l => SR_LINE.test(l));
});

// Flattened by fullPath so a subdeck is addressable directly. Root nodes come
// back under their bare name ("español"), nested ones under a slash path.
function deckStats(content: string): Map<string, { total: number; due: number; new: number }> {
    const tree = buildDeckTree(
        [{ path: "Test Deck.md", lines: content.split("\n") }],
        { rootTags: ROOT_TAGS, today: TODAY },
    );
    const out = new Map<string, { total: number; due: number; new: number }>();
    for (const node of flattenDeckTree(tree)) out.set(node.fullPath, { ...node.stats });
    return out;
}

describe("Test Deck.md — the fixture itself", () => {
    it("is present and holds the legacy format", () => {
        expect(original.length).toBeGreaterThan(0);
        expect(srLines.length).toBe(20);
        // Three fields per segment is what makes it legacy.
        for (const line of srLines) {
            const inner = SR_LINE.exec(line)![0]
                .replace(/^<!--SR:/, "")
                .replace(/-->$/, "");
            for (const seg of inner.split("!").filter(s => s.length > 0)) {
                expect(seg.split(",").length).toBe(3);
            }
        }
    });

    it("exercises the card shapes a hand-built fixture would miss", () => {
        expect(original).toContain("#español");
        expect(original).toContain("#learn-test/subtest/subtest");
        // =type markers, example sentences, an explanation, a multi-line card.
        expect(original).toContain("vista =fn - the view");
        expect(original).toContain("conocer =v - becomes \"conozco\" in 1st person - to know or to meet");
        expect(original).toContain("...sita =sfx --");
        expect(original).toContain("Me poderias dar una mano (możesz mi pomóc?) - ręka");
    });
});

// ---------------------------------------------------------------------------
// Before conversion: EF.md §4.10, demonstrated on real data
// ---------------------------------------------------------------------------

describe("Test Deck.md before conversion", () => {
    it("reads as neither new nor due through the FSRS runtime parser", () => {
        for (const line of srLines) {
            expect(parseScheduleComment(SR_LINE.exec(line)![0])).toEqual([null, null]);
        }
    });

    // The user-visible symptom: decks count their cards, but not one of them is
    // due, so Review has nothing to serve.
    it("shows a populated Total with zero Due", () => {
        const stats = deckStats(original);
        for (const deck of ["español", "learn-test"]) {
            expect(stats.get(deck)!.total).toBeGreaterThan(0);
            expect(stats.get(deck)!.due).toBe(0);
        }
    });

    // ⚠️ EF.md §4.10 says Due *and New* both show 0. That is only true of
    // single-line cards. This deck has three multi-line cards, and the deck tree
    // walks line by line (invariant 9: its counts are approximate, only
    // parseCard at review time is exact), so every continuation line that is not
    // the one directly above the SR comment is counted as a separate new card:
    // 3 + 4 + 3 = 10 across the three cards. None of them is a real card, and
    // conversion neither causes nor fixes it, which is why the assertion below
    // is that the number does not move.
    it("miscounts multi-line continuation lines as New, before and after alike", () => {
        const before = deckStats(original);
        const after = deckStats(convertContent(original).content);
        expect(before.get("español")!.new).toBe(10);
        expect(after.get("español")!.new).toBe(10);
        // The single-line learn-test decks have no continuation lines at all, so
        // there §4.10 holds exactly.
        expect(before.get("learn-test")!.new).toBe(0);
        expect(after.get("learn-test")!.new).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

describe("Test Deck.md conversion", () => {
    it("converts every card with no parse failures", () => {
        const result = convertContent(original);
        expect(result.commentsConverted).toBe(20);
        expect(result.facesSeeded).toBe(40);
        expect(result.malformed).toBe(0);
        expect(result.alreadyFsrs).toBe(0);
    });

    it("leaves every line that is not an SR comment byte-identical", () => {
        const after = convertContent(original).content.split("\n");
        expect(after.length).toBe(originalLines.length);
        for (let i = 0; i < originalLines.length; i++) {
            if (SR_LINE.test(originalLines[i]!)) continue;
            expect(after[i]).toBe(originalLines[i]);
        }
    });

    it("rewrites every SR line and only SR lines", () => {
        const after = convertContent(original).content.split("\n");
        let rewritten = 0;
        for (let i = 0; i < originalLines.length; i++) {
            if (!SR_LINE.test(originalLines[i]!)) continue;
            expect(after[i]).not.toBe(originalLines[i]);
            expect(SR_LINE.test(after[i]!)).toBe(true);
            rewritten++;
        }
        expect(rewritten).toBe(20);
    });

    // Zero data loss, stated as a round trip: the runtime parser that returned
    // [null, null] on every card above now returns two real schedules on each.
    it("produces cards the FSRS runtime parser reads as scheduled", () => {
        const after = convertContent(original).content;
        const converted = after.split("\n").filter(l => SR_LINE.test(l));
        expect(converted.length).toBe(20);
        for (const line of converted) {
            const schedules = parseScheduleComment(SR_LINE.exec(line)![0]);
            expect(schedules).toHaveLength(2);
            for (const s of schedules) {
                expect(s).not.toBeNull();
                expect(s!.state).toBe(State.Review);
                expect(s!.last_review).not.toBeNull();
                expect(Number.isFinite(s!.stability)).toBe(true);
                expect(s!.difficulty).toBeGreaterThanOrEqual(1);
                expect(s!.difficulty).toBeLessThanOrEqual(10);
                // The one documented loss, asserted so it stays documented.
                expect(s!.reps).toBe(0);
                expect(s!.lapses).toBe(0);
            }
        }
    });

    it("seeds this vault's actual interval and ease values per §B5", () => {
        const after = convertContent(original).content;
        // "amanece" (line 3): !2026-09-24,1,250!2026-09-26,3,250
        const amanece = after.split("\n")[3]!;
        const [front, back] = parseScheduleComment(SR_LINE.exec(amanece)![0]);

        expect(front!.stability).toBe(1);
        expect(front!.difficulty).toBe(difficultyFromEase(250));
        expect(front!.due.getDate()).toBe(24);
        // last_review = due - interval, so one day earlier.
        expect((front!.due.valueOf() - front!.last_review!.valueOf()) / TICKS_PER_DAY).toBe(1);

        expect(back!.stability).toBe(3);
        expect((back!.due.valueOf() - back!.last_review!.valueOf()) / TICKS_PER_DAY).toBe(3);
    });

    // This vault's two ease values are 230 and 250. Lower ease meant a card the
    // user kept failing, so it must come out as HIGHER difficulty. Getting the
    // polarity backwards here is the §C3 landmine that nothing else would catch.
    it("maps this vault's lower ease to higher difficulty", () => {
        const after = convertContent(original).content.split("\n");
        // File line 8 is "conocer"'s SR comment (ease 230); file line 4 is
        // "amanece"'s (ease 250). Zero-indexed here.
        const harder = parseScheduleComment(SR_LINE.exec(after[7]!)![0])[0]!;
        const easier = parseScheduleComment(SR_LINE.exec(after[3]!)![0])[0]!;
        expect(harder.difficulty).toBeGreaterThan(easier.difficulty);
        expect(harder.difficulty).toBe(difficultyFromEase(230));
        expect(easier.difficulty).toBe(difficultyFromEase(250));
    });

    // ⚠️ Real corruption, found in this file rather than imagined: line 32 holds
    // `2026-/09-24` in its back segment. parseLegacyDate's native-Date fallback
    // recovers the intended day, so the face converts instead of silently
    // resetting to New. Pinned because the recovery is the lenient branch, and a
    // stricter parser would turn this into unannounced data loss.
    it("recovers the one corrupted due date instead of dropping that face", () => {
        expect(originalLines[31]).toContain("2026-/09-24");
        const after = convertContent(original).content.split("\n");
        const [front, back] = parseScheduleComment(SR_LINE.exec(after[31]!)![0]);
        expect(front).not.toBeNull();
        expect(back).not.toBeNull();
        expect(back!.due.getFullYear()).toBe(2026);
        expect(back!.due.getMonth()).toBe(8);
        expect(back!.due.getDate()).toBe(24);
        expect(back!.stability).toBe(1);
    });

    it("is a no-op on a second run over the real file", () => {
        const once = convertContent(original);
        const twice = convertContent(once.content);
        expect(twice.commentsConverted).toBe(0);
        expect(twice.malformed).toBe(0);
        expect(twice.alreadyFsrs).toBe(20);
        expect(twice.content).toBe(once.content);
    });

    // The converter emits through buildScheduleComment, so a re-serialised
    // schedule must reproduce the converted line exactly.
    it("round-trips through the writer without drift", () => {
        const converted = convertContent(original).content.split("\n").filter(l => SR_LINE.test(l));
        for (const line of converted) {
            const comment = SR_LINE.exec(line)![0];
            expect(buildScheduleComment(parseScheduleComment(comment))).toBe(comment);
        }
    });
});

// ---------------------------------------------------------------------------
// After conversion: the §4.10 symptom is gone
// ---------------------------------------------------------------------------

describe("Test Deck.md after conversion", () => {
    it("surfaces its cards as due to the deck tree", () => {
        const before = deckStats(original);
        const after = deckStats(convertContent(original).content);

for (const deck of ["español", "learn-test"]) {
            // Total is driven by card lines, so it cannot move.
            expect(after.get(deck)!.total).toBe(before.get(deck)!.total);
            expect(before.get(deck)!.due).toBe(0);
            expect(after.get(deck)!.due).toBeGreaterThan(0);
        }
    });

    it("keeps the nested subdeck structure intact", () => {
        const after = deckStats(convertContent(original).content);
        expect(after.has("learn-test/subtest")).toBe(true);
        expect(after.has("learn-test/subtest/subtest")).toBe(true);
        // Parents aggregate their children.
        expect(after.get("learn-test")!.total)
            .toBeGreaterThan(after.get("learn-test/subtest")!.total);
    });
});
