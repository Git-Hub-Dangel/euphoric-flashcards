import type { Vault } from "obsidian";

import { convertContent } from "src/migration/legacy-sr";

// The vault walk for the one-time SM-2 to FSRS conversion (plan §P5.3 to §P5.5).
//
// The `obsidian` import here is type-only and erased at build time, so this
// module stays importable from a plain Node test the same way histogram-store.ts
// does. All of the format knowledge lives in legacy-sr.ts.

export interface ConversionReport {
    filesScanned: number;
    filesChanged: number;
    commentsConverted: number;
    facesSeeded: number;
    alreadyFsrs: number;
    malformed: number;
    // Files whose read or write threw. Their contents are left untouched.
    errors: string[];
}

function emptyReport(): ConversionReport {
    return {
        filesScanned: 0,
        filesChanged: 0,
        commentsConverted: 0,
        facesSeeded: 0,
        alreadyFsrs: 0,
        malformed: 0,
        errors: [],
    };
}

// One pass over every markdown file. With `write: false` nothing is modified and
// the report is the dry run (§P5.4); with `write: true` the same walk persists
// the converted notes (§P5.5).
//
// Writes go through `vault.process`, Obsidian's atomic read-modify-write, rather
// than a read followed by a modify: the converter rewrites whole notes outside
// any review session, so it must not clobber a change made between the two.
//
// A file that throws is recorded and skipped rather than aborting the run, so one
// unreadable note cannot leave the vault half-converted.
export async function runConversion(
    vault: Vault,
    opts: { write: boolean },
): Promise<ConversionReport> {
    const report = emptyReport();

    for (const file of vault.getMarkdownFiles()) {
        report.filesScanned++;
        try {
            if (opts.write) {
                let changed = false;
                await vault.process(file, (data: string): string => {
                    const result = convertContent(data);
                    report.commentsConverted += result.commentsConverted;
                    report.facesSeeded += result.facesSeeded;
                    report.alreadyFsrs += result.alreadyFsrs;
                    report.malformed += result.malformed;
                    changed = result.commentsConverted > 0;
                    return changed ? result.content : data;
                });
                if (changed) report.filesChanged++;
            } else {
                const result = convertContent(await vault.cachedRead(file));
                report.commentsConverted += result.commentsConverted;
                report.facesSeeded += result.facesSeeded;
                report.alreadyFsrs += result.alreadyFsrs;
                report.malformed += result.malformed;
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

    if (report.commentsConverted === 0) {
        sentences.push("No SM-2 cards found");
        if (report.alreadyFsrs > 0) {
            sentences.push(`${report.alreadyFsrs} cards already use the FSRS format`);
        }
    } else {
        const verb = dryRun ? "Would convert" : "Converted";
        sentences.push(
            `${verb} ${report.commentsConverted} cards (${report.facesSeeded} faces) ` +
            `across ${report.filesChanged} of ${report.filesScanned} notes`,
        );
    }

    if (report.malformed > 0) sentences.push(`${report.malformed} unreadable, left untouched`);
    if (report.errors.length > 0) sentences.push(`${report.errors.length} files could not be read`);

    return sentences.join(". ") + ".";
}
