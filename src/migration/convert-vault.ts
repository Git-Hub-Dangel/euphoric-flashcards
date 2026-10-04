import type { Vault } from "obsidian";

import { convertContent } from "src/migration/legacy-sr";
import type { ContentResult } from "src/migration/legacy-sr";
import { normaliseRootTags } from "src/decks/tag-scope";

// The vault walk for the one-time SM-2 to FSRS conversion (plan §P5.3 to §P5.5).
//
// The `obsidian` import here is type-only and erased at build time, so this
// module stays importable from a plain Node test the same way histogram-store.ts
// does. All of the format knowledge lives in legacy-sr.ts.

export interface ConversionReport {
    filesScanned: number;
    // Notes holding at least one line inside a configured deck. The rest are
    // read and left alone, so this is the honest denominator for the report.
    notesInScope: number;
    // True when no root deck tags are configured. Nothing is scanned in that
    // case, and the caller says so rather than reporting an empty success.
    noRootTags: boolean;
    filesChanged: number;
    commentsConverted: number;
    facesSeeded: number;
    alreadyFsrs: number;
    malformed: number;
    // Files whose read or write threw. Their contents are left untouched.
    errors: string[];
    // The notes a run would change, with how many cards each holds. Only notes
    // with at least one convertible card appear. Feeds the confirmation dialog.
    affected: AffectedFile[];
    // Cards per deck tag across the whole run, as the user wrote the tag.
    decks: Record<string, number>;
}

export interface AffectedFile {
    path: string;
    cards: number;
}

function emptyReport(): ConversionReport {
    return {
        filesScanned: 0,
        notesInScope: 0,
        noRootTags: false,
        filesChanged: 0,
        commentsConverted: 0,
        facesSeeded: 0,
        alreadyFsrs: 0,
        malformed: 0,
        errors: [],
        affected: [],
        decks: {},
    };
}

// Fold one note's result into the report. Shared by both branches so the dry
// run and the real write cannot report different detail, which matters now that
// the dry run's numbers are shown in a confirmation the user acts on.
function absorb(report: ConversionReport, path: string, result: ContentResult): void {
    report.commentsConverted += result.commentsConverted;
    report.facesSeeded += result.facesSeeded;
    report.alreadyFsrs += result.alreadyFsrs;
    report.malformed += result.malformed;
    if (result.inScope) report.notesInScope++;
    if (result.commentsConverted > 0) {
        report.affected.push({ path, cards: result.commentsConverted });
    }
    for (const [deck, n] of Object.entries(result.deckCounts)) {
        report.decks[deck] = (report.decks[deck] ?? 0) + n;
    }
}

// One pass over every markdown file. With `write: false` nothing is modified and
// the report is the dry run (§P5.4); with `write: true` the same walk persists
// the converted notes (§P5.5).
//
// **Scoped to `rootTags`.** Every markdown file is read, but only lines inside a
// configured deck region are rewritten. A vault holds plenty of notes that are
// nothing to do with this plugin, and an `<!--SR:!...-->` comment is not proof
// of ownership, so a whole-vault rewrite could alter data the plugin never
// scheduled. With no root tags configured the run converts nothing at all.
//
// Writes go through `vault.process`, Obsidian's atomic read-modify-write, rather
// than a read followed by a modify: the converter rewrites whole notes outside
// any review session, so it must not clobber a change made between the two.
//
// A file that throws is recorded and skipped rather than aborting the run, so one
// unreadable note cannot leave the vault half-converted.
export async function runConversion(
    vault: Vault,
    opts: { write: boolean; rootTags: string[] },
): Promise<ConversionReport> {
    const report = emptyReport();

    // Guard first. Without this an empty root list would read every note and
    // report a clean no-op, which looks identical to a converted vault.
    if (normaliseRootTags(opts.rootTags).length === 0) {
        report.noRootTags = true;
        return report;
    }

    for (const file of vault.getMarkdownFiles()) {
        report.filesScanned++;
        try {
            if (opts.write) {
                let changed = false;
                await vault.process(file, (data: string): string => {
                    const result = convertContent(data, opts.rootTags);
                    absorb(report, file.path, result);
                    changed = result.commentsConverted > 0;
                    return changed ? result.content : data;
                });
                if (changed) report.filesChanged++;
            } else {
                const result = convertContent(await vault.cachedRead(file), opts.rootTags);
                absorb(report, file.path, result);
                if (result.commentsConverted > 0) report.filesChanged++;
            }
        } catch (err) {
            report.errors.push(file.path);
            console.error(`EuphoricFlashcards: conversion failed for ${file.path}`, err);
        }
    }

    return report;
}

// One line for the Notice the settings button raises.
export function describeReport(report: ConversionReport, dryRun: boolean): string {
    const sentences: string[] = [];

    if (report.noRootTags) {
        return "No root deck tags are configured, so there is nothing to convert. "
            + "Add your deck tags at the top of these settings first.";
    }

    if (report.commentsConverted === 0) {
        sentences.push("No SM-2 cards found in your decks");
        if (report.alreadyFsrs > 0) {
            sentences.push(`${report.alreadyFsrs} cards already use the FSRS format`);
        }
    } else {
        const verb = dryRun ? "Would convert" : "Converted";
        sentences.push(
            `${verb} ${report.commentsConverted} cards (${report.facesSeeded} faces) ` +
            `across ${report.filesChanged} of ${report.notesInScope} notes in your decks`,
        );
    }

    if (report.malformed > 0) sentences.push(`${report.malformed} unreadable, left untouched`);
    if (report.errors.length > 0) sentences.push(`${report.errors.length} files could not be read`);

    return sentences.join(". ") + ".";
}
