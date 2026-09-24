import { Platform, setIcon } from "obsidian";
import type { EuphoricSettings } from "src/settings";
import { staggerIn } from "src/ui/modal-utils";

export interface ResponseButtonOptions {
    /** 1-based position, drives both the badge digit and the stagger index. */
    keyNum: number;
    label: string;
    /** Variant class such as ef-btn-good. */
    cls: string;
    icon: string;
    /** Preview interval rendered under the label. Omit when there is none. */
    interval?: string | null;
    onClick: () => void;
}

/**
 * Footer response button shared by Review, Learn and Conjure Sentences.
 * Key registration stays with the caller because each modal owns its keymap.
 */
export function renderResponseButton(
    container: HTMLElement,
    settings: EuphoricSettings,
    opts: ResponseButtonOptions,
): HTMLButtonElement {
    const btn = container.createEl("button", { cls: `ef-btn ef-btn-response ${opts.cls}` });
    staggerIn(btn, opts.keyNum - 1);
    if (Platform.isDesktop && settings.showKeybindingsOnDesktop) {
        btn.createSpan({ text: String(opts.keyNum), cls: "ef-btn-key" });
    }
    setIcon(btn.createSpan({ cls: "ef-btn-icon" }), opts.icon);
    const textEl = btn.createSpan({ cls: "ef-btn-text" });
    textEl.createSpan({ text: opts.label, cls: "ef-btn-label" });
    if (opts.interval !== null && opts.interval !== undefined) {
        textEl.createSpan({ text: opts.interval, cls: "ef-btn-interval" });
    }
    btn.addEventListener("click", opts.onClick);
    return btn;
}
