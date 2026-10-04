import { describe, expect, it } from "vitest";

import type { Vault } from "obsidian";
import { describeReport, runConversion } from "src/migration/convert-vault";

const LEGACY = "<!--SR:!2026-09-26,5,203!2026-09-30,6,223-->";
const ROOTS = ["#espanol"];

// runConversion only ever calls getMarkdownFiles, cachedRead and process, so a
// map of path -> contents is a sufficient stand-in. The obsidian import above is
// type-only and erased, exactly as in convert-vault.ts itself.
function fakeVault(files: Record<string, string>, unreadable: string[] = []): {
    vault: Vault;
    files: Record<string, string>;
} {
    const store = { ...files };
    const vault = {
        getMarkdownFiles: () => Object.keys(store).map(path => ({ path })),
        cachedRead: async (file: { path: string }): Promise<string> => {
            if (unreadable.includes(file.path)) throw new Error("unreadable");
            return store[file.path] ?? "";
        },
        process: async (file: { path: string }, fn: (data: string) => string): Promise<string> => {
            if (unreadable.includes(file.path)) throw new Error("unreadable");
            const next = fn(store[file.path] ?? "");
            store[file.path] = next;
            return next;
        },
    } as unknown as Vault;
    return { vault, files: store };
}

describe("runConversion", () => {
    it("reports what it would do without writing anything", async () => {
        const { vault, files } = fakeVault({
            "a.md": `#espanol\nuno - one\n${LEGACY}\n`,
            "b.md": "# empty\n",
        });
        const report = await runConversion(vault, { write: false, rootTags: ROOTS });

        expect(report.filesScanned).toBe(2);
        expect(report.filesChanged).toBe(1);
        expect(report.commentsConverted).toBe(1);
        expect(report.facesSeeded).toBe(2);
        // The dry run is the whole point: the note is byte-identical afterwards.
        expect(files["a.md"]).toBe(`#espanol\nuno - one\n${LEGACY}\n`);
    });

    it("writes the converted notes when asked to", async () => {
        const { vault, files } = fakeVault({ "a.md": `#espanol\nuno - one\n${LEGACY}\n` });
        const report = await runConversion(vault, { write: true, rootTags: ROOTS });

        expect(report.commentsConverted).toBe(1);
        expect(report.filesChanged).toBe(1);
        expect(files["a.md"]).not.toContain(LEGACY);
        expect(files["a.md"]).toContain("uno - one");
    });

    it("leaves a note with nothing to convert untouched", async () => {
        const { vault, files } = fakeVault({ "a.md": "# notes\n" });
        const report = await runConversion(vault, { write: true, rootTags: ROOTS });

        expect(report.filesChanged).toBe(0);
        expect(files["a.md"]).toBe("# notes\n");
    });

    it("is a no-op on a second run", async () => {
        const { vault } = fakeVault({ "a.md": `#espanol\nuno - one\n${LEGACY}\n` });
        await runConversion(vault, { write: true, rootTags: ROOTS });
        const second = await runConversion(vault, { write: true, rootTags: ROOTS });

        expect(second.commentsConverted).toBe(0);
        expect(second.filesChanged).toBe(0);
        expect(second.alreadyFsrs).toBe(1);
    });

    // One bad note must not leave the rest of the vault half-converted.
    it("records a failed file and carries on", async () => {
        const { vault, files } = fakeVault(
            { "bad.md": `#espanol\nx - y\n${LEGACY}\n`, "good.md": `#espanol\na - b\n${LEGACY}\n` },
            ["bad.md"],
        );
        const report = await runConversion(vault, { write: true, rootTags: ROOTS });

        expect(report.errors).toEqual(["bad.md"]);
        expect(report.commentsConverted).toBe(1);
        expect(files["good.md"]).not.toContain(LEGACY);
        expect(files["bad.md"]).toContain(LEGACY);
    });
});

describe("describeReport", () => {
    const base = {
        filesScanned: 10,
        notesInScope: 6,
        noRootTags: false,
        filesChanged: 3,
        commentsConverted: 12,
        facesSeeded: 20,
        alreadyFsrs: 0,
        malformed: 0,
        errors: [],
    };

    it("uses the conditional voice for a dry run", () => {
        expect(describeReport(base, true)).toContain("Would convert 12 cards");
    });

    it("uses the past tense after a real run", () => {
        expect(describeReport(base, false)).toContain("Converted 12 cards");
    });

    it("says so plainly when there is nothing to convert", () => {
        const report = { ...base, commentsConverted: 0, filesChanged: 0, alreadyFsrs: 40 };
        const text = describeReport(report, false);
        expect(text).toContain("No SM-2 cards found");
        expect(text).toContain("40 cards already use the FSRS format");
    });

    it("surfaces unreadable comments and failed files", () => {
        const report = { ...base, malformed: 2, errors: ["x.md"] };
        const text = describeReport(report, false);
        expect(text).toContain("2 unreadable");
        expect(text).toContain("1 files could not be read");
    });
});

// Vault-level scoping. The dry run and the real run must agree on scope, because
// the dry run is what the user is shown before anything is written.
describe("runConversion deck scoping", () => {
    it("never writes to a note outside the configured decks", async () => {
        const outside = `shopping - list\n${LEGACY}\n`;
        const { vault, files } = fakeVault({
            "deck.md": `#espanol\nuno - one\n${LEGACY}\n`,
            "notes/random.md": outside,
            "notes/other.md": "# nothing\n",
        });
        const report = await runConversion(vault, { write: true, rootTags: ROOTS });

        expect(report.commentsConverted).toBe(1);
        expect(report.filesChanged).toBe(1);
        // Every markdown file is still read, so the scan count is unchanged.
        expect(report.filesScanned).toBe(3);
        // Only one of them held a deck region.
        expect(report.notesInScope).toBe(1);
        // The out-of-deck note is byte-identical. This is the whole point.
        expect(files["notes/random.md"]).toBe(outside);
        expect(files["notes/other.md"]).toBe("# nothing\n");
        expect(files["deck.md"]).not.toContain(LEGACY);
    });

    it("agrees with the dry run about what it will touch", async () => {
        const build = (): Record<string, string> => ({
            "deck.md": `#espanol\nuno - one\n${LEGACY}\n`,
            "outside.md": `x - y\n${LEGACY}\n`,
        });
        const dry = await runConversion(fakeVault(build()).vault, { write: false, rootTags: ROOTS });
        const wet = await runConversion(fakeVault(build()).vault, { write: true, rootTags: ROOTS });

        expect(dry.commentsConverted).toBe(wet.commentsConverted);
        expect(dry.notesInScope).toBe(wet.notesInScope);
        expect(dry.filesChanged).toBe(wet.filesChanged);
    });

    it("writes nothing and says why when no root deck tags are configured", async () => {
        const original = `#espanol\nuno - one\n${LEGACY}\n`;
        const { vault, files } = fakeVault({ "deck.md": original });
        const report = await runConversion(vault, { write: true, rootTags: [] });

        expect(report.noRootTags).toBe(true);
        expect(report.commentsConverted).toBe(0);
        // Not even read, so the scan count stays at zero rather than looking
        // like a vault that simply had nothing to convert.
        expect(report.filesScanned).toBe(0);
        expect(files["deck.md"]).toBe(original);
        expect(describeReport(report, true)).toContain("No root deck tags are configured");
    });

    it("picks up subdecks of a root tag", async () => {
        const { vault, files } = fakeVault({
            "a.md": `#espanol/verbos/irregulares\nir - to go\n${LEGACY}\n`,
        });
        const report = await runConversion(vault, { write: true, rootTags: ROOTS });
        expect(report.commentsConverted).toBe(1);
        expect(files["a.md"]).not.toContain(LEGACY);
    });
});
