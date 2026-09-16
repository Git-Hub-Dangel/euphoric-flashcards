import type { Vault } from "obsidian";
import { Moment } from "moment";

import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { parseScheduleComment } from "src/persistence/comment-parser";
import { DUMMY_DUE_DATE_FOR_NEW_CARD, PREFERRED_DATE_FORMAT } from "src/scheduling/constants";
import { DateUtil } from "src/scheduling/dates";

const SR_COMMENT_RE = /<!--SR:!.+?-->/g;

// persisted state — kept in sync with PluginData fields by reference.
export interface HistogramState {
    data: Record<string, number>;
    builtAt: string | null;
}

// adapter around the persisted histogram.
// mutates `state` in place so the plugin's data.json reflects changes on next save.
export class HistogramStore {
    private state: HistogramState;

    constructor(state: HistogramState) {
        this.state = state;
    }

    getBuiltAt(): string | null {
        return this.state.builtAt;
    }

    isEmpty(): boolean {
        return Object.keys(this.state.data).length === 0;
    }

    increment(dueDateISO: string): void {
        if (dueDateISO === DUMMY_DUE_DATE_FOR_NEW_CARD) return;
        this.state.data[dueDateISO] = (this.state.data[dueDateISO] ?? 0) + 1;
    }

    decrement(dueDateISO: string): void {
        if (dueDateISO === DUMMY_DUE_DATE_FOR_NEW_CARD) return;
        const v = this.state.data[dueDateISO] ?? 0;
        if (v <= 1) delete this.state.data[dueDateISO];
        else this.state.data[dueDateISO] = v - 1;
    }

    // snapshot into the algorithm's expected shape (days-from-today → count).
    toRelativeHistogram(today: Moment): DueDateHistogram {
        const h = new DueDateHistogram();
        const todayStart = today.clone().startOf("day");
        for (const [iso, count] of Object.entries(this.state.data)) {
            const d = DateUtil.dateStrToMoment(iso);
            if (!d.isValid()) continue;
            const days = d.startOf("day").diff(todayStart, "days");
            h.set(days, count);
        }
        return h;
    }

    // full vault rescan. overwrites state.data, so entries for deleted or
    // edited-away cards are automatically purged.
    async rebuild(vault: Vault): Promise<void> {
        const fresh: Record<string, number> = {};
        const files = vault.getMarkdownFiles();
        for (const file of files) {
            const content = await vault.read(file);
            let m: RegExpExecArray | null;
            SR_COMMENT_RE.lastIndex = 0;
            while ((m = SR_COMMENT_RE.exec(content)) !== null) {
                const schedules = parseScheduleComment(m[0]);
                for (const s of schedules) {
                    if (s === null) continue;
                    const iso = s.dueDate.format(PREFERRED_DATE_FORMAT);
                    if (iso === DUMMY_DUE_DATE_FOR_NEW_CARD) continue;
                    fresh[iso] = (fresh[iso] ?? 0) + 1;
                }
            }
        }
        this.state.data = fresh;
        this.state.builtAt = new Date().toISOString();
    }
}
