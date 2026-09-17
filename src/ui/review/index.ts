import { App, Modal, setIcon } from "obsidian";
import type { KeymapEventHandler } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { ReviewResponse } from "src/scheduling/review-response";
import { SRAlgorithmOsr, textInterval } from "src/scheduling/osr";
import { DueDateHistogram } from "src/scheduling/due-date-histogram";
import { PREFERRED_DATE_FORMAT } from "src/scheduling/constants";
import { withUpdatedSchedules, frontFace, backFace, cardReveal, parseCard } from "src/parsing";
import type { ParsedCard, CardFace } from "src/parsing";
import type { ScheduleInfo } from "src/persistence";
import type { ReviewMode, CardSide } from "src/settings";
import type { DeckNode } from "src/decks";
import { globalDateProvider } from "src/scheduling/dates";
import { loadCardsForDeck, writeCardBack, ReviewCard } from "src/ui/review/load-cards";
import { ExplorerModal } from "src/ui/explorer/index";
import { addCloseButton, preventBgTapDismiss } from "src/ui/modal-utils";
import { EditCardModal } from "src/ui/edit-card/index";

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

interface ReviewItem {
    card: ParsedCard;
    filePath: string;
    faceIndex: 0 | 1;
}

function buildReviewQueue(
    cards: ReviewCard[],
    mode: ReviewMode,
    cardSide: CardSide,
    today: Date,
): ReviewItem[] {
    const todayMs = today.valueOf();
    const isFaceDue = (s: ScheduleInfo | null): boolean =>
        s === null || s.dueDate.valueOf() <= todayMs;

    const items: ReviewItem[] = [];

    for (const { card, filePath } of cards) {
        if (mode === "Review") {
            if (isFaceDue(card.schedules[0])) items.push({ card, filePath, faceIndex: 0 });
            if (isFaceDue(card.schedules[1])) items.push({ card, filePath, faceIndex: 1 });
        } else {
            // Cram, one side per card, determined by settings
            let fi: 0 | 1;
            if (cardSide === "Front") fi = 0;
            else if (cardSide === "Back") fi = 1;
            else fi = Math.random() < 0.5 ? 0 : 1;
            items.push({ card, filePath, faceIndex: fi });
        }
    }

    // Shuffle
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
}

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

function histogramFor(plugin: EuphoricFlashcardsPlugin): DueDateHistogram {
    if (!plugin.data.settings.loadBalance) return new DueDateHistogram();
    return plugin.histogramStore.toRelativeHistogram(globalDateProvider.today);
}

function previewInterval(
    schedule: ScheduleInfo | null,
    response: ReviewResponse,
    plugin: EuphoricFlashcardsPlugin,
): number {
    const algo = new SRAlgorithmOsr(plugin.data.settings);
    const h = histogramFor(plugin);
    if (schedule === null) return algo.cardGetNewSchedule(response, h).interval;
    return algo.cardCalcUpdatedSchedule(response, schedule, h).interval;
}

function applyResponse(
    schedule: ScheduleInfo | null,
    response: ReviewResponse,
    plugin: EuphoricFlashcardsPlugin,
): ScheduleInfo {
    const algo = new SRAlgorithmOsr(plugin.data.settings);
    const h = histogramFor(plugin);
    if (schedule === null) return algo.cardGetNewSchedule(response, h);
    return algo.cardCalcUpdatedSchedule(response, schedule, h);
}

// Strip SR HTML comments from raw card lines for display in the edit modal.
// Drops lines that were purely an SR comment; strips inline SR from mixed lines.
const SR_INLINE_RE = /\s*<!--SR:!.+?-->/g;
function stripSRForEditing(rawLines: string[]): string[] {
    const out: string[] = [];
    for (const line of rawLines) {
        const originalHadSR = line.includes("<!--SR:");
        const stripped = line.replace(SR_INLINE_RE, "").trimEnd();
        if (stripped === "" && originalHadSR) continue;
        out.push(stripped);
    }
    return out;
}

// ---------------------------------------------------------------------------
// ReviewModal
// ---------------------------------------------------------------------------

export class ReviewModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;
    private readonly node: DeckNode;
    private readonly mode: ReviewMode;
    private readonly cardSide: CardSide;

    private queue: ReviewItem[] = [];
    private idx = 0;
    private totalCards = 0;
    private revealed = false;
    private reviewed = 0;
    private fileCache = new Map<string, string>();
    private keymapHandlers: KeymapEventHandler[] = [];
    private againItems = new Set<ReviewItem>();

    constructor(
        app: App,
        plugin: EuphoricFlashcardsPlugin,
        node: DeckNode,
        mode: ReviewMode,
        cardSide?: CardSide,
    ) {
        super(app);
        this.plugin = plugin;
        this.node = node;
        this.mode = mode;
        this.cardSide = cardSide ?? plugin.data.settings.defaultCardSide;
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        addCloseButton(this);
        this.contentEl.addClass("ef-review");
        this.addBackButton();
        this.contentEl.createEl("p", { text: "Loading cards…", cls: "ef-loading" });
        this.load().catch(err => {
            console.error("EuphoricFlashcards ReviewModal:", err);
            this.contentEl.empty();
            this.contentEl.createEl("p", { text: "Failed to load cards." });
        });
    }

    onClose(): void {
        this.clearKeymap();
        this.contentEl.empty();
    }

    private clearKeymap(): void {
        for (const h of this.keymapHandlers) this.scope.unregister(h);
        this.keymapHandlers = [];
    }

    private backToExplorer(): void {
        this.close();
        new ExplorerModal(this.app, this.plugin).open();
    }

    private addBackButton(): void {
        const btn = this.modalEl.createEl("button", {
            cls: "ef-back-btn",
            attr: { "aria-label": "Back to Explorer", tabindex: "-1" },
        });
        setIcon(btn, "arrow-left");
        btn.addEventListener("click", () => this.backToExplorer());
    }

    private addKey(key: string, fn: () => void): void {
        this.keymapHandlers.push(this.scope.register([], key, () => { fn(); return false; }));
    }

    private async load(): Promise<void> {
        const s = this.plugin.data.settings;
        const rootTags = s.rootDeckTags.map(t => t.startsWith("#") ? t : "#" + t);
        const cards = await loadCardsForDeck(this.app.vault, this.node, rootTags);
        this.queue = buildReviewQueue(
            cards, this.mode, this.cardSide,
            globalDateProvider.today.toDate(),
        );
        this.totalCards = this.queue.length;
        this.contentEl.empty();
        this.queue.length === 0 ? this.renderEmpty() : this.renderCard();
    }

    private renderEmpty(): void {
        this.contentEl.createDiv({ cls: "ef-done" }, div => {
            div.createEl("h2", { text: "Nothing to review" });
            div.createEl("p", { text: "All caught up for this deck.", cls: "ef-done-sub" });
            div.createEl("button", { text: "Back to Explorer", cls: "ef-btn ef-btn-primary" })
                .addEventListener("click", () => this.backToExplorer());
        });
    }

    private renderCard(): void {
        this.clearKeymap();
        this.contentEl.empty();
        this.revealed = false;

        const item = this.queue[this.idx]!;
        const face: CardFace = item.faceIndex === 0 ? frontFace(item.card) : backFace(item.card);
        const reveal = cardReveal(item.card);
        const settings = this.plugin.data.settings;

        // Header
        this.contentEl.createDiv({ cls: "ef-review-header" }, h => {
            h.createSpan({ text: this.node.fullPath, cls: "ef-review-deck-name" });
            const right = h.createDiv({ cls: "ef-review-header-right" });
            const editBtn = right.createEl("button", { cls: "ef-edit-btn", attr: { "aria-label": "Edit card" } });
            setIcon(editBtn, "pencil");
            editBtn.addEventListener("click", () => this.openEditCardModal(item));
            right.createSpan({ text: `${this.reviewed} / ${this.totalCards - this.reviewed}`, cls: "ef-review-progress" });
        });

        // Card body
        const body = this.contentEl.createDiv({ cls: "ef-card-body" });

        body.createDiv({ text: face.prompt, cls: "ef-card-prompt" });

        // Answer (hidden until revealed)
        const answerEl = body.createDiv({ cls: "ef-answer ef-hidden" });

        // Solution line: translation + type badge (right-aligned inline)
        answerEl.createDiv({ cls: "ef-card-answer-line" }, line => {
            line.createSpan({ text: face.answer, cls: "ef-card-answer" });
            if (reveal.type) {
                const tc = settings.cardTypes.find(t => t.key === reveal.type);
                const badge = line.createSpan({
                    text: tc?.label ?? reveal.type,
                    cls: "ef-type-badge",
                });
                badge.style.backgroundColor = tc?.color ?? "var(--background-modifier-border)";
            }
        });

        if (reveal.explanation) {
            answerEl.createEl("p", { text: reveal.explanation, cls: "ef-explanation" });
        }
        if (reveal.examples.length > 0) {
            const list = answerEl.createDiv({ cls: "ef-examples" });
            for (const ex of reveal.examples) {
                list.createDiv({ text: `"${ex}"`, cls: "ef-example-item" });
            }
        }

        // Actions
        const actions = this.contentEl.createDiv({ cls: "ef-review-actions" });
        const showBtn = actions.createEl("button", { text: "Show Answer", cls: "ef-btn ef-btn-primary" });
        const doReveal = (): void => {
            if (this.revealed) return;
            this.revealed = true;
            answerEl.removeClass("ef-hidden");
            showBtn.remove();
            this.renderResponseButtons(actions, item, face.schedule);
        };
        showBtn.addEventListener("click", doReveal);
        this.addKey(" ", doReveal);
        this.addKey("Enter", doReveal);
    }

    private renderResponseButtons(
        actionsEl: HTMLElement,
        item: ReviewItem,
        schedule: ScheduleInfo | null,
    ): void {
        if (this.mode === "Cram") {
            this.renderCramButtons(actionsEl, item);
        } else if (this.againItems.has(item)) {
            this.renderPostAgainButtons(actionsEl, item);
        } else {
            this.renderReviewButtons(actionsEl, item, schedule);
        }
    }

    private renderReviewButtons(
        actionsEl: HTMLElement,
        item: ReviewItem,
        schedule: ScheduleInfo | null,
    ): void {
        const showInterval = this.plugin.data.settings.showIntervalOnButtons;
        const okayInterval = showInterval ? textInterval(previewInterval(schedule, ReviewResponse.Hard, this.plugin), true) : null;
        const goodInterval = showInterval ? textInterval(previewInterval(schedule, ReviewResponse.Good, this.plugin), true) : null;

        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => this.handleAgain(item));
        this.addResponseButton(actionsEl, 2, "Okay", "ef-btn-okay", "activity", okayInterval,
            () => { void this.handleScheduledResponse(ReviewResponse.Hard, item); });
        this.addResponseButton(actionsEl, 3, "Good", "ef-btn-good", "check", goodInterval,
            () => { void this.handleScheduledResponse(ReviewResponse.Good, item); });
    }

    private renderPostAgainButtons(actionsEl: HTMLElement, item: ReviewItem): void {
        const showInterval = this.plugin.data.settings.showIntervalOnButtons;

        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => this.handleAgain(item));
        this.addResponseButton(actionsEl, 2, "OK", "ef-btn-good", "check", showInterval ? "1d" : null,
            () => { void this.handleReset(item); });
    }

    private renderCramButtons(actionsEl: HTMLElement, item: ReviewItem): void {
        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => this.handleAgain(item));
        this.addResponseButton(actionsEl, 2, "Easy", "ef-btn-easy", "check", null,
            () => this.handleCramEasy());
    }

    private addResponseButton(
        container: HTMLElement,
        keyNum: number,
        label: string,
        cls: string,
        icon: string,
        interval: string | null,
        onClick: () => void,
    ): void {
        const btn = container.createEl("button", { cls: `ef-btn ef-btn-response ${cls}` });
        btn.createSpan({ text: String(keyNum), cls: "ef-btn-key" });
        const iconEl = btn.createSpan({ cls: "ef-btn-icon" });
        setIcon(iconEl, icon);
        const textEl = btn.createSpan({ cls: "ef-btn-text" });
        textEl.createSpan({ text: label, cls: "ef-btn-label" });
        if (interval !== null) {
            textEl.createSpan({ text: interval, cls: "ef-btn-interval" });
        }
        btn.addEventListener("click", onClick);
        this.addKey(String(keyNum), onClick);
    }

    private handleAgain(item: ReviewItem): void {
        if (!this.revealed) return;
        this.revealed = false;

        if (this.mode !== "Cram") {
            this.againItems.add(item);
        }

        // Reshuffle the item back into the remaining queue at a random position
        const remaining = this.queue.length - (this.idx + 1);
        if (remaining > 0) {
            const insertAt = this.idx + 1 + Math.floor(Math.random() * remaining);
            this.queue.splice(insertAt, 0, item);
        } else {
            this.queue.push(item);
        }

        this.idx++;
        this.renderCard();
    }

    private async handleScheduledResponse(response: ReviewResponse, item: ReviewItem): Promise<void> {
        if (!this.revealed) return;
        this.revealed = false;

        const newSchedule = applyResponse(item.card.schedules[item.faceIndex], response, this.plugin);
        await this.writeSchedule(item, newSchedule);

        this.reviewed++;
        this.idx++;
        this.idx >= this.queue.length ? this.renderDone() : this.renderCard();
    }

    private async handleReset(item: ReviewItem): Promise<void> {
        if (!this.revealed) return;
        this.revealed = false;

        const algo = new SRAlgorithmOsr(this.plugin.data.settings);
        const newSchedule = algo.cardGetResetSchedule(item.card.schedules[item.faceIndex]);
        await this.writeSchedule(item, newSchedule);

        this.reviewed++;
        this.idx++;
        this.idx >= this.queue.length ? this.renderDone() : this.renderCard();
    }

    private handleCramEasy(): void {
        if (!this.revealed) return;
        this.revealed = false;
        // dont change scheduling during cram
        this.reviewed++;
        this.idx++;
        this.idx >= this.queue.length ? this.renderDone() : this.renderCard();
    }

    private async writeSchedule(item: ReviewItem, newSchedule: ScheduleInfo): Promise<void> {
        const oldSchedule = item.card.schedules[item.faceIndex];
        const updatedSchedules: [ScheduleInfo | null, ScheduleInfo | null] = [
            item.card.schedules[0],
            item.card.schedules[1],
        ];
        updatedSchedules[item.faceIndex] = newSchedule;

        const newLines = withUpdatedSchedules(item.card, updatedSchedules, this.plugin.data.settings.baseEase);
        const oldLength = item.card.rawLines.length;
        await writeCardBack(this.app.vault, this.fileCache, item.filePath, item.card, newLines);

        // update the persisted histogram: remove the old due-date bucket and
        // add the new one. skips dummy dates internally.
        if (this.plugin.data.settings.loadBalance) {
            const store = this.plugin.histogramStore;
            if (oldSchedule !== null) store.decrement(oldSchedule.dueDate.format(PREFERRED_DATE_FORMAT));
            store.increment(newSchedule.dueDate.format(PREFERRED_DATE_FORMAT));
            void this.plugin.saveData_();
        }

        // Keep the in-memory card consistent with what we just wrote so any
        // same-session re-write (e.g. the other face of the same card) sees
        // the new format instead of the legacy inline form.
        item.card.rawLines = newLines;
        item.card.endLine = item.card.startLine + newLines.length - 1;
        item.card.schedules[item.faceIndex] = newSchedule;

        const delta = newLines.length - oldLength;
        if (delta !== 0) this.shiftQueueForDelta(item.card, item.filePath, delta);
    }

    // Cards can appear twice in the queue (front + back share one ParsedCard);
    // dedupe by identity so we don't shift the same card twice. Only entries
    // after `changedCard` in the same file need shifting.
    private shiftQueueForDelta(changedCard: ParsedCard, filePath: string, delta: number): void {
        const originalStart = changedCard.startLine;
        const seen = new Set<ParsedCard>([changedCard]);
        for (const q of this.queue) {
            if (q.filePath !== filePath) continue;
            if (seen.has(q.card)) continue;
            seen.add(q.card);
            if (q.card.startLine > originalStart) {
                q.card.startLine += delta;
                q.card.endLine += delta;
            }
        }
    }

    private openEditCardModal(item: ReviewItem): void {
        const displayLines = stripSRForEditing(item.card.rawLines);
        const hadSchedule = item.card.schedules[0] !== null || item.card.schedules[1] !== null;

        new EditCardModal(this.app, {
            initialText: displayLines.join("\n"),
            onSave: async (newText) => {
                const editedLines = newText.split("\n");
                const parsed = parseCard(editedLines, 0);
                if (parsed === null) {
                    return "Card could not be parsed. Check the `word :: translation` and any `=type` markers.";
                }

                // Reattach the existing SR schedule (if any) on its own last line.
                const finalLines = hadSchedule
                    ? withUpdatedSchedules(parsed, item.card.schedules, this.plugin.data.settings.baseEase)
                    : editedLines;

                const oldLength = item.card.rawLines.length;
                const startLine = item.card.startLine;
                try {
                    await writeCardBack(this.app.vault, this.fileCache, item.filePath, item.card, finalLines);
                } catch (e) {
                    console.error("EuphoricFlashcards edit save:", e);
                    return "Failed to write the file.";
                }

                // Mutate the shared ParsedCard in place so both queue entries
                // (front + back) see the update. Schedules are preserved via
                // withUpdatedSchedules; only fields & lines change.
                item.card.fields = parsed.fields;
                item.card.rawLines = finalLines;
                item.card.endLine = startLine + finalLines.length - 1;

                const delta = finalLines.length - oldLength;
                if (delta !== 0) this.shiftQueueForDelta(item.card, item.filePath, delta);

                this.renderCard();
                return null;
            },
        }).open();
    }

    private renderDone(): void {
        this.clearKeymap();
        this.contentEl.empty();
        this.contentEl.createDiv({ cls: "ef-done" }, div => {
            div.createEl("h2", { text: "Session complete!" });
            div.createEl("p", {
                text: `Reviewed ${this.reviewed} card${this.reviewed !== 1 ? "s" : ""}.`,
                cls: "ef-done-sub",
            });
            div.createEl("button", { text: "Back to Explorer", cls: "ef-btn ef-btn-primary" })
                .addEventListener("click", () => this.backToExplorer());
        });
    }
}
