import { beforeEach, describe, expect, it } from "vitest";

import {
    parseCard,
    frontFace,
    backFace,
    cardReveal,
    withUpdatedSchedules,
} from "src/parsing/card-parser";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { sched } from "src/learn/test-helpers";
import { setupStaticDateProvider } from "src/scheduling/dates";

beforeEach(() => {
    setupStaticDateProvider("2026-09-16");
});

// ---------------------------------------------------------------------------
// Single-line cards
// ---------------------------------------------------------------------------

describe("parseCard — single-line cards", () => {
    it("full card: word - explanation : example : example =type - translation", () => {
        const lines = ["gato - domestic feline : el gato duerme : tengo un gato =n - cat"];
        const card = parseCard(lines, 0)!;
        expect(card).not.toBeNull();
        expect(card.fields.word).toBe("gato");
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.examples).toEqual(["el gato duerme", "tengo un gato"]);
        expect(card.fields.type).toBe("n");
        expect(card.fields.translation).toBe("cat");
        expect(card.startLine).toBe(0);
        expect(card.endLine).toBe(0);
    });

    it("minimum: word - translation", () => {
        const lines = ["gato - cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.explanation).toBeNull();
        expect(card.fields.examples).toEqual([]);
        expect(card.fields.type).toBeNull();
        expect(card.fields.translation).toBe("cat");
    });

    it("word - explanation - translation (no examples, no type)", () => {
        const lines = ["gato - domestic feline - cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.translation).toBe("cat");
    });

    it("word - example - translation (no explanation, one example)", () => {
        const lines = ["gato : el gato duerme - cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.explanation).toBeNull();
        expect(card.fields.examples).toEqual(["el gato duerme"]);
        expect(card.fields.translation).toBe("cat");
    });

    it("word =type - translation (type only, no explanation/examples)", () => {
        const lines = ["gato =n - cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.type).toBe("n");
        expect(card.fields.translation).toBe("cat");
    });
});

// ---------------------------------------------------------------------------
// Multi-line cards
// ---------------------------------------------------------------------------

describe("parseCard — multi-line cards", () => {
    it("fully multi-line card", () => {
        const lines = [
            "gato --",
            "domestic feline ::",
            "el gato duerme ::",
            "tengo un gato =n --",
            "cat",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.examples).toEqual(["el gato duerme", "tengo un gato"]);
        expect(card.fields.type).toBe("n");
        expect(card.fields.translation).toBe("cat");
        expect(card.startLine).toBe(0);
        expect(card.endLine).toBe(4);
        expect(card.rawLines).toHaveLength(5);
    });

    it("mixed single-line and multi-line separators", () => {
        const lines = [
            "gato --",
            "domestic feline : el gato duerme : tengo un gato ::",
            "tengo dos gatos =n - cat",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.examples).toEqual(["el gato duerme", "tengo un gato", "tengo dos gatos"]);
        expect(card.fields.type).toBe("n");
        expect(card.fields.translation).toBe("cat");
        expect(card.endLine).toBe(2);
    });

    it("multi-line with translation on last line, no type", () => {
        const lines = [
            "gato --",
            "domestic feline --",
            "cat",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.type).toBeNull();
        expect(card.fields.translation).toBe("cat");
    });

    it("accepts en dash (–) as `--` separator (smart-punctuation autocorrect)", () => {
        const lines = ["gato – cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.translation).toBe("cat");
    });

    it("accepts em dash (—) as `--` separator (smart-punctuation autocorrect)", () => {
        const lines = ["gato — cat"];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.translation).toBe("cat");
    });

    it("accepts trailing em dash as continuation marker", () => {
        const lines = [
            "gato —",
            "domestic feline —",
            "cat",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.word).toBe("gato");
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.translation).toBe("cat");
        expect(card.endLine).toBe(2);
    });

    it("mixed em dash and `--` in the same card", () => {
        const lines = [
            "gato --",
            "domestic feline — cat",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.explanation).toBe("domestic feline");
        expect(card.fields.translation).toBe("cat");
    });

    it("stops at first line with no continuation marker", () => {
        const lines = [
            "gato - cat",
            "perro - dog",
            "casa - house",
        ];
        const first = parseCard(lines, 0)!;
        expect(first.startLine).toBe(0);
        expect(first.endLine).toBe(0);

        const second = parseCard(lines, 1)!;
        expect(second.startLine).toBe(1);
        expect(second.endLine).toBe(1);
        expect(second.fields.word).toBe("perro");
    });
});

// ---------------------------------------------------------------------------
// SR comment handling
// ---------------------------------------------------------------------------

describe("parseCard — SR comment handling", () => {
    it("parses schedules from SR comment on last line", () => {
        const comment = "<!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16!2026-09-25,6,4.5,2,0,2,2026-09-19-->";
        const card = parseCard([`gato - cat ${comment}`], 0)!;
        const front = card.schedules[0] as ScheduleInfo;
        const back = card.schedules[1] as ScheduleInfo;
        expect(front.stability).toBe(4);
        expect(front.difficulty).toBe(5.5);
        expect(front.lapses).toBe(1);
        expect(back.stability).toBe(6);
        expect(back.difficulty).toBe(4.5);
        expect(card.originalComment).toBe(comment);
    });

    it("SR comment on last line of multi-line card", () => {
        const lines = [
            "gato --",
            "domestic feline --",
            "cat <!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16-->",
        ];
        const card = parseCard(lines, 0)!;
        expect(card.fields.translation).toBe("cat");
        const front = card.schedules[0] as ScheduleInfo;
        expect(front.stability).toBe(4);
        expect(card.schedules[1]).toBeNull();
    });

    it("no SR comment → both schedules null (new)", () => {
        const lines = ["gato - cat"];
        const card = parseCard(lines, 0)!;
        expect(card.schedules).toEqual([null, null]);
        expect(card.originalComment).toBeNull();
    });

    it("continuation marker detection ignores '-->' at end of SR comment", () => {
        // The line ends in "-->" (SR comment) — after stripping, it's "cat", no continuation.
        const lines = ["gato - cat <!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16-->"];
        const card = parseCard(lines, 0)!;
        expect(card.endLine).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Both-sided card model
// ---------------------------------------------------------------------------

describe("parseCard — both-sided card model", () => {
    it("frontFace uses word→translation with seg[0] schedule", () => {
        const lines = ["gato - cat <!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16!2026-09-25,6,4.5,2,0,2,2026-09-19-->"];
        const card = parseCard(lines, 0)!;
        const front = frontFace(card);
        expect(front.side).toBe("front");
        expect(front.prompt).toBe("gato");
        expect(front.answer).toBe("cat");
        expect((front.schedule as ScheduleInfo).stability).toBe(4);
    });

    it("backFace uses translation→word with seg[1] schedule", () => {
        const lines = ["gato - cat <!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16!2026-09-25,6,4.5,2,0,2,2026-09-19-->"];
        const card = parseCard(lines, 0)!;
        const back = backFace(card);
        expect(back.side).toBe("back");
        expect(back.prompt).toBe("cat");
        expect(back.answer).toBe("gato");
        expect((back.schedule as ScheduleInfo).stability).toBe(6);
    });

    it("cardReveal returns shared metadata for both sides", () => {
        const lines = ["gato - feline : purrs =n - cat"];
        const card = parseCard(lines, 0)!;
        expect(cardReveal(card)).toEqual({
            explanation: "feline",
            examples: ["purrs"],
            type: "n",
        });
    });

    it("both faces are new when card has no SR comment", () => {
        const lines = ["gato - cat"];
        const card = parseCard(lines, 0)!;
        expect(frontFace(card).schedule).toBeNull();
        expect(backFace(card).schedule).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Invalid / rejected cards
// ---------------------------------------------------------------------------

describe("parseCard — rejection", () => {
    it("empty word → null", () => {
        const lines = [" - cat"];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("empty translation → null", () => {
        const lines = ["gato - "];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("no dash separator at all → null", () => {
        const lines = ["gato : cat"];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("no separators at all → null", () => {
        const lines = ["gato"];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("unknown type key → valid card with type stored as-is", () => {
        const lines = ["gato =xyz - cat"];
        const card = parseCard(lines, 0)!;
        expect(card).not.toBeNull();
        expect(card.fields.type).toBe("xyz");
        expect(card.fields.word).toBe("gato");
        expect(card.fields.translation).toBe("cat");
    });

    it("more than one explanation-dash → null", () => {
        // Three dashes: word - expl - expl - translation
        const lines = ["gato - one - two - cat"];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("empty example → null", () => {
        const lines = ["gato - foo : : bar - cat"];
        expect(parseCard(lines, 0)).toBeNull();
    });

    it("more than one type marker → null", () => {
        const lines = ["gato - foo =n =v - cat"];
        expect(parseCard(lines, 0)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// withUpdatedSchedules
// ---------------------------------------------------------------------------

describe("withUpdatedSchedules", () => {
    it("migrates legacy inline SR to a dedicated line below the card (single-line card)", () => {
        const lines = ["gato - cat <!--SR:!2026-09-01,2,5,1,0,2,2026-08-30-->"];
        const card = parseCard(lines, 0)!;
        const newFront = sched("2026-09-20", 4, { difficulty: 5.5, reps: 3, lapses: 1 });
        const newBack = sched("2026-09-25", 6, { difficulty: 4.5, reps: 2, lapses: 0 });
        const updated = withUpdatedSchedules(card, [newFront, newBack]);
        expect(updated).toHaveLength(2);
        expect(updated[0]).toBe("gato - cat");
        expect(updated[1]).toBe(
            "<!--SR:!2026-09-20,4,5.5,3,1,2,2026-09-16!2026-09-25,6,4.5,2,0,2,2026-09-19-->",
        );
    });

    it("appends SR comment when card had none (multi-line card)", () => {
        const lines = ["gato --", "domestic feline --", "cat"];
        const card = parseCard(lines, 0)!;
        const newFront = sched("2026-09-20", 4);
        const updated = withUpdatedSchedules(card, [newFront, null]);
        expect(updated).toHaveLength(4);
        expect(updated[0]).toBe("gato --");
        expect(updated[1]).toBe("domestic feline --");
        expect(updated[2]).toBe("cat");
        expect(updated[3]).toMatch(/^<!--SR:!2026-09-20,4,.+!2000-01-01,.+-->$/);
    });

    it("replaces an existing next-line SR without changing line count", () => {
        const lines = ["gato - cat", "<!--SR:!2026-09-01,2,5,1,0,2,2026-08-30-->"];
        const card = parseCard(lines, 0)!;
        expect(card.rawLines).toHaveLength(2);
        const newFront = sched("2026-09-20", 4);
        const updated = withUpdatedSchedules(card, [newFront, null]);
        expect(updated).toHaveLength(2);
        expect(updated[0]).toBe("gato - cat");
        expect(updated[1]).toMatch(/^<!--SR:!2026-09-20,4,.+!2000-01-01,.+-->$/);
    });

    it("round-trip: parse, update, re-parse yields new schedules", () => {
        const lines = ["gato - cat"];
        const card = parseCard(lines, 0)!;
        const newFront = sched("2026-09-20", 4, { difficulty: 5.5 });
        const newBack = sched("2026-09-25", 6, { difficulty: 4.5 });
        const updated = withUpdatedSchedules(card, [newFront, newBack]);
        const reparsed = parseCard(updated, 0)!;
        expect((reparsed.schedules[0] as ScheduleInfo).stability).toBe(4);
        expect((reparsed.schedules[0] as ScheduleInfo).difficulty).toBe(5.5);
        expect((reparsed.schedules[1] as ScheduleInfo).stability).toBe(6);
        expect(reparsed.fields.word).toBe("gato");
        expect(reparsed.fields.translation).toBe("cat");
    });
});
