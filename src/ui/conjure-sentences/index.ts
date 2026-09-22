import { App, Modal, Platform, setIcon } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { buildDeckTree, flattenDeckTree } from "src/decks";
import type { DeckNode, FileLines } from "src/decks";
import { loadCardsForDeck } from "src/ui/review/load-cards";
import type { ReviewCard } from "src/ui/review/load-cards";
import { frontFace, backFace, cardReveal } from "src/parsing";
import type { ParsedCard } from "src/parsing";
import type { CardSide, WordSelection } from "src/settings";
import { ExplorerModal } from "src/ui/explorer/index";
import { addCloseButton, applyAnimationDuration, fadeOutThen, preventBgTapDismiss, staggerIn } from "src/ui/modal-utils";
import { fisherYates } from "src/utils/shuffle";
import { resolveFaceIndex } from "src/utils/face";

export interface ConjureSentencesOptions {
    cardSide: CardSide;
    wordCount: number;
    wordSelection: WordSelection;
    selectionDeckTag: string;
}

interface WordItem {
    card: ParsedCard;
    faceIndex: 0 | 1;
}

export class ConjureSentencesModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;
    private readonly options: ConjureSentencesOptions;

    private allCards: ReviewCard[] = [];
    private wordListEl: HTMLElement | null = null;
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
        this.constraintPool = this.buildConstraintPool();
        this.contentEl.empty();
        this.buildLayout();
        this.drawWords();
    }

    private buildConstraintPool(): string[] {
        const settings = this.plugin.data.settings;
        if (!settings.enableConstructionConstraints) return [];
        const target = this.options.selectionDeckTag.replace(/^#/, "").toLowerCase();
        const pool: string[] = [];
        for (const cc of settings.constructionConstraints) {
            const match = cc.deckTags.some(t => {
                const bound = t.replace(/^#/, "").toLowerCase();
                if (bound.length === 0) return false;
                return target === bound || target.startsWith(bound + "/");
            });
            if (match) pool.push(...cc.labels);
        }
        return pool;
    }

    private buildLayout(): void {
        const headerEl = this.contentEl.createDiv({ cls: "ef-cs-header" }, h => {
            const titleEl = h.createDiv({ cls: "ef-cs-title" });
            const iconEl = titleEl.createSpan({ cls: "ef-cs-icon" });
            setIcon(iconEl, "book-open");
            titleEl.createSpan({ text: "Conjure Sentences" });
        });
        staggerIn(headerEl, 0);

        this.wordListEl = this.contentEl.createDiv({ cls: "ef-cs-word-list" });

        const footerEl = this.contentEl.createDiv({ cls: "ef-cs-footer" }, footer => {
            this.addFooterButton(footer, 1, "Regenerate", "refresh-cw", "ef-btn-regen", () => this.drawWords());
            this.addFooterButton(footer, 2, "Good", "check", "ef-btn-good", () => this.drawWords());
        });
        staggerIn(footerEl, 1);

        this.scope.register([], "1", () => { this.drawWords(); return false; });
        this.scope.register([], "2", () => { this.drawWords(); return false; });
    }

    private addFooterButton(
        container: HTMLElement,
        keyNum: number,
        label: string,
        icon: string,
        cls: string,
        onClick: () => void,
    ): void {
        const btn = container.createEl("button", { cls: `ef-btn ef-btn-response ${cls}` });
        if (Platform.isDesktop && this.plugin.data.settings.showKeybindingsOnDesktop) {
            btn.createSpan({ text: String(keyNum), cls: "ef-btn-key" });
        }
        setIcon(btn.createSpan({ cls: "ef-btn-icon" }), icon);
        btn.createSpan({ text: label, cls: "ef-btn-label" });
        btn.addEventListener("click", onClick);
    }

    private drawWords(): void {
        if (!this.wordListEl) return;
        const wordListEl = this.wordListEl;
        const existingPill = wordListEl.querySelector<HTMLElement>(".ef-cc-pill");
        const doDraw = (): void => this.renderDraw(wordListEl);
        if (existingPill && this.plugin.data.settings.animationDurationMs > 0) {
            existingPill.addClass("ef-fading");
            window.setTimeout(doDraw, 100);
        } else {
            doDraw();
        }
    }

    private renderDraw(wordListEl: HTMLElement): void {
        const words = this.selectWords();
        wordListEl.empty();

        if (words.length === 0) {
            wordListEl.createEl("p", { text: "No cards in selection deck.", cls: "ef-loading" });
            return;
        }

        let idx = 0;
        const label = this.constraintPool[Math.floor(Math.random() * this.constraintPool.length)];
        if (label !== undefined) {
            const pillWrap = wordListEl.createDiv({ cls: "ef-cc-pill-wrap" }, wrap => {
                wrap.createSpan({ text: label, cls: "ef-cc-pill" });
            });
            staggerIn(pillWrap, idx++);
        }

        for (const item of words) {
            const row = this.renderWordItem(wordListEl, item);
            staggerIn(row, idx++);
        }
    }

    private selectWords(): WordItem[] {
        const { wordCount, wordSelection, cardSide } = this.options;

        // orientation once per sentence for all cards
        const faceIndex = resolveFaceIndex(cardSide);

        const toWordItem = (rc: ReviewCard): WordItem => ({ card: rc.card, faceIndex });

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

            return fisherYates(picked).map(toWordItem);
        }

        // Random
        return fisherYates([...this.allCards])
            .slice(0, Math.min(wordCount, this.allCards.length))
            .map(toWordItem);
    }

    private renderWordItem(container: HTMLElement, item: WordItem): HTMLElement {
        const settings = this.plugin.data.settings;
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
}
