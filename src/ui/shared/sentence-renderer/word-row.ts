import { setIcon } from "obsidian";
import { frontFace, backFace, cardReveal } from "src/parsing";
import type { ParsedCard } from "src/parsing";
import type { EuphoricSettings } from "src/settings";
import { staggerIn } from "src/ui/modal-utils";

export interface WordRowInput {
    card: ParsedCard;
    faceIndex: 0 | 1;
}

// Renders one row of the Conjure-Sentences-style word list: prompt + Reveal
// toggle that reveals the answer, type badge, explanation, and examples.
// The revealed content animates via staggerIn once per reveal.
export function renderWordRow(
    container: HTMLElement,
    item: WordRowInput,
    settings: EuphoricSettings,
): HTMLElement {
    const face = item.faceIndex === 0 ? frontFace(item.card) : backFace(item.card);
    const reveal = cardReveal(item.card);

    const row = container.createDiv({ cls: "ef-cs-word-row" });

    const promptRow = row.createDiv({ cls: "ef-cs-prompt-row" });
    promptRow.createSpan({ text: face.prompt, cls: "ef-cs-word-text" });

    const revealBtn = promptRow.createEl("button", { cls: "ef-btn ef-cs-reveal-btn" });
    const revealBtnIcon = revealBtn.createSpan({ cls: "ef-btn-icon" });
    setIcon(revealBtnIcon, "eye");
    revealBtn.createSpan({ text: "Reveal" });

    const revealArea = row.createDiv({ cls: "ef-cs-reveal-area ef-hidden" });

    revealArea.createDiv({ cls: "ef-card-answer-line" }, line => {
        line.createSpan({ text: face.answer, cls: "ef-cs-word-answer" });
        if (reveal.type) {
            const tc = settings.cardTypes.find(t => t.key === reveal.type);
            const badge = line.createSpan({
                text: tc?.label ?? reveal.type,
                cls: "ef-type-badge",
            });
            badge.setCssStyles({ backgroundColor: tc?.color ?? "var(--background-modifier-border)" });
        }
    });

    if (reveal.explanation) {
        revealArea.createEl("p", { text: reveal.explanation, cls: "ef-explanation" });
    }
    if (reveal.examples.length > 0) {
        const list = revealArea.createDiv({ cls: "ef-examples" });
        for (const ex of reveal.examples) {
            list.createDiv({ text: `"${ex}"`, cls: "ef-example-item" });
        }
    }

    revealBtn.addEventListener("click", () => {
        const isHidden = revealArea.hasClass("ef-hidden");
        revealArea.toggleClass("ef-hidden", !isHidden);
        setIcon(revealBtnIcon, isHidden ? "eye-off" : "eye");
        if (isHidden) staggerIn(revealArea, 0);
    });

    return row;
}
