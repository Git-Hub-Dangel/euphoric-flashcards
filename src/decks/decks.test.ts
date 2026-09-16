import { describe, expect, it } from "vitest";

import { buildDeckTree, flattenDeckTree, FileLines } from "src/decks/deck-tree";

const TODAY = new Date("2023-09-06");

function build(files: FileLines[], rootTags: string[]) {
    return buildDeckTree(files, { rootTags, today: TODAY });
}

// ---------------------------------------------------------------------------
// Tag recognition
// ---------------------------------------------------------------------------

describe("buildDeckTree — tag recognition", () => {
    it("ignores files with no recognised tags", () => {
        const tree = build(
            [{ path: "notes.md", lines: ["hello world", "#unrelated", "word - translation"] }],
            ["#vocab"],
        );
        expect(tree.get("#vocab")!.stats.total).toBe(0);
    });

    it("recognises root tag exactly", () => {
        const tree = build(
            [{ path: "f.md", lines: ["#vocab", "word - translation"] }],
            ["#vocab"],
        );
        const root = tree.get("#vocab")!;
        expect(root.stats.total).toBe(1);
    });

    it("recognises nested tag under root", () => {
        const tree = build(
            [{ path: "f.md", lines: ["#vocab/nouns", "cat - gato"] }],
            ["#vocab"],
        );
        const root = tree.get("#vocab")!;
        expect(root.stats.total).toBe(1);
        expect(root.children.has("nouns")).toBe(true);
    });

    it("is case-insensitive for root matching", () => {
        const tree = build(
            [{ path: "f.md", lines: ["#Vocab", "word - translation"] }],
            ["#vocab"],
        );
        expect(tree.get("#vocab")!.stats.total).toBe(1);
    });

    it("does not treat tags outside the root as deck tags", () => {
        const tree = build(
            [{ path: "f.md", lines: ["#other/tag", "word - translation"] }],
            ["#vocab"],
        );
        expect(tree.get("#vocab")!.stats.total).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Cut-off semantics
// ---------------------------------------------------------------------------

describe("buildDeckTree — cut-off line semantics", () => {
    it("cards belong to the tag above them until the next recognised tag", () => {
        const lines = [
            "#vocab/nouns",
            "cat - gato",
            "dog - perro",
            "#vocab/verbs",
            "run - correr",
        ];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        const nouns = tree.get("#vocab")!.children.get("nouns")!;
        const verbs = tree.get("#vocab")!.children.get("verbs")!;
        expect(nouns.stats.total).toBe(2);
        expect(verbs.stats.total).toBe(1);
    });

    it("cards before any tag are ignored", () => {
        const lines = ["word - translation", "#vocab", "another - word"];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.total).toBe(1);
    });

    it("last tag on a multi-tag line wins", () => {
        // Both tags on same line — the last recognised one becomes active.
        const lines = ["#vocab/nouns  #vocab/verbs", "run - correr"];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        // "verbs" is the later tag
        const root = tree.get("#vocab")!;
        expect(root.children.has("verbs")).toBe(true);
        expect(root.children.get("verbs")!.stats.total).toBe(1);
    });

    it("an unrecognised tag between two recognised tags does not reset the active deck", () => {
        const lines = [
            "#vocab/nouns",
            "cat - gato",
            "#grammar",   // unrecognised root
            "dog - perro",
        ];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        const nouns = tree.get("#vocab")!.children.get("nouns")!;
        expect(nouns.stats.total).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Nested deck tree
// ---------------------------------------------------------------------------

describe("buildDeckTree — nested deck tree", () => {
    it("builds intermediate nodes for deep paths", () => {
        const lines = ["#vocab/2023/09/words", "mesa - table"];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        const root = tree.get("#vocab")!;
        const y = root.children.get("2023");
        expect(y).toBeDefined();
        const m = y!.children.get("09");
        expect(m).toBeDefined();
        expect(m!.children.get("words")!.stats.total).toBe(1);
    });

    it("stats bubble up through intermediate nodes", () => {
        const lines = [
            "#vocab/a",
            "word1 - t1",
            "#vocab/a/b",
            "word2 - t2",
            "word3 - t3",
        ];
        const tree = build([{ path: "f.md", lines }], ["#vocab"]);
        const root = tree.get("#vocab")!;
        const a = root.children.get("a")!;
        // a directly has 1 card; a/b has 2; bubbled total at a = 3
        expect(root.stats.total).toBe(3);
        expect(a.stats.total).toBe(3);
        expect(a.children.get("b")!.stats.total).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Card classification: new vs due vs scheduled-not-due
// ---------------------------------------------------------------------------

describe("buildDeckTree — card status", () => {
    it("card with no SR comment is new", () => {
        const tree = build(
            [{ path: "f.md", lines: ["#vocab", "word - translation"] }],
            ["#vocab"],
        );
        expect(tree.get("#vocab")!.stats.new).toBe(1);
        expect(tree.get("#vocab")!.stats.due).toBe(0);
    });

    it("card with SR comment due on today is due", () => {
        // TODAY is 2023-09-06; a due date of 2023-09-06 should be due
        const line = "word - translation <!--SR:!2023-09-06,4,250-->";
        const tree = build([{ path: "f.md", lines: ["#vocab", line] }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.due).toBe(1);
        expect(tree.get("#vocab")!.stats.new).toBe(0);
    });

    it("card with SR comment due in the past is due", () => {
        const line = "word - translation <!--SR:!2023-09-01,4,250-->";
        const tree = build([{ path: "f.md", lines: ["#vocab", line] }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.due).toBe(1);
    });

    it("card with SR comment due in the future is not due and not new", () => {
        const line = "word - translation <!--SR:!2099-01-01,4,250-->";
        const tree = build([{ path: "f.md", lines: ["#vocab", line] }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.due).toBe(0);
        expect(tree.get("#vocab")!.stats.new).toBe(0);
        expect(tree.get("#vocab")!.stats.total).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Skippable lines
// ---------------------------------------------------------------------------

describe("buildDeckTree — skippable lines", () => {
    it("blank lines are not cards", () => {
        const tree = build([{ path: "f.md", lines: ["#vocab", "", "  "] }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.total).toBe(0);
    });

    it("Markdown headings are not cards", () => {
        const tree = build([{ path: "f.md", lines: ["#vocab", "## Heading"] }], ["#vocab"]);
        expect(tree.get("#vocab")!.stats.total).toBe(0);
    });

    it("code fences are not cards", () => {
        const tree = build([{ path: "f.md", lines: ["#vocab", "```", "code", "```"] }], ["#vocab"]);
        // Only "code" inside the fence counts (fences themselves are skipped)
        // We don't parse fence bodies specially — only the ``` lines are skipped
        expect(tree.get("#vocab")!.stats.total).toBe(1); // "code" line counts
    });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

describe("buildDeckTree — multiple files", () => {
    it("aggregates cards across files into the same deck node", () => {
        const files: FileLines[] = [
            { path: "a.md", lines: ["#vocab", "word1 - t1"] },
            { path: "b.md", lines: ["#vocab", "word2 - t2", "word3 - t3"] },
        ];
        const tree = build(files, ["#vocab"]);
        expect(tree.get("#vocab")!.stats.total).toBe(3);
    });

    it("CardLocation records the correct filePath and lineIndex", () => {
        const files: FileLines[] = [
            { path: "notes.md", lines: ["#vocab", "hello - hola"] },
        ];
        const tree = build(files, ["#vocab"]);
        const cards = tree.get("#vocab")!.cards;
        expect(cards).toHaveLength(1);
        const card = cards[0]!;
        expect(card.filePath).toBe("notes.md");
        expect(card.lineIndex).toBe(1);
        expect(card.deckTag).toBe("#vocab");
    });
});

// ---------------------------------------------------------------------------
// Multiple root tags
// ---------------------------------------------------------------------------

describe("buildDeckTree — multiple root tags", () => {
    it("supports two independent root tags", () => {
        const files: FileLines[] = [
            { path: "a.md", lines: ["#vocab", "word1 - t1"] },
            { path: "b.md", lines: ["#grammar", "rule - explanation"] },
        ];
        const tree = build(files, ["#vocab", "#grammar"]);
        expect(tree.get("#vocab")!.stats.total).toBe(1);
        expect(tree.get("#grammar")!.stats.total).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// flattenDeckTree
// ---------------------------------------------------------------------------

describe("flattenDeckTree", () => {
    it("returns root + all descendants in depth-first order", () => {
        const files: FileLines[] = [
            { path: "f.md", lines: ["#vocab/a", "w1", "#vocab/a/b", "w2", "#vocab/c", "w3"] },
        ];
        const tree = build(files, ["#vocab"]);
        const flat = flattenDeckTree(tree);
        const paths = flat.map((n) => n.fullPath);
        expect(paths).toContain("vocab");
        expect(paths).toContain("vocab/a");
        expect(paths).toContain("vocab/a/b");
        expect(paths).toContain("vocab/c");
        // root appears before its children
        expect(paths.indexOf("vocab")).toBeLessThan(paths.indexOf("vocab/a"));
    });
});
