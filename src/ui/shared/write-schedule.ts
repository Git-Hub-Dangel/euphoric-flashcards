import type { Vault } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import type { ParsedCard } from "src/parsing";
import { withUpdatedSchedules } from "src/parsing";
import type { ScheduleInfo } from "src/persistence";
import { PREFERRED_DATE_FORMAT } from "src/scheduling/constants";
import { writeCardBack } from "src/ui/review/load-cards";

export interface GradedFace {
    card: ParsedCard;
    filePath: string;
    faceIndex: 0 | 1;
}

// Persist a new schedule on one face of a card and mutate the in-memory
// ParsedCard so any queue entry that shares the same object sees the update.
// Returns the line-count delta so the caller can shift other in-memory
// references sitting below this card in the same file.
export async function writeGradedResponse(opts: {
    plugin: EuphoricFlashcardsPlugin;
    vault: Vault;
    fileCache: Map<string, string>;
    item: GradedFace;
    newSchedule: ScheduleInfo;
}): Promise<number> {
    const { plugin, vault, fileCache, item, newSchedule } = opts;

    const oldSchedule = item.card.schedules[item.faceIndex];
    const updatedSchedules: [ScheduleInfo | null, ScheduleInfo | null] = [
        item.card.schedules[0],
        item.card.schedules[1],
    ];
    updatedSchedules[item.faceIndex] = newSchedule;

    const newLines = withUpdatedSchedules(item.card, updatedSchedules, plugin.data.settings.baseEase);
    const oldLength = item.card.rawLines.length;
    await writeCardBack(vault, fileCache, item.filePath, item.card, newLines);

    if (plugin.data.settings.loadBalance) {
        const store = plugin.histogramStore;
        if (oldSchedule !== null) store.decrement(oldSchedule.dueDate.format(PREFERRED_DATE_FORMAT));
        store.increment(newSchedule.dueDate.format(PREFERRED_DATE_FORMAT));
        void plugin.saveData_();
    }

    item.card.rawLines = newLines;
    item.card.endLine = item.card.startLine + newLines.length - 1;
    item.card.schedules[item.faceIndex] = newSchedule;

    return newLines.length - oldLength;
}

// Shift startLine/endLine of every ParsedCard in `locations` that sits below
// `changedCard` in the same file. Dedupes by ParsedCard identity so a card
// present in multiple pools or twice in one queue is shifted at most once.
// The changedCard itself is excluded (its endLine has already been updated).
export function shiftLocationsForDelta(
    locations: Iterable<{ card: ParsedCard; filePath: string }>,
    changedCard: ParsedCard,
    filePath: string,
    delta: number,
): void {
    if (delta === 0) return;
    const originalStart = changedCard.startLine;
    const seen = new Set<ParsedCard>([changedCard]);
    for (const q of locations) {
        if (q.filePath !== filePath) continue;
        if (seen.has(q.card)) continue;
        seen.add(q.card);
        if (q.card.startLine > originalStart) {
            q.card.startLine += delta;
            q.card.endLine += delta;
        }
    }
}
