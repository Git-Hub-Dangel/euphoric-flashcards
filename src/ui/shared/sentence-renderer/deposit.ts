import { Notice, Platform } from "obsidian";
import type { TFile, Vault } from "obsidian";
import type { EuphoricSettings } from "src/settings";
import { getKeyboardHeight, onKeyboardChange, sampleKeyboardSoon, staggerIn } from "src/ui/modal-utils";
import { composeDepositAppend, normaliseDepositSentence } from "src/utils/deposit-text";

const PLACEHOLDER = "Deposit written out sentence to file";
// Breathing room between the lifted input and the top of the keyboard.
const LIFT_MARGIN_PX = 8;
// Used only before any channel has reported a height. Tall enough to clear
// any iOS keyboard, so an unmeasurable host degrades to sitting too high
// rather than to sitting underneath it.
const LIFT_FALLBACK_PX = 336;
// The host reports the keyboard once it opens, which is after the focus that
// opened it. Remembering the last height across focuses means only the very
// first one starts from the fallback and visibly settles.
let lastKeyboardHeight = 0;
const FAILURE_NOTICE = "Deposit failed to write your sentence. Did you change the inbox file? Please check your settings.";

/**
 * Deposit is off until it has somewhere to write. A toggle without a path
 * renders no bar, mirroring the silent empty construction constraint pool.
 */
export function isDepositEnabled(settings: EuphoricSettings): boolean {
    return settings.enableSentenceDeposit && settings.depositInboxPath.trim() !== "";
}

/**
 * Slim pinned bar holding the sentence input. Permanent chrome of the
 * sentence surface, so it animates once when the surface is built.
 */
export function renderDepositBar(host: HTMLElement): HTMLElement {
    const bar = host.createDiv({ cls: "ef-deposit-bar" });
    const input = bar.createEl("input", {
        cls: "ef-deposit-input",
        attr: {
            type: "text",
            placeholder: PLACEHOLDER,
            "aria-label": PLACEHOLDER,
            enterkeyhint: "done",
        },
    });
    attachDoneOnEnter(bar, input);
    attachKeyboardLift(bar, input);
    staggerIn(bar, 1);
    return bar;
}

/**
 * Enter hands control back to the modal. The input releases focus so the
 * response keys answer again, and on mobile the keyboard retracts with it.
 */
function attachDoneOnEnter(bar: HTMLElement, input: HTMLInputElement): void {
    input.addEventListener("keydown", evt => {
        if (evt.key !== "Enter") return;
        evt.preventDefault();
        evt.stopPropagation();
        input.blur();
        const host = bar.closest<HTMLElement>(".modal-content");
        if (!host) return;
        host.setAttr("tabindex", "-1");
        host.focus();
    });
}

/**
 * Floats the bar above the on screen keyboard while the input has focus.
 * A transform keeps the surrounding layout still, so over lifting shows the
 * input a little high instead of tearing a gap into the modal.
 */
function attachKeyboardLift(bar: HTMLElement, input: HTMLInputElement): void {
    if (!Platform.isMobile) return;
    let unsubscribe: (() => void) | null = null;
    // Distance from the bar's resting bottom edge to the bottom of the
    // viewport. Measured before the lift so the transform cannot skew it.
    let restingGap = 0;

    const applyLift = (): void => {
        const measured = getKeyboardHeight();
        if (measured > 0) lastKeyboardHeight = measured;
        const keyboard = measured > 0 ? measured : (lastKeyboardHeight || LIFT_FALLBACK_PX);
        const lift = Math.max(0, Math.round(keyboard + LIFT_MARGIN_PX - restingGap));
        bar.setCssProps({ "--ef-deposit-lift": `${lift}px` });
    };

    // While the input has focus the next tap anywhere else only dismisses it.
    // Swallowing that tap in the capture phase stops it reaching a Reveal
    // button underneath, so dismissing never toggles something by accident.
    const root = bar.closest<HTMLElement>(".modal-content") ?? bar;
    const swallowOutsideTap = (e: Event): void => {
        const target = e.target;
        if (target instanceof HTMLElement && target.closest(".ef-deposit-bar")) return;
        e.preventDefault();
        e.stopPropagation();
        input.blur();
    };
    const listenForOutsideTap = (on: boolean): void => {
        for (const type of ["touchstart", "mousedown"]) {
            if (on) root.addEventListener(type, swallowOutsideTap, { capture: true });
            else root.removeEventListener(type, swallowOutsideTap, { capture: true });
        }
    };

    input.addEventListener("focus", () => {
        restingGap = Math.max(0, window.innerHeight - bar.getBoundingClientRect().bottom);
        applyLift();
        bar.addClass("is-lifted");
        unsubscribe ??= onKeyboardChange(applyLift);
        sampleKeyboardSoon();
        listenForOutsideTap(true);
    });

    input.addEventListener("blur", () => {
        unsubscribe?.();
        unsubscribe = null;
        bar.removeClass("is-lifted");
        bar.setCssProps({ "--ef-deposit-lift": "0px" });
        // Detach a tick later so a click trailing the swallowed tap is caught.
        window.setTimeout(() => listenForOutsideTap(false), 0);
    });
}

function inputOf(barEl: HTMLElement | null): HTMLInputElement | null {
    return barEl?.querySelector<HTMLInputElement>(".ef-deposit-input") ?? null;
}

export function readDepositValue(barEl: HTMLElement | null): string {
    return inputOf(barEl)?.value ?? "";
}

export function clearDepositValue(barEl: HTMLElement | null): void {
    const input = inputOf(barEl);
    if (input) input.value = "";
}

export interface CommitDepositOptions {
    vault: Vault;
    settings: EuphoricSettings;
    /** Raw input value. Blank values are a silent no-op. */
    raw: string;
    /**
     * A modal's card write cache. The deposited line is invisible to it, so
     * the entry is dropped to stop a later card write rebuilding the file
     * from a stale copy.
     */
    fileCache?: Map<string, string>;
}

/**
 * Appends one sentence to the configured inbox note. Returns false only when
 * the user lost a sentence, so a caller can hold its surface and let them
 * retry. Failure always notifies, independent of the notification setting.
 */
export async function commitDeposit(opts: CommitDepositOptions): Promise<boolean> {
    const { vault, settings, raw, fileCache } = opts;
    if (!isDepositEnabled(settings)) return true;
    const sentence = normaliseDepositSentence(raw);
    if (sentence === "") return true;

    const path = settings.depositInboxPath.trim();
    let file: TFile | null = null;
    try {
        file = vault.getFileByPath(path);
        if (file === null) throw new Error(`Deposit inbox not found at ${path}`);
        await vault.process(file, content => composeDepositAppend(content, sentence));
    } catch (e) {
        console.error("EuphoricFlashcards deposit:", e);
        new Notice(FAILURE_NOTICE);
        return false;
    }

    fileCache?.delete(path);
    if (settings.showDepositNotification) {
        new Notice(`Appended sentence to ${file.name}. Check in later to review it.`);
    }
    return true;
}
