import { ConfirmationModal } from "obsidian";
import type { App } from "obsidian";

import type { ConversionReport } from "src/migration/convert-vault";
import type { EuphoricSettings } from "src/settings";
import { applyAnimationDuration, staggerIn } from "src/ui/modal-utils";

// The confirmation for the one-time SM-2 to FSRS conversion.
//
// Built on Obsidian's own ConfirmationModal (public since 1.13.0, which is this
// plugin's minAppVersion) rather than a hand-rolled Modal, so the button row,
// focus handling and escape behaviour are the ones users already know. Its
// buttons close the modal on click unless the handler returns truthy.
//
// Everything shown here comes from the dry run. The write is a second pass over
// the same walk, so the numbers in front of the user are the numbers that will
// be applied, provided the vault does not change in between.

// Long vaults are the normal case, so both lists scroll rather than being
// truncated. The user asked to see every affected file, and silently cutting the
// list is worse than a scrollbar.
interface Row {
    name: string;
    count: number;
}

function byCountThenName(a: Row, b: Row): number {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
}

function cardWord(n: number): string {
    return n === 1 ? "card" : "cards";
}

export class ConvertConfirmModal extends ConfirmationModal {
    private confirmed = false;

    constructor(
        app: App,
        settings: EuphoricSettings,
        private readonly report: ConversionReport,
        private readonly onConfirm: () => void,
        private readonly onDismiss: () => void,
    ) {
        super(app);
        applyAnimationDuration(this.containerEl, settings.animationDurationMs);
        this.addClass("ef-convert-modal");
        this.setTitle("Convert these cards to FSRS?");
        this.build();

        this.addButton(btn => btn
            .setButtonText("Convert")
            .setWarning()
            .onClick(() => {
                this.confirmed = true;
                this.onConfirm();
            }));
        // Cancel takes the initial focus: this rewrites notes and cannot be
        // undone, so a stray Enter must not start it.
        this.addCancelButton("Cancel");
    }

    // Dismissal covers Cancel, Escape and a click outside, none of which give a
    // callback of their own. The caller holds a reentrancy lock from the moment
    // the button was pressed, so it has to be told when the run is abandoned.
    onClose(): void {
        super.onClose();
        if (!this.confirmed) this.onDismiss();
    }

    private build(): void {
        const r = this.report;
        const body = this.contentEl.createDiv({ cls: "ef-convert-body" });
        let step = 0;

        const summary = body.createDiv({ cls: "ef-convert-summary" });
        summary.setText(
            `${r.commentsConverted} ${cardWord(r.commentsConverted)} ` +
            `(${r.facesSeeded} faces) across ${r.filesChanged} of ` +
            `${r.notesInScope} notes in your decks.`,
        );
        staggerIn(summary, step++);

        const decks: Row[] = Object.entries(r.decks)
            .map(([name, count]) => ({ name, count }))
            .sort(byCountThenName);
        step = this.renderSection(body, "Decks", decks, step, false);

        const files: Row[] = r.affected
            .map(f => ({ name: f.path, count: f.cards }))
            .sort(byCountThenName);
        step = this.renderSection(body, "Notes", files, step, true);

        const notes: string[] = [];
        if (r.alreadyFsrs > 0) {
            notes.push(`${r.alreadyFsrs} already use the FSRS format and will be skipped.`);
        }
        if (r.malformed > 0) {
            notes.push(`${r.malformed} could not be read and will be left untouched.`);
        }
        if (r.errors.length > 0) {
            notes.push(`${r.errors.length} files could not be opened.`);
        }
        if (notes.length > 0) {
            const el = body.createDiv({ cls: "ef-convert-note" });
            el.setText(notes.join(" "));
            staggerIn(el, step++);
        }

        const warn = body.createDiv({ cls: "ef-convert-warning" });
        warn.setText("This rewrites the notes listed above in place and cannot be undone.");
        staggerIn(warn, step);
    }

    // Returns the next stagger index so the sections keep one running sequence.
    private renderSection(
        host: HTMLElement,
        heading: string,
        rows: Row[],
        step: number,
        scroll: boolean,
    ): number {
        if (rows.length === 0) return step;

        const section = host.createDiv({ cls: "ef-convert-section" });
        section.createDiv({ cls: "ef-convert-section-title", text: `${heading} (${rows.length})` });

        const list = section.createEl("ul", {
            cls: scroll ? "ef-convert-list ef-convert-list-scroll" : "ef-convert-list",
        });
        for (const row of rows) {
            const li = list.createEl("li", { cls: "ef-convert-row" });
            li.createSpan({ cls: "ef-convert-name", text: row.name });
            li.createSpan({ cls: "ef-convert-count", text: String(row.count) });
        }

        staggerIn(section, step);
        return step + 1;
    }
}
