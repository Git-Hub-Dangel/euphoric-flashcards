import type { EuphoricSettings } from "src/settings";
import type { ParsedCard } from "src/parsing";
import { staggerIn } from "src/ui/modal-utils";
import { renderWordRow } from "src/ui/shared/word-row";

export interface SentenceWord {
    card: ParsedCard;
    faceIndex: 0 | 1;
}

export interface SentenceDrawOptions {
    settings: EuphoricSettings;
    /** Labels to draw the construction constraint pill from. Empty means no pill. */
    constraintPool: string[];
    /** Resolved at draw time so a caller can pick fresh words after the fade. */
    words: () => SentenceWord[];
    emptyText: string;
    /**
     * Rebuilds the surrounding chrome (header, action row) on every draw so it
     * replays its entrance animation. Recreating the elements is what triggers
     * the replay, so a caller must empty and rebuild rather than restyle.
     */
    renderChrome?: () => void;
}

/**
 * The sentence surface shared by Conjure Sentences and Learn. The list owns its
 * own padding and reading width, so a host must not centre or pad it.
 */
export function createSentenceList(host: HTMLElement): HTMLElement {
    return host.createDiv({ cls: "ef-cs-word-list" });
}

/** Fills the list with one constraint pill plus one row per word. */
export function drawSentence(listEl: HTMLElement, opts: SentenceDrawOptions): void {
    opts.renderChrome?.();
    fillSentence(listEl, opts);
}

function fillSentence(listEl: HTMLElement, opts: SentenceDrawOptions): void {
    const words = opts.words();
    listEl.empty();

    if (words.length === 0) {
        listEl.createEl("p", { text: opts.emptyText, cls: "ef-loading" });
        return;
    }

    let idx = 0;
    const label = opts.constraintPool[Math.floor(Math.random() * opts.constraintPool.length)];
    if (label !== undefined) {
        const pillWrap = listEl.createDiv({ cls: "ef-cc-pill-wrap" }, wrap => {
            wrap.createSpan({ text: label, cls: "ef-cc-pill" });
        });
        staggerIn(pillWrap, idx++);
    }

    for (const word of words) {
        staggerIn(renderWordRow(listEl, word, opts.settings), idx++);
    }
}

/** Redraw over an existing draw. Fades the outgoing pill first when animated. */
export function redrawSentence(listEl: HTMLElement, opts: SentenceDrawOptions): void {
    // Chrome replays immediately so the tap reads as acknowledged while the
    // outgoing pill is still fading.
    opts.renderChrome?.();
    const existingPill = listEl.querySelector<HTMLElement>(".ef-cc-pill");
    if (existingPill && opts.settings.animationDurationMs > 0) {
        existingPill.addClass("ef-fading");
        window.setTimeout(() => fillSentence(listEl, opts), 100);
        return;
    }
    fillSentence(listEl, opts);
}
