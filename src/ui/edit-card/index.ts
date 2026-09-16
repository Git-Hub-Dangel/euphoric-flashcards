import { App, Modal } from "obsidian";
import { preventBgTapDismiss } from "src/ui/modal-utils";

export interface EditCardModalOptions {
    initialText: string;
    // Return an error message to display or
    // null on success. If null is returned, the modal closes.
    onSave: (newText: string) => Promise<string | null>;
    onClose?: () => void;
}

export class EditCardModal extends Modal {
    private readonly opts: EditCardModalOptions;
    constructor(app: App, opts: EditCardModalOptions) {
        super(app);
        this.opts = opts;
    }

    onOpen(): void {
        preventBgTapDismiss(this.containerEl);
        this.modalEl.addClass("ef-edit-modal");
        this.contentEl.empty();

        this.contentEl.createEl("h3", { text: "Edit card", cls: "ef-edit-title" });

        const textarea = this.contentEl.createEl("textarea", {
            cls: "ef-edit-textarea",
        });
        textarea.value = this.opts.initialText;
        textarea.rows = Math.min(20, Math.max(4, this.opts.initialText.split("\n").length + 1));

        const errorEl = this.contentEl.createDiv({ cls: "ef-edit-error ef-hidden" });

        const actions = this.contentEl.createDiv({ cls: "ef-edit-actions" });
        const cancelBtn = actions.createEl("button", { text: "Cancel", cls: "ef-btn" });
        const saveBtn = actions.createEl("button", { text: "Save", cls: "ef-btn ef-btn-primary" });

        cancelBtn.addEventListener("click", () => this.close());
        saveBtn.addEventListener("click", () => {
            void (async (): Promise<void> => {
                saveBtn.disabled = true;
                cancelBtn.disabled = true;
                errorEl.addClass("ef-hidden");
                const err = await this.opts.onSave(textarea.value);
                if (err === null) {
                    this.close();
                    return;
                }
                errorEl.setText(err);
                errorEl.removeClass("ef-hidden");
                saveBtn.disabled = false;
                cancelBtn.disabled = false;
            })();
        });

        window.setTimeout(() => textarea.focus(), 0);
    }

    onClose(): void {
        this.contentEl.empty();
        this.opts.onClose?.();
    }
}
