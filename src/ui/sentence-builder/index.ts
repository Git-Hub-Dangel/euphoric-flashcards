import { App, Modal, setIcon } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { buildDeckTree, flattenDeckTree } from "src/decks";
import type { DeckNode, FileLines } from "src/decks";
import { loadCardsForDeck } from "src/ui/review/load-cards";
import type { ReviewCard } from "src/ui/review/load-cards";
import { frontFace, backFace, cardReveal } from "src/parsing";
import type { ParsedCard } from "src/parsing";
import type { CardSide, WordSelection } from "src/settings";
import { ExplorerModal } from "src/ui/explorer/index";
import { preventBgTapDismiss } from "src/ui/modal-utils";

export interface SentenceBuilderOptions {
    cardSide: CardSide;
    wordCount: number;
    wordSelection: WordSelection;
    selectionDeckTag: string;
}

interface WordItem {
    card: ParsedCard;
    faceIndex: 0 | 1;
}

function fisherYates<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

export class SentenceBuilderModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;
    private readonly options: SentenceBuilderOptions;

    private allCards: ReviewCard[] = [];
    private wordListEl: HTMLElement | null = null;

    constructor(
        app: App,
        plugin: EuphoricFlashcardsPlugin,
        _node: DeckNode,
        options: SentenceBuilderOptions,
    ) {
        super(app);
        this.plugin = plugin;
        this.options = options;
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        this.contentEl.addClass("ef-sentence-builder");
        this.addBackButton();
        this.contentEl.createEl("p", { text: "Loading…", cls: "ef-loading" });
        this.load().catch(err => {
            console.error("EuphoricFlashcards SentenceBuilderModal:", err);
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
            attr: { "aria-label": "Back to Explorer" },
        });
        setIcon(btn, "arrow-left");
        btn.addEventListener("click", () => {
            this.close();
            new ExplorerModal(this.app, this.plugin).open();
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
        this.contentEl.empty();
        this.buildLayout();
        this.drawWords();
    }

    private buildLayout(): void {
        this.contentEl.createEl("div", { cls: "ef-sb-header" }, h => {
            const titleEl = h.createEl("div", { cls: "ef-sb-title" });
            const iconEl = titleEl.createEl("span", { cls: "ef-sb-icon" });
            setIcon(iconEl, "book-open");
            titleEl.createEl("span", { text: "Sentence Builder" });
        });

        this.wordListEl = this.contentEl.createEl("div", { cls: "ef-sb-word-list" });

        this.contentEl.createEl("div", { cls: "ef-sb-footer" }, footer => {
            this.addFooterButton(footer, 1, "Regenerate", "refresh-cw", "ef-btn-regen", () => this.drawWords());
            this.addFooterButton(footer, 2, "Good", "check", "ef-btn-good", () => this.drawWords());
        });

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
        btn.createEl("span", { text: String(keyNum), cls: "ef-btn-key" });
        setIcon(btn.createEl("span", { cls: "ef-btn-icon" }), icon);
        btn.createEl("span", { text: label, cls: "ef-btn-label" });
        btn.addEventListener("click", onClick);
    }

    private drawWords(): void {
        if (!this.wordListEl) return;
        const words = this.selectWords();
        this.wordListEl.empty();

        if (words.length === 0) {
            this.wordListEl.createEl("p", { text: "No cards in selection deck.", cls: "ef-loading" });
            return;
        }

        for (const item of words) {
            this.renderWordItem(this.wordListEl, item);
        }
    }

    private selectWords(): WordItem[] {
        const { wordCount, wordSelection, cardSide } = this.options;

        // orientation once per sentence for all cards
        const faceIndex: 0 | 1 =
            cardSide === "Front" ? 0
            : cardSide === "Back" ? 1
            : (Math.random() < 0.5 ? 0 : 1);

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

    private renderWordItem(container: HTMLElement, item: WordItem): void {
        const settings = this.plugin.data.settings;
        const face = item.faceIndex === 0 ? frontFace(item.card) : backFace(item.card);
        const reveal = cardReveal(item.card);

        const row = container.createEl("div", { cls: "ef-sb-word-row" });

        const promptRow = row.createEl("div", { cls: "ef-sb-prompt-row" });
        promptRow.createEl("span", { text: face.prompt, cls: "ef-sb-word-text" });

        const revealBtn = promptRow.createEl("button", { cls: "ef-btn ef-sb-reveal-btn" });
        const revealBtnIcon = revealBtn.createEl("span", { cls: "ef-btn-icon" });
        setIcon(revealBtnIcon, "eye");
        revealBtn.createEl("span", { text: "Reveal" });

        const revealArea = row.createEl("div", { cls: "ef-sb-reveal-area ef-hidden" });

        revealArea.createEl("div", { cls: "ef-card-answer-line" }, line => {
            line.createEl("span", { text: face.answer, cls: "ef-sb-word-answer" });
            if (reveal.type) {
                const tc = settings.cardTypes.find(t => t.key === reveal.type);
                const badge = line.createEl("span", {
                    text: tc?.label ?? reveal.type,
                    cls: "ef-type-badge",
                });
                badge.style.backgroundColor = tc?.color ?? "var(--background-modifier-border)";
            }
        });

        if (reveal.explanation) {
            revealArea.createEl("p", { text: reveal.explanation, cls: "ef-explanation" });
        }
        if (reveal.examples.length > 0) {
            const list = revealArea.createEl("div", { cls: "ef-examples" });
            for (const ex of reveal.examples) {
                list.createEl("div", { text: `“${ex}”`, cls: "ef-example-item" });
            }
        }

        revealBtn.addEventListener("click", () => {
            const isHidden = revealArea.hasClass("ef-hidden");
            revealArea.toggleClass("ef-hidden", !isHidden);
            setIcon(revealBtnIcon, isHidden ? "eye-off" : "eye");
        });
    }
}
