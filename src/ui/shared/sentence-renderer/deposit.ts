import { Notice } from "obsidian";
import type { TFile, Vault } from "obsidian";
import type { EuphoricSettings } from "src/settings";
import { staggerIn } from "src/ui/modal-utils";
import { composeDepositAppend, normaliseDepositSentence } from "src/utils/deposit-text";

const PLACEHOLDER = "Deposit written out sentence to file";
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
    bar.createEl("input", {
        cls: "ef-deposit-input",
        attr: { type: "text", placeholder: PLACEHOLDER, "aria-label": PLACEHOLDER },
    });
    staggerIn(bar, 1);
    return bar;
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
