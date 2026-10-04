import { App, Modal, Notice, setIcon } from "obsidian";
import type { KeymapEventHandler } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { ReviewResponse } from "src/scheduling/review-response";
import { textInterval } from "src/scheduling/interval-text";
import { withUpdatedSchedules, frontFace, backFace, cardReveal, parseCard } from "src/parsing";
import type { ParsedCard, CardFace } from "src/parsing";
import { ratingFor, scheduledDays } from "src/scheduling/fsrs";
import type { GradeRecord, ScheduleInfo } from "src/scheduling/fsrs";
import type { ReviewMode, CardSide } from "src/settings";
import type { DeckNode } from "src/decks";
import { globalDateProvider } from "src/scheduling/dates";
import { isFaceDue } from "src/scheduling/due";
import { previewAll } from "src/scheduling/session-helpers";
import { fisherYates } from "src/utils/shuffle";
import { loadCardsForDeck, writeCardBack, ReviewCard } from "src/ui/review/load-cards";
import { ExplorerModal } from "src/ui/explorer/index";
import { addCloseButton, applyAnimationDuration, fadeOutThen, preventBgTapDismiss, staggerIn } from "src/ui/modal-utils";
import { EditCardModal } from "src/ui/edit-card/index";
import { writeGradedResponse, shiftLocationsForDelta } from "src/ui/shared/write-schedule";
import { renderResponseButton } from "src/ui/shared/response-button";

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
    const items: ReviewItem[] = [];

    for (const { card, filePath } of cards) {
        if (mode === "Review") {
            if (isFaceDue(card.schedules[0], today)) items.push({ card, filePath, faceIndex: 0 });
            if (isFaceDue(card.schedules[1], today)) items.push({ card, filePath, faceIndex: 1 });
        } else {
            // Cram, one side per card, determined by settings
            let fi: 0 | 1;
            if (cardSide === "Front") fi = 0;
            else if (cardSide === "Back") fi = 1;
            else fi = Math.random() < 0.5 ? 0 : 1;
            items.push({ card, filePath, faceIndex: fi });
        }
    }

    return fisherYates(items);
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
    // Faces this session has already written a schedule for. B2: the first answer
    // on a face writes and nothing else in the session does, so this is both the
    // no-second-write gate and the "show no preview" signal for the re-drill.
    // Keyed by queue item, which is the face — a card's two faces are two items.
    private writtenItems = new Set<ReviewItem>();
    // Every outcome for the face currently on screen, taken in one FSRS call when
    // the answer is revealed. Buttons render their previews from this record and
    // the write uses the very same entry, so the interval shown and the interval
    // stored cannot disagree (plan P3.5).
    private pendingPreview: GradeRecord<ScheduleInfo> | null = null;
    // True until the first card has been rendered — used to stagger the
    // header and action row exactly once on modal open, matching how
    // Conjure Sentences animates its permanent chrome.
    private firstRender = true;

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
        applyAnimationDuration(this.containerEl, this.plugin.data.settings.animationDurationMs);
        this.contentEl.addClass("ef-review");
        this.addBackButton();
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
        fadeOutThen(this, () => {
            this.close();
            new ExplorerModal(this.app, this.plugin).open();
        });
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
            globalDateProvider.today,
        );
        this.totalCards = this.queue.length;
        this.contentEl.empty();
        this.queue.length === 0 ? this.renderEmpty() : this.renderCard();
    }

    private renderEmpty(): void {
        this.contentEl.createDiv({ cls: "ef-done" }, div => {
            staggerIn(div.createEl("h2", { text: "Nothing to review" }), 0);
            staggerIn(div.createEl("p", { text: "All caught up for this deck.", cls: "ef-done-sub" }), 1);
            const btn = div.createEl("button", { text: "Back to Explorer", cls: "ef-btn ef-btn-primary" });
            btn.addEventListener("click", () => this.backToExplorer());
            staggerIn(btn, 2);
        });
    }

    private renderCard(): void {
        this.clearKeymap();
        this.contentEl.empty();
        this.revealed = false;
        // A new face invalidates the previous face's preview. The `revealed`
        // guard already prevents a write from reaching a stale snapshot; this
        // makes the invalidation explicit rather than a consequence of it.
        this.pendingPreview = null;

        const item = this.queue[this.idx]!;
        const face: CardFace = item.faceIndex === 0 ? frontFace(item.card) : backFace(item.card);
        const reveal = cardReveal(item.card);
        const settings = this.plugin.data.settings;

        // Header — animated only on the modal's very first render (parallel to
        // Conjure Sentences' permanent chrome). Between card advances it stays
        // static so its border-bottom guideline doesn't flicker; the progress
        // counter inside still flashes on every re-render.
        const headerEl = this.contentEl.createDiv({ cls: "ef-review-header" }, h => {
            h.createSpan({ text: this.node.fullPath, cls: "ef-review-deck-name" });
            const right = h.createDiv({ cls: "ef-review-header-right" });
            const editBtn = right.createEl("button", { cls: "ef-edit-btn", attr: { "aria-label": "Edit card" } });
            setIcon(editBtn, "pencil");
            editBtn.addEventListener("click", () => this.openEditCardModal(item));
            right.createSpan({ text: `${this.reviewed} / ${this.totalCards - this.reviewed}`, cls: "ef-review-progress ef-progress-flash" });
        });
        if (this.firstRender) staggerIn(headerEl, 0);

        // Card body
        const body = this.contentEl.createDiv({ cls: "ef-card-body" });

        const promptEl = body.createDiv({ text: face.prompt, cls: "ef-card-prompt" });
        staggerIn(promptEl, this.firstRender ? 1 : 0);

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
                badge.setCssStyles({ backgroundColor: tc?.color ?? "var(--background-modifier-border)" });
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

        // Actions — the container animates on first render only; on later
        // renders its border-top guideline stays static. Buttons inside always
        // stagger in.
        const actions = this.contentEl.createDiv({ cls: "ef-review-actions" });
        if (this.firstRender) staggerIn(actions, 2);
        const showBtn = actions.createEl("button", { text: "Show Answer", cls: "ef-btn ef-btn-primary" });
        staggerIn(showBtn, this.firstRender ? 3 : 1);
        const doReveal = (): void => {
            if (this.revealed) return;
            this.revealed = true;
            answerEl.removeClass("ef-hidden");
            // Animate only the newly revealed content — the prompt stays put.
            staggerIn(answerEl, 0);
            showBtn.remove();
            this.renderResponseButtons(actions, item, face.schedule);
        };
        showBtn.addEventListener("click", doReveal);
        this.addKey(" ", doReveal);
        this.addKey("Enter", doReveal);

        this.firstRender = false;
    }

    private renderResponseButtons(
        actionsEl: HTMLElement,
        item: ReviewItem,
        schedule: ScheduleInfo | null,
    ): void {
        if (this.mode === "Cram") {
            this.renderCramButtons(actionsEl, item);
        } else {
            this.renderReviewButtons(actionsEl, item, schedule);
        }
    }

    // One snapshot per revealed face, shared by the previews and the write.
    private snapshotPreview(schedule: ScheduleInfo | null): GradeRecord<ScheduleInfo> {
        const preview = previewAll(schedule, this.plugin, globalDateProvider.now);
        this.pendingPreview = preview;
        return preview;
    }

    // B2's preview rule: an interval is rendered if and only if a write will
    // occur. On the post-Again re-drill the write already happened, so the drill
    // buttons come up bare.
    private previewLabel(
        item: ReviewItem,
        preview: GradeRecord<ScheduleInfo>,
        response: ReviewResponse,
    ): string | null {
        if (!this.plugin.data.settings.showIntervalOnButtons) return null;
        if (this.writtenItems.has(item)) return null;
        return textInterval(scheduledDays(preview[ratingFor(response)]), true);
    }

    // Three buttons on a first pass, two on the post-Again re-drill.
    //
    // The reduced drill surface is cosmetic. B2 still holds: the first answer on
    // a face is the only one that writes, so neither drill button writes
    // anything, and a third grade there would imply a choice the scheduler never
    // sees. Keys follow the buttons, because addResponseButton registers them, so
    // 3 is simply unbound on the re-drill.
    private renderReviewButtons(
        actionsEl: HTMLElement,
        item: ReviewItem,
        schedule: ScheduleInfo | null,
    ): void {
        if (this.writtenItems.has(item)) {
            this.renderDrillButtons(actionsEl, item);
            return;
        }

        const preview = this.snapshotPreview(schedule);

        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw",
            this.previewLabel(item, preview, ReviewResponse.Again),
            () => { void this.handleScheduledResponse(ReviewResponse.Again, item); });
        this.addResponseButton(actionsEl, 2, "Okay", "ef-btn-okay", "activity",
            this.previewLabel(item, preview, ReviewResponse.Hard),
            () => { void this.handleScheduledResponse(ReviewResponse.Hard, item); });
        this.addResponseButton(actionsEl, 3, "Good", "ef-btn-good", "check",
            this.previewLabel(item, preview, ReviewResponse.Good),
            () => { void this.handleScheduledResponse(ReviewResponse.Good, item); });
    }

    // The post-Again drill surface. Again sends the face round again, Okay
    // releases it and moves on. Both are routed through the same handler as the
    // first pass, which already skips the write for a face in writtenItems, so
    // the no-second-write rule stays in one place. No snapshot is taken here
    // because nothing will be written or previewed from it.
    private renderDrillButtons(actionsEl: HTMLElement, item: ReviewItem): void {
        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => { void this.handleScheduledResponse(ReviewResponse.Again, item); });
        this.addResponseButton(actionsEl, 2, "Okay", "ef-btn-okay", "activity", null,
            () => { void this.handleScheduledResponse(ReviewResponse.Hard, item); });
    }

    private renderCramButtons(actionsEl: HTMLElement, item: ReviewItem): void {
        this.addResponseButton(actionsEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => this.handleCramAgain(item));
        // "Got it", not "Easy": Cram never writes a schedule (handleCramEasy),
        // and "Easy" reads as a grade the card did not receive.
        this.addResponseButton(actionsEl, 2, "Got it", "ef-btn-easy", "check", null,
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
        renderResponseButton(container, this.plugin.data.settings, {
            keyNum, label, cls, icon, interval, onClick,
        });
        this.addKey(String(keyNum), onClick);
    }

    // Reshuffle a face back into the remaining queue at a random position. Under
    // B2 this is pure drill: the write, if any, has already happened.
    private reshuffle(item: ReviewItem): void {
        const remaining = this.queue.length - (this.idx + 1);
        if (remaining > 0) {
            const insertAt = this.idx + 1 + Math.floor(Math.random() * remaining);
            this.queue.splice(insertAt, 0, item);
        } else {
            this.queue.push(item);
        }
    }

    // Cram's Again: never writes, in any circumstance, and never has.
    private handleCramAgain(item: ReviewItem): void {
        if (!this.revealed) return;
        this.revealed = false;
        this.reshuffle(item);
        this.idx++;
        this.renderCard();
    }

    // B2's rating contract. The first answer on a face writes — Again included —
    // and nothing else in the session does.
    private async handleScheduledResponse(response: ReviewResponse, item: ReviewItem): Promise<void> {
        if (!this.revealed) return;
        this.revealed = false;

        if (!this.writtenItems.has(item)) {
            // Written from the snapshot the buttons were rendered from, so the
            // interval shown and the interval stored cannot disagree.
            const preview = this.pendingPreview ?? previewAll(
                item.card.schedules[item.faceIndex], this.plugin, globalDateProvider.now,
            );
            try {
                await this.writeSchedule(item, preview[ratingFor(response)]);
            } catch (e) {
                // Hand the card back rather than advancing. revealed was cleared
                // on entry, so without restoring it every button and key stays
                // dead and the session can only be escaped by closing the modal.
                console.error("EuphoricFlashcards ReviewModal write:", e);
                new Notice("Failed to save your answer. The file may have changed on disk. Answer again to retry.");
                this.revealed = true;
                return;
            }
            // Only after the write actually succeeded: a throw leaves the face
            // unmarked so a later answer can still persist it.
            this.writtenItems.add(item);
        }
        this.pendingPreview = null;

        // Again keeps the face in the session as drill and does not count as
        // reviewed; the card comes back and any later answer writes nothing.
        if (response === ReviewResponse.Again) {
            this.reshuffle(item);
            this.idx++;
            this.renderCard();
            return;
        }

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
        const delta = await writeGradedResponse({
            plugin: this.plugin,
            vault: this.app.vault,
            fileCache: this.fileCache,
            item,
            newSchedule,
        });
        this.shiftQueueForDelta(item.card, item.filePath, delta);
    }

    // Cards can appear twice in the queue (front + back share one ParsedCard);
    // dedupe by identity so we don't shift the same card twice. Only entries
    // after `changedCard` in the same file need shifting.
    private shiftQueueForDelta(changedCard: ParsedCard, filePath: string, delta: number): void {
        shiftLocationsForDelta(this.queue, changedCard, filePath, delta);
    }

    private openEditCardModal(item: ReviewItem): void {
        const displayLines = stripSRForEditing(item.card.rawLines);
        const hadSchedule = item.card.schedules[0] !== null || item.card.schedules[1] !== null;

        new EditCardModal(this.app, {
            initialText: displayLines.join("\n"),
            animationDurationMs: this.plugin.data.settings.animationDurationMs,
            onSave: async (newText) => {
                const editedLines = newText.split("\n");
                const parsed = parseCard(editedLines, 0);
                if (parsed === null) {
                    return "Card could not be parsed. Check the `word :: translation` and any `=type` markers.";
                }

                // Reattach the existing SR schedule (if any) on its own last line.
                const finalLines = hadSchedule
                    ? withUpdatedSchedules(parsed, item.card.schedules)
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
            staggerIn(div.createEl("h2", { text: "Session complete!" }), 0);
            staggerIn(div.createEl("p", {
                text: `Reviewed ${this.reviewed} card${this.reviewed !== 1 ? "s" : ""}.`,
                cls: "ef-done-sub",
            }), 1);
            const btn = div.createEl("button", { text: "Back to Explorer", cls: "ef-btn ef-btn-primary" });
            btn.addEventListener("click", () => this.backToExplorer());
            staggerIn(btn, 2);
        });
    }
}
