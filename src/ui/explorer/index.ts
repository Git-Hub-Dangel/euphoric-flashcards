import { App, Modal, setIcon } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { buildDeckTree } from "src/decks";
import type { DeckNode, FileLines } from "src/decks";
import { ReviewModal } from "src/ui/review/index";
import { SentenceBuilderModal } from "src/ui/sentence-builder/index";
import { preventBgTapDismiss } from "src/ui/modal-utils";
import type { CardSide, WordSelection, ReviewMode } from "src/settings";

export class ExplorerModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;

    // Explorer UI state persisted via PluginData.explorerState
    private mode: ReviewMode;
    private cardSide: CardSide;
    private cramSide: CardSide;
    private sbSide: CardSide;
    private wordCount: number;
    private wordSelection: WordSelection;
    private roots: DeckNode[] = [];
    private expanded: Set<string>;

    // DOM refs
    private settingsPanelEl: HTMLElement | null = null;
    private deckListEl: HTMLElement | null = null;

    constructor(app: App, plugin: EuphoricFlashcardsPlugin) {
        super(app);
        this.plugin = plugin;
        this.expanded = new Set(plugin.data.expandedDecks);

        const settings = plugin.data.settings;
        const saved = plugin.data.explorerState;
        this.mode = saved?.mode ?? "Review";
        this.cardSide = saved?.reviewCardSide ?? settings.defaultCardSide;
        this.cramSide = saved?.cramCardSide ?? settings.defaultCardSide;
        this.sbSide = saved?.sentenceBuilderCardSide ?? settings.defaultSentenceBuilderSide;
        this.wordSelection = saved?.sentenceBuilderSelection ?? settings.sentenceBuilderSelection;
        this.wordCount = settings.sentenceBuilderWordCount;
    }

    private persistState(): void {
        this.plugin.data.explorerState = {
            mode: this.mode,
            reviewCardSide: this.cardSide,
            cramCardSide: this.cramSide,
            sentenceBuilderCardSide: this.sbSide,
            sentenceBuilderSelection: this.wordSelection,
        };
        void this.plugin.saveData_();
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        this.contentEl.addClass("ef-explorer");
        this.contentEl.createEl("p", { text: "Loading decks…", cls: "ef-loading" });
        this.load().catch(err => {
            console.error("EuphoricFlashcards ExplorerModal:", err);
            this.contentEl.empty();
            this.contentEl.createEl("p", { text: "Failed to load decks. Check your settings." });
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async load(): Promise<void> {
        const settings = this.plugin.data.settings;
        // Word count is not exposed in the Explorer — always take current setting value.
        this.wordCount = settings.sentenceBuilderWordCount;

        const rootTags = settings.rootDeckTags.map(t => t.startsWith("#") ? t : "#" + t);
        const mdFiles = this.app.vault.getMarkdownFiles();
        const fileLines: FileLines[] = await Promise.all(
            mdFiles.map(async f => ({
                path: f.path,
                lines: (await this.app.vault.read(f)).split("\n"),
            }))
        );

        const tree = buildDeckTree(fileLines, { rootTags, today: new Date() });
        const hasAnyCards = [...tree.values()].some(n => n.stats.total > 0);

        this.contentEl.empty();

        if (!hasAnyCards) {
            this.contentEl.createEl("div", { cls: "ef-empty-state" }, div => {
                div.createEl("h2", { text: "No decks found" });
                div.createEl("p", {
                    text: "Add root deck tags in Settings → Euphoric Flashcards.",
                    cls: "ef-muted",
                });
            });
            return;
        }

        // ── Header ──────────────────────────────────────────────────────────
        this.contentEl.createEl("div", { cls: "ef-explorer-header" }, h => {
            const titleEl = h.createEl("div", { cls: "ef-explorer-title" });
            const iconEl = titleEl.createEl("span", { cls: "ef-explorer-icon" });
            setIcon(iconEl, "layers");
            titleEl.createEl("span", { text: "Review" });
        });

        // ── Review Settings ──────────────────────────────────────────────────
        this.contentEl.createEl("div", { cls: "ef-review-settings" }, section => {
            section.createEl("div", { text: "Review Settings", cls: "ef-settings-heading" });

            section.createEl("div", { cls: "ef-settings-row" }, row => {
                row.createEl("span", { text: "Review Mode", cls: "ef-settings-label" });
                const sel = row.createEl("select", { cls: "ef-settings-select" });
                const modes: [ReviewMode, string][] = [
                    ["Review", "Review"],
                    ["Cram", "Cram"],
                    ["SentenceBuilder", "Sentence Builder"],
                ];
                for (const [val, label] of modes) {
                    const opt = sel.createEl("option", { text: label });
                    opt.value = val;
                    if (val === this.mode) opt.selected = true;
                }
                sel.addEventListener("change", () => {
                    this.mode = sel.value as ReviewMode;
                    this.persistState();
                    this.renderSettingsPanel();
                });
            });

            this.settingsPanelEl = section.createEl("div", { cls: "ef-settings-panel" });
        });

        this.renderSettingsPanel();

        // ── Deck list ────────────────────────────────────────────────────────
        this.roots = [...tree.values()].filter(n => n.stats.total > 0);

        this.contentEl.createEl("div", { text: "Decks", cls: "ef-section-title" });

        const wrap = this.contentEl.createEl("div", { cls: "ef-deck-list-wrap" });

        // Sticky header row with column labels
        wrap.createEl("div", { cls: "ef-deck-header" }, h => {
            h.createEl("span"); // spacer above name column
            h.createEl("span", { text: "Total", cls: "ef-deck-stat-col ef-stat-total" });
            h.createEl("span", { text: "Seen",  cls: "ef-deck-stat-col ef-stat-seen" });
            h.createEl("span", { text: "Due",   cls: "ef-deck-stat-col ef-stat-due" });
            h.createEl("span", { text: "New",   cls: "ef-deck-stat-col ef-stat-new" });
        });

        this.deckListEl = wrap.createEl("div", { cls: "ef-deck-list" });
        this.renderDeckList();
    }

    private renderDeckList(): void {
        if (!this.deckListEl) return;
        this.deckListEl.empty();
        for (const root of this.roots) {
            this.renderNode(this.deckListEl, root, 0);
        }
    }

    private renderSettingsPanel(): void {
        if (!this.settingsPanelEl) return;
        this.settingsPanelEl.empty();
        const p = this.settingsPanelEl;

        if (this.mode === "SentenceBuilder") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.sbSide,
                v => { this.sbSide = v as CardSide; this.persistState(); });
            this.addSelectRow(p, "Selection", ["Random", "Optimised"], this.wordSelection,
                v => { this.wordSelection = v as WordSelection; this.persistState(); });
        } else if (this.mode === "Review") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.cardSide,
                v => { this.cardSide = v as CardSide; this.persistState(); });
        } else if (this.mode === "Cram") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.cramSide,
                v => { this.cramSide = v as CardSide; this.persistState(); });
        }
    }

    private addSelectRow(
        container: HTMLElement,
        label: string,
        options: string[],
        current: string,
        onChange: (v: string) => void,
    ): void {
        container.createEl("div", { cls: "ef-settings-row" }, row => {
            row.createEl("span", { text: label, cls: "ef-settings-label" });
            const sel = row.createEl("select", { cls: "ef-settings-select" });
            for (const opt of options) {
                const el = sel.createEl("option", { text: opt });
                el.value = opt;
                if (opt === current) el.selected = true;
            }
            sel.addEventListener("change", () => onChange(sel.value));
        });
    }

    private renderNode(container: HTMLElement, node: DeckNode, depth: number): void {
        if (node.stats.total === 0) return;

        const { total, due, new: newCards } = node.stats;
        const seen = total - newCards;
        const children = [...node.children.values()].filter(c => c.stats.total > 0);
        const hasChildren = children.length > 0;
        const isExpanded = this.expanded.has(node.tag);

        const row = container.createEl("div", { cls: "ef-deck-row" });

        // Name cell: indent + chevron + name
        const nameCell = row.createEl("div", { cls: "ef-deck-name-cell" });
        nameCell.style.paddingLeft = `${depth * 20}px`;

        const chevron = nameCell.createEl("span", { cls: "ef-deck-chevron" });
        if (hasChildren) {
            setIcon(chevron, isExpanded ? "chevron-down" : "chevron-right");
            chevron.addClass("ef-deck-chevron-active");
            chevron.addEventListener("click", e => {
                e.stopPropagation();
                if (isExpanded) this.expanded.delete(node.tag);
                else this.expanded.add(node.tag);
                this.plugin.data.expandedDecks = [...this.expanded];
                void this.plugin.saveData_();
                this.renderDeckList();
            });
        }

        nameCell.createEl("span", { text: node.name, cls: "ef-deck-name" });

        row.createEl("span", { text: String(total),    cls: "ef-deck-stat-col ef-stat-total" });
        row.createEl("span", { text: String(seen),     cls: "ef-deck-stat-col ef-stat-seen" });
        row.createEl("span", { text: String(due),      cls: "ef-deck-stat-col ef-stat-due" });
        row.createEl("span", { text: String(newCards), cls: "ef-deck-stat-col ef-stat-new" });

        row.addEventListener("click", () => this.launchMode(node));

        if (isExpanded) {
            for (const child of children) {
                this.renderNode(container, child, depth + 1);
            }
        }
    }

    private launchMode(node: DeckNode): void {
        this.close();
        if (this.mode === "SentenceBuilder") {
            new SentenceBuilderModal(this.app, this.plugin, node, {
                cardSide: this.sbSide,
                wordCount: this.wordCount,
                wordSelection: this.wordSelection,
                selectionDeckTag: node.tag,
            }).open();
            return;
        }
        const side = this.mode === "Cram" ? this.cramSide : this.cardSide;
        new ReviewModal(this.app, this.plugin, node, this.mode, side).open();
    }
}
