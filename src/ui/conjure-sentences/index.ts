import { App, Modal, setIcon } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { buildDeckTree, flattenDeckTree } from "src/decks";
import type { DeckNode, FileLines } from "src/decks";
import { loadCardsForDeck } from "src/ui/review/load-cards";
import type { ReviewCard } from "src/ui/review/load-cards";
import type { CardSide, WordSelection } from "src/settings";
import { ExplorerModal } from "src/ui/explorer/index";
import { addCloseButton, applyAnimationDuration, fadeOutThen, preventBgTapDismiss, staggerIn } from "src/ui/modal-utils";
import { fisherYates } from "src/utils/shuffle";
import { resolveFaceIndex } from "src/utils/face";
import { buildConstructionConstraintPool } from "src/ui/shared/construction-constraints";
import { renderResponseButton } from "src/ui/shared/response-button";
import { createSentenceList, redrawSentence } from "src/ui/shared/sentence-view";
import type { SentenceWord } from "src/ui/shared/sentence-view";

export interface ConjureSentencesOptions {
    cardSide: CardSide;
    wordCount: number;
    wordSelection: WordSelection;
    selectionDeckTag: string;
}

export class ConjureSentencesModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;
    private readonly options: ConjureSentencesOptions;

    private allCards: ReviewCard[] = [];
    private wordListEl: HTMLElement | null = null;
    private footerEl: HTMLElement | null = null;
    private constraintPool: string[] = [];

    constructor(
        app: App,
        plugin: EuphoricFlashcardsPlugin,
        _node: DeckNode,
        options: ConjureSentencesOptions,
    ) {
        super(app);
        this.plugin = plugin;
        this.options = options;
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        addCloseButton(this);
        applyAnimationDuration(this.containerEl, this.plugin.data.settings.animationDurationMs);
        this.contentEl.addClass("ef-conjure-sentences");
        this.addBackButton();
        this.load().catch(err => {
            console.error("EuphoricFlashcards ConjureSentencesModal:", err);
            this.contentEl.empty();
            this.contentEl.createEl("p", { text: "Failed to load cards." });
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private addBackButton(): void {
        const btn = this.modalEl.createEl("button", {
            cls: "ef-back-btn",
            attr: { "aria-label": "Back to Explorer", tabindex: "-1" },
        });
        setIcon(btn, "arrow-left");
        btn.addEventListener("click", () => {
            fadeOutThen(this, () => {
                this.close();
                new ExplorerModal(this.app, this.plugin).open();
            });
        });
    }

    private async load(): Promise<void> {
        const settings = this.plugin.data.settings;
        const rootTags = settings.rootDeckTags.map(t => t.startsWith("#") ? t : "#" + t);

        const mdFiles = this.app.vault.getMarkdownFiles();
        const fileLines: FileLines[] = await Promise.all(
            mdFiles.map(async f => ({
                path: f.path,
                lines: (await this.app.vault.read(f)).split("\n"),
            }))
        );

        const tree = buildDeckTree(fileLines, { rootTags, today: new Date() });
        const selectionNode = flattenDeckTree(tree).find(
            n => n.tag.toLowerCase() === this.options.selectionDeckTag.toLowerCase()
        );

        if (!selectionNode) {
            this.contentEl.empty();
            this.contentEl.createEl("p", { text: "Selection deck not found.", cls: "ef-loading" });
            return;
        }

        this.allCards = await loadCardsForDeck(this.app.vault, selectionNode, rootTags);
        this.constraintPool = buildConstructionConstraintPool(this.plugin.data.settings, this.options.selectionDeckTag);
        this.contentEl.empty();
        this.buildLayout();
        this.drawWords();
    }

    private buildLayout(): void {
        const headerEl = this.contentEl.createDiv({ cls: "ef-cs-header" }, h => {
            const titleEl = h.createDiv({ cls: "ef-cs-title" });
            const iconEl = titleEl.createSpan({ cls: "ef-cs-icon" });
            setIcon(iconEl, "book-open");
            titleEl.createSpan({ text: "Conjure Sentences" });
        });
        staggerIn(headerEl, 0);

        this.wordListEl = createSentenceList(this.contentEl);

        this.footerEl = this.contentEl.createDiv({ cls: "ef-cs-footer" });
        staggerIn(this.footerEl, 1);

        this.scope.register([], "1", () => { this.drawWords(); return false; });
        this.scope.register([], "2", () => { this.drawWords(); return false; });
    }

    private drawWords(): void {
        if (!this.wordListEl) return;
        redrawSentence(this.wordListEl, {
            settings: this.plugin.data.settings,
            constraintPool: this.constraintPool,
            words: () => this.selectWords(),
            emptyText: "No cards in selection deck.",
            renderChrome: () => this.renderActions(),
        });
    }

    // Rebuilt on every draw so the buttons replay their entrance, giving the
    // same tap feedback Learn has. Key bindings live on the scope, so
    // discarding the elements does not drop them.
    private renderActions(): void {
        if (!this.footerEl) return;
        this.footerEl.empty();
        const settings = this.plugin.data.settings;
        renderResponseButton(this.footerEl, settings, {
            keyNum: 1, label: "Regenerate", cls: "ef-btn-regen", icon: "refresh-cw",
            onClick: () => this.drawWords(),
        });
        renderResponseButton(this.footerEl, settings, {
            keyNum: 2, label: "Good", cls: "ef-btn-good", icon: "check",
            onClick: () => this.drawWords(),
        });
    }

    private selectWords(): SentenceWord[] {
        const { wordCount, wordSelection, cardSide } = this.options;

        // orientation once per sentence for all cards
        const faceIndex = resolveFaceIndex(cardSide);

        const toSentenceWord = (rc: ReviewCard): SentenceWord => ({ card: rc.card, faceIndex });

        if (wordSelection === "Optimised") {
            const mature = this.allCards.filter(
                rc => rc.card.schedules[0] !== null || rc.card.schedules[1] !== null
            );
            const newCards = this.allCards.filter(
                rc => rc.card.schedules[0] === null && rc.card.schedules[1] === null
            );

            const targetMature = Math.floor(wordCount / 2);
            const shuffledMature = fisherYates([...mature]);
            const shuffledNew = fisherYates([...newCards]);

            const picked: ReviewCard[] = [];
            picked.push(...shuffledMature.slice(0, Math.min(targetMature, shuffledMature.length)));
            const remaining = wordCount - picked.length;
            picked.push(...shuffledNew.slice(0, Math.min(remaining, shuffledNew.length)));

            // Fill any remaining gap from leftover mature pool
            if (picked.length < wordCount) {
                const leftover = shuffledMature.slice(Math.min(targetMature, shuffledMature.length));
                picked.push(...leftover.slice(0, wordCount - picked.length));
            }

            return fisherYates(picked).map(toSentenceWord);
        }

        // Random
        return fisherYates([...this.allCards])
            .slice(0, Math.min(wordCount, this.allCards.length))
            .map(toSentenceWord);
    }

}
