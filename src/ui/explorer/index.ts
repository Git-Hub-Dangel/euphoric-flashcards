import { App, Modal, setIcon } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import { buildDeckTree } from "src/decks";
import type { DeckNode, FileLines } from "src/decks";
import { ReviewModal } from "src/ui/review/index";
import { ConjureSentencesModal } from "src/ui/conjure-sentences/index";
import { LearnModal } from "src/ui/learn/index";
import { addCloseButton, applyAnimationDuration, fadeOutThen, preventBgTapDismiss, staggerIn } from "src/ui/modal-utils";
import type { CardSide, WordSelection, ReviewMode } from "src/settings";

export class ExplorerModal extends Modal {
    private readonly plugin: EuphoricFlashcardsPlugin;

    // Explorer UI state persisted via PluginData.explorerState
    private mode: ReviewMode;
    private cardSide: CardSide;
    private cramSide: CardSide;
    private csSide: CardSide;
    private learnSide: CardSide;
    private learnGroups: number;
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
        this.csSide = saved?.conjureSentencesCardSide ?? settings.defaultConjureSentencesSide;
        this.wordSelection = saved?.conjureSentencesSelection ?? settings.conjureSentencesSelection;
        this.wordCount = settings.conjureSentencesWordCount;
        this.learnSide = saved?.learnCardSide ?? settings.defaultLearnSide;
        this.learnGroups = settings.learnGroupsPerSession;
    }

    private persistState(): void {
        this.plugin.data.explorerState = {
            mode: this.mode,
            reviewCardSide: this.cardSide,
            cramCardSide: this.cramSide,
            conjureSentencesCardSide: this.csSide,
            conjureSentencesSelection: this.wordSelection,
            learnCardSide: this.learnSide,
        };
        void this.plugin.saveData_();
    }

    onOpen(): void {
        this.modalEl.addClass("ef-modal-fullscreen");
        preventBgTapDismiss(this.containerEl);
        addCloseButton(this);
        applyAnimationDuration(this.containerEl, this.plugin.data.settings.animationDurationMs);
        this.contentEl.addClass("ef-explorer");
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
        this.wordCount = settings.conjureSentencesWordCount;
        // Groups-per-session is instance-only; re-read on every open so
        // per-session overrides reset naturally when the Explorer reopens.
        this.learnGroups = settings.learnGroupsPerSession;

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
            this.contentEl.createDiv({ cls: "ef-empty-state" }, div => {
                div.createEl("h2", { text: "No decks found" });
                div.createEl("p", {
                    text: "Add root deck tags in Settings → Euphoric Flashcards.",
                    cls: "ef-muted",
                });
            });
            return;
        }

        // ── Header ──────────────────────────────────────────────────────────
        const headerEl = this.contentEl.createDiv({ cls: "ef-explorer-header" }, h => {
            const titleEl = h.createDiv({ cls: "ef-explorer-title" });
            const iconEl = titleEl.createSpan({ cls: "ef-explorer-icon" });
            setIcon(iconEl, "layers");
            titleEl.createSpan({ text: "Review" });
        });
        staggerIn(headerEl, 0);

        // ── Review Settings ──────────────────────────────────────────────────
        const settingsEl = this.contentEl.createDiv({ cls: "ef-review-settings" }, section => {
            section.createDiv({ text: "Review Settings", cls: "ef-settings-heading" });

            section.createDiv({ cls: "ef-settings-row" }, row => {
                row.createSpan({ text: "Review Mode", cls: "ef-settings-label" });
                const sel = row.createEl("select", { cls: "ef-settings-select" });
                const modes: [ReviewMode, string][] = [
                    ["Review", "Review"],
                    ["Cram", "Cram"],
                    ["Learn", "Learn"],
                    ["ConjureSentences", "Conjure Sentences"],
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

            this.settingsPanelEl = section.createDiv({ cls: "ef-settings-panel" });
        });
        staggerIn(settingsEl, 1);

        this.renderSettingsPanel();

        // ── Deck list ────────────────────────────────────────────────────────
        this.roots = [...tree.values()].filter(n => n.stats.total > 0);

        const sectionTitle = this.contentEl.createDiv({ text: "Decks", cls: "ef-section-title" });
        staggerIn(sectionTitle, 2);

        const wrap = this.contentEl.createDiv({ cls: "ef-deck-list-wrap" });
        staggerIn(wrap, 3);

        // Sticky header row with column labels
        wrap.createDiv({ cls: "ef-deck-header" }, h => {
            h.createSpan(); // spacer above name column
            h.createSpan({ text: "Total", cls: "ef-deck-stat-col ef-stat-total" });
            h.createSpan({ text: "Seen",  cls: "ef-deck-stat-col ef-stat-seen" });
            h.createSpan({ text: "Due",   cls: "ef-deck-stat-col ef-stat-due" });
            h.createSpan({ text: "New",   cls: "ef-deck-stat-col ef-stat-new" });
        });

        this.deckListEl = wrap.createDiv({ cls: "ef-deck-list" });
        // Initial render: animate every row, continuing the header stagger.
        this.renderDeckList(null, 4);
    }

    // `animateFromTag` scopes the fade-in to rows freshly revealed by
    // expanding that node — its own row and existing siblings render
    // instantly, only strict descendants animate. `null` = animate the whole
    // list (used on initial open and back-navigation).
    private renderDeckList(animateFromTag: string | null = null, baseIndex = 0): void {
        if (!this.deckListEl) return;
        this.deckListEl.empty();
        const counter = { i: baseIndex };
        const animateAll = animateFromTag === null;
        for (const root of this.roots) {
            this.renderNode(this.deckListEl, root, 0, counter, animateAll, animateFromTag);
        }
    }

    private renderSettingsPanel(): void {
        if (!this.settingsPanelEl) return;
        this.settingsPanelEl.empty();
        const p = this.settingsPanelEl;

        if (this.mode === "ConjureSentences") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.csSide,
                v => { this.csSide = v as CardSide; this.persistState(); });
        } else if (this.mode === "Review") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.cardSide,
                v => { this.cardSide = v as CardSide; this.persistState(); });
        } else if (this.mode === "Cram") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.cramSide,
                v => { this.cramSide = v as CardSide; this.persistState(); });
        } else if (this.mode === "Learn") {
            this.addSelectRow(p, "Card Side", ["Front", "Back", "Shuffle"], this.learnSide,
                v => { this.learnSide = v as CardSide; this.persistState(); });
            const groupOptions = Array.from({ length: 10 }, (_, i) => String(i + 1));
            this.addSelectRow(p, "Groups", groupOptions, String(this.learnGroups),
                v => { this.learnGroups = parseInt(v, 10); });
        }
    }

    private addSelectRow(
        container: HTMLElement,
        label: string,
        options: string[],
        current: string,
        onChange: (v: string) => void,
    ): void {
        container.createDiv({ cls: "ef-settings-row" }, row => {
            row.createSpan({ text: label, cls: "ef-settings-label" });
            const sel = row.createEl("select", { cls: "ef-settings-select" });
            for (const opt of options) {
                const el = sel.createEl("option", { text: opt });
                el.value = opt;
                if (opt === current) el.selected = true;
            }
            sel.addEventListener("change", () => onChange(sel.value));
        });
    }

    private renderNode(
        container: HTMLElement,
        node: DeckNode,
        depth: number,
        counter: { i: number },
        animate: boolean,
        animateFromTag: string | null,
    ): void {
        if (node.stats.total === 0) return;

        const { total, due, new: newCards } = node.stats;
        const seen = total - newCards;
        const children = [...node.children.values()].filter(c => c.stats.total > 0);
        const hasChildren = children.length > 0;
        const isExpanded = this.expanded.has(node.tag);

        const row = container.createDiv({ cls: "ef-deck-row" });
        if (animate) staggerIn(row, counter.i++);

        // Name cell: indent + chevron + name
        const nameCell = row.createDiv({ cls: "ef-deck-name-cell" });
        nameCell.setCssStyles({ paddingLeft: `${depth * 20}px` });

        const chevron = nameCell.createSpan({ cls: "ef-deck-chevron" });
        if (hasChildren) {
            setIcon(chevron, "chevron-right");
            chevron.addClass("ef-deck-chevron-active");
            if (isExpanded) chevron.addClass("is-open");
            chevron.addEventListener("click", e => {
                e.stopPropagation();
                if (isExpanded) this.expanded.delete(node.tag);
                else this.expanded.add(node.tag);
                this.plugin.data.expandedDecks = [...this.expanded];
                void this.plugin.saveData_();
                // Passing this node's tag scopes animation to freshly-revealed
                // descendants; on collapse `isExpanded` is now false so no
                // children are rendered and nothing animates.
                this.renderDeckList(node.tag);
            });
        }

        nameCell.createSpan({ text: node.name, cls: "ef-deck-name" });

        row.createSpan({ text: String(total),    cls: "ef-deck-stat-col ef-stat-total" });
        row.createSpan({ text: String(seen),     cls: "ef-deck-stat-col ef-stat-seen" });
        row.createSpan({ text: String(due),      cls: "ef-deck-stat-col ef-stat-due" });
        row.createSpan({ text: String(newCards), cls: "ef-deck-stat-col ef-stat-new" });

        row.addEventListener("click", () => this.launchMode(node));

        if (isExpanded) {
            const childAnimate = animate || (animateFromTag !== null && node.tag === animateFromTag);
            for (const child of children) {
                this.renderNode(container, child, depth + 1, counter, childAnimate, animateFromTag);
            }
        }
    }

    private launchMode(node: DeckNode): void {
        fadeOutThen(this, () => {
            this.close();
            this.openTargetModal(node);
        });
    }

    private openTargetModal(node: DeckNode): void {
        if (this.mode === "ConjureSentences") {
            new ConjureSentencesModal(this.app, this.plugin, node, {
                cardSide: this.csSide,
                wordCount: this.wordCount,
                wordSelection: this.wordSelection,
                selectionDeckTag: node.tag,
            }).open();
            return;
        }
        if (this.mode === "Learn") {
            new LearnModal(this.app, this.plugin, node, {
                cardSide: this.learnSide,
                groupLimit: this.learnGroups,
                selectionDeckTag: node.tag,
            }).open();
            return;
        }
        const side = this.mode === "Cram" ? this.cramSide : this.cardSide;
        new ReviewModal(this.app, this.plugin, node, this.mode, side).open();
    }
}
