import { App, Modal, setIcon } from "obsidian";
import type { KeymapEventHandler } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { ReviewResponse } from "src/scheduling/review-response";
import { SRAlgorithmOsr, textInterval } from "src/scheduling/osr";
import { withUpdatedSchedules, frontFace, backFace, cardReveal, parseCard } from "src/parsing";
import type { CardFace } from "src/parsing";
import type { ScheduleInfo } from "src/persistence";
import type { DeckNode } from "src/decks";
import { globalDateProvider } from "src/scheduling/dates";
import { previewInterval, applyResponse } from "src/scheduling/session-helpers";
import { loadCardsForDeck, writeCardBack } from "src/ui/review/load-cards";
import { ExplorerModal } from "src/ui/explorer/index";
import { addCloseButton, applyAnimationDuration, fadeOutThen, preventBgTapDismiss, staggerIn } from "src/ui/modal-utils";
import { EditCardModal } from "src/ui/edit-card/index";
import { writeGradedResponse, shiftLocationsForDelta } from "src/ui/shared/write-schedule";
import { classifyPools } from "src/learn/pool";
import { LearnSession } from "src/learn/session";
import type { LearnItem } from "src/learn/group-state";
import type { WriteIntent } from "src/learn/session";
import type { SentenceWordSelection } from "src/learn/sentence-planner";
import { buildConstructionConstraintPool } from "src/ui/shared/construction-constraints";
import { createSentenceList, drawSentence, redrawSentence } from "src/ui/shared/sentence-view";
import type { SentenceWord, SentenceDrawOptions } from "src/ui/shared/sentence-view";
import { renderResponseButton } from "src/ui/shared/response-button";

export interface LearnModalOptions {
    groupLimit: number;
    selectionDeckTag: string;
}

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

export class LearnModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;
    private readonly node: DeckNode;
    private readonly options: LearnModalOptions;

    private session: LearnSession | null = null;
    private fileCache = new Map<string, string>();
    private keymapHandlers: KeymapEventHandler[] = [];
    private revealed = false;
    // Permanent chrome (header + action row) staggers in only on first render;
    // between steps the borders stay static. Body containers stagger on every swap.
    private firstRender = true;
    private constraintPool: string[] = [];

    private headerEl: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private footerEl: HTMLElement | null = null;
    private sentenceListEl: HTMLElement | null = null;

    constructor(app: App, plugin: EuphoricFlashcardsPlugin, node: DeckNode, options: LearnModalOptions) {
        super(app);
        this.plugin = plugin;
        this.node = node;
        this.options = options;
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        addCloseButton(this);
        applyAnimationDuration(this.containerEl, this.plugin.data.settings.animationDurationMs);
        this.contentEl.addClass("ef-review");
        this.addBackButton();
        this.load().catch(err => {
            console.error("EuphoricFlashcards LearnModal:", err);
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

        this.constraintPool = buildConstructionConstraintPool(s, this.options.selectionDeckTag);

        const today = globalDateProvider.today.toDate();
        const pools = classifyPools(cards, today);
        this.session = new LearnSession(pools, {
            groupLimit: this.options.groupLimit,
            wordCount: s.conjureSentencesWordCount,
            sentenceSide: s.learnSentenceSide,
            today,
            rng: Math.random,
        });
        this.session.start();

        this.contentEl.empty();
        this.buildLayout();
        this.renderStep();
    }

    private buildLayout(): void {
        this.headerEl = this.contentEl.createDiv({ cls: "ef-review-header" });
        staggerIn(this.headerEl, 0);
        this.bodyEl = this.contentEl.createDiv({ cls: "ef-card-body" });
        this.footerEl = this.contentEl.createDiv({ cls: "ef-review-actions" });
        staggerIn(this.footerEl, 1);
    }

    private renderHeader(currentItem: LearnItem | null): void {
        if (!this.headerEl || !this.session) return;
        this.headerEl.empty();
        this.headerEl.createSpan({ text: this.node.fullPath, cls: "ef-review-deck-name" });
        const right = this.headerEl.createDiv({ cls: "ef-review-header-right" });
        if (currentItem !== null) {
            const editBtn = right.createEl("button", { cls: "ef-edit-btn", attr: { "aria-label": "Edit card" } });
            setIcon(editBtn, "pencil");
            editBtn.addEventListener("click", () => this.openEditCardModal(currentItem));
        }
        const p = this.session.getGroupProgress();
        const gc = this.session.getGroupsCompleted();
        const gl = this.session.getGroupLimit();
        // Display the currently active group (1-indexed) rather than the
        // completed count, so the first group of two reads 1/2 not 0/2.
        // When a group is active (p.total > 0), that's gc + 1; on the done
        // screen we fall back to gc (which may overflow gl when a carryover
        // triggered a group past the effectiveLimit).
        const activeGroup = p.total > 0 ? gc + 1 : gc;
        right.createSpan({
            text: `${p.cleared}/${p.total}`,
            cls: "ef-review-progress ef-progress-flash",
        });
        right.createSpan({
            text: `${activeGroup}/${gl}`,
            cls: "ef-learn-group-progress ef-progress-flash",
        });
    }

    private renderStep(): void {
        if (!this.session) return;
        const step = this.session.nextStep();
        if (step.kind === "done") {
            this.renderDone(step.groupsCompleted);
            return;
        }
        if (step.kind === "face") {
            this.renderFace(step.item, step.isPostAgain);
        } else {
            this.renderSentence(step.words);
        }
    }

    private renderFace(item: LearnItem, isPostAgain: boolean): void {
        if (!this.bodyEl || !this.footerEl) return;
        this.clearKeymap();
        this.revealed = false;

        this.renderHeader(item);

        this.bodyEl.empty();
        this.bodyEl.removeClass("ef-sentence-body");
        this.sentenceListEl = null;
        const face: CardFace = item.faceIndex === 0 ? frontFace(item.card) : backFace(item.card);
        const reveal = cardReveal(item.card);
        const settings = this.plugin.data.settings;

        const promptEl = this.bodyEl.createDiv({ text: face.prompt, cls: "ef-card-prompt" });
        staggerIn(promptEl, 0);

        const answerEl = this.bodyEl.createDiv({ cls: "ef-answer ef-hidden" });
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

        this.footerEl.empty();
        const showBtn = this.footerEl.createEl("button", { text: "Show Answer", cls: "ef-btn ef-btn-primary" });
        staggerIn(showBtn, this.firstRender ? 2 : 0);
        const doReveal = (): void => {
            if (this.revealed) return;
            this.revealed = true;
            answerEl.removeClass("ef-hidden");
            staggerIn(answerEl, 0);
            showBtn.remove();
            this.renderFaceActions(item, isPostAgain, face.schedule);
        };
        showBtn.addEventListener("click", doReveal);
        this.addKey(" ", doReveal);
        this.addKey("Enter", doReveal);

        this.firstRender = false;
    }

    private renderFaceActions(item: LearnItem, isPostAgain: boolean, schedule: ScheduleInfo | null): void {
        if (!this.footerEl) return;
        const settings = this.plugin.data.settings;
        // Interval previews only make sense when the answer will actually be written.
        const showInterval = settings.showIntervalOnButtons && item.writeEligible;

        if (isPostAgain) {
            this.addResponseButton(this.footerEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
                () => { void this.handleFaceAnswer(item, "Again"); });
            this.addResponseButton(this.footerEl, 2, "OK", "ef-btn-good", "check", showInterval ? "1d" : null,
                () => { void this.handleFaceAnswer(item, "OK"); });
            return;
        }

        const okayInterval = showInterval ? textInterval(previewInterval(schedule, ReviewResponse.Hard, this.plugin), true) : null;
        const goodInterval = showInterval ? textInterval(previewInterval(schedule, ReviewResponse.Good, this.plugin), true) : null;

        this.addResponseButton(this.footerEl, 1, "Again", "ef-btn-again", "rotate-ccw", null,
            () => { void this.handleFaceAnswer(item, "Again"); });
        this.addResponseButton(this.footerEl, 2, "Okay", "ef-btn-okay", "activity", okayInterval,
            () => { void this.handleFaceAnswer(item, "Okay"); });
        this.addResponseButton(this.footerEl, 3, "Good", "ef-btn-good", "check", goodInterval,
            () => { void this.handleFaceAnswer(item, "Good"); });
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

    private async handleFaceAnswer(item: LearnItem, answer: "Again" | "Okay" | "Good" | "OK"): Promise<void> {
        if (!this.session) return;
        if (!this.revealed) return;
        this.revealed = false;

        const outcome = this.session.submitFaceAnswer(item, answer);
        if (outcome.writeIntent !== null) {
            try {
                const newSchedule = this.computeScheduleFor(item, outcome.writeIntent);
                const delta = await writeGradedResponse({
                    plugin: this.plugin,
                    vault: this.app.vault,
                    fileCache: this.fileCache,
                    item,
                    newSchedule,
                });
                this.session.confirmWritten(item);
                if (delta !== 0) {
                    shiftLocationsForDelta(this.session.heldLocations(), item.card, item.filePath, delta);
                }
            } catch (e) {
                console.error("EuphoricFlashcards LearnModal write:", e);
            }
        }
        this.renderStep();
    }

    private computeScheduleFor(item: LearnItem, intent: WriteIntent): ScheduleInfo {
        if (intent.kind === "reset") {
            const algo = new SRAlgorithmOsr(this.plugin.data.settings);
            return algo.cardGetResetSchedule(item.card.schedules[item.faceIndex]);
        }
        return applyResponse(item.card.schedules[item.faceIndex], intent.response, this.plugin);
    }

    private renderSentence(words: SentenceWordSelection[]): void {
        if (!this.bodyEl || !this.footerEl || !this.session) return;
        this.clearKeymap();
        this.revealed = false;

        const picks: SentenceWord[] = words.map(w => ({ card: w.card, faceIndex: w.faceIndex }));
        const drawOpts: SentenceDrawOptions = {
            settings: this.plugin.data.settings,
            constraintPool: this.constraintPool,
            words: () => picks,
            emptyText: "No words available.",
            renderChrome: () => {
                this.renderHeader(null);
                this.renderSentenceActions();
            },
        };

        // Consecutive sentence steps reuse the list so the pill can fade across
        // a regenerate. Arriving from a face view builds it fresh.
        if (this.sentenceListEl) {
            redrawSentence(this.sentenceListEl, drawOpts);
        } else {
            this.bodyEl.empty();
            this.bodyEl.addClass("ef-sentence-body");
            this.sentenceListEl = createSentenceList(this.bodyEl);
            drawSentence(this.sentenceListEl, drawOpts);
        }

        this.firstRender = false;
    }

    private renderSentenceActions(): void {
        if (!this.footerEl) return;
        this.footerEl.empty();
        const onGood = (): void => {
            if (!this.session) return;
            this.session.dismissSentence();
            this.renderStep();
        };
        const onRegen = (): void => {
            if (!this.session) return;
            this.session.regenerateSentence();
            this.renderStep();
        };
        this.addResponseButton(this.footerEl, 1, "Regenerate", "ef-btn-regen", "refresh-cw", null, onRegen);
        this.addResponseButton(this.footerEl, 2, "Good", "ef-btn-good", "check", null, onGood);
    }

    private openEditCardModal(item: LearnItem): void {
        if (!this.session) return;
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
                const finalLines = hadSchedule
                    ? withUpdatedSchedules(parsed, item.card.schedules, this.plugin.data.settings.baseEase)
                    : editedLines;

                const oldLength = item.card.rawLines.length;
                const startLine = item.card.startLine;
                try {
                    await writeCardBack(this.app.vault, this.fileCache, item.filePath, item.card, finalLines);
                } catch (e) {
                    console.error("EuphoricFlashcards LearnModal edit save:", e);
                    return "Failed to write the file.";
                }

                item.card.fields = parsed.fields;
                item.card.rawLines = finalLines;
                item.card.endLine = startLine + finalLines.length - 1;

                const delta = finalLines.length - oldLength;
                if (delta !== 0 && this.session) {
                    shiftLocationsForDelta(this.session.heldLocations(), item.card, item.filePath, delta);
                }

                this.renderStep();
                return null;
            },
        }).open();
    }

    private renderDone(groupsCompleted: number): void {
        this.clearKeymap();
        this.contentEl.empty();
        this.sentenceListEl = null;
        this.contentEl.createDiv({ cls: "ef-done" }, div => {
            staggerIn(div.createEl("h2", { text: "Session complete!" }), 0);
            staggerIn(div.createEl("p", {
                text: `Completed ${groupsCompleted} group${groupsCompleted !== 1 ? "s" : ""}.`,
                cls: "ef-done-sub",
            }), 1);
            const btn = div.createEl("button", { text: "Back to Explorer", cls: "ef-btn ef-btn-primary" });
            btn.addEventListener("click", () => this.backToExplorer());
            staggerIn(btn, 2);
        });
    }
}
