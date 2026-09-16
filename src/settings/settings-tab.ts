import { App, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import type { TypeConfig } from "src/settings/index";

export class EuphoricSettingsTab extends PluginSettingTab {
    private readonly plugin: EuphoricFlashcardsPlugin;

    constructor(app: App, plugin: EuphoricFlashcardsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.renderDecks(containerEl);
        this.renderScheduling(containerEl);
        this.renderCardTypes(containerEl);
        this.renderReview(containerEl);
        this.renderSentenceBuilder(containerEl);
    }

    private save(): void {
        this.plugin.saveData_().catch(err =>
            console.error("EuphoricFlashcards: failed to save settings", err)
        );
    }

    // ── Decks ──────────────────────────────────────────────────────────────

    private renderDecks(el: HTMLElement): void {
        el.createEl("h2", { text: "Decks" });

        new Setting(el)
            .setName("Root deck tags")
            .setDesc("One tag per line, e.g. #español. Cards under these tags (and their subtags) are included.")
            .addTextArea(text => {
                text.setPlaceholder("#español\n#deutsch");
                text.setValue(this.plugin.data.settings.rootDeckTags.join("\n"));
                text.inputEl.rows = 4;
                text.onChange(v => {
                    this.plugin.data.settings.rootDeckTags = v
                        .split(/[\n,]+/)
                        .map(t => t.trim())
                        .filter(t => t.length > 0);
                    this.save();
                });
            });
    }

    // ── Scheduling ─────────────────────────────────────────────────────────

    private renderScheduling(el: HTMLElement): void {
        el.createEl("h2", { text: "Scheduling" });

        this.addSliderNumber(el, "Base ease (%)", "Starting ease factor for new cards.", 130, 400, 10,
            () => this.plugin.data.settings.baseEase,
            v => { this.plugin.data.settings.baseEase = v; });

        this.addSliderNumber(el, "Easy bonus", "Multiplier applied to interval on an Easy response.", 1.0, 2.0, 0.05,
            () => this.plugin.data.settings.easyBonus,
            v => { this.plugin.data.settings.easyBonus = v; });

        this.addSliderNumber(el, "Lapse interval change", "Interval multiplier after a lapse (Again).", 0.01, 1.0, 0.01,
            () => this.plugin.data.settings.lapsesIntervalChange,
            v => { this.plugin.data.settings.lapsesIntervalChange = v; });

        this.addSliderNumber(el, "Maximum interval (days)", "Cards will not be scheduled beyond this many days.", 7, 36525, 1,
            () => this.plugin.data.settings.maximumInterval,
            v => { this.plugin.data.settings.maximumInterval = v; });

        this.addSliderNumber(el, "Max link factor", "Weight given to the linked note's ease during scheduling.", 0, 1.0, 0.05,
            () => this.plugin.data.settings.maxLinkFactor,
            v => { this.plugin.data.settings.maxLinkFactor = v; });

        new Setting(el)
            .setName("Load balance")
            .setDesc("Spread cards across nearby days to avoid review spikes.")
            .addToggle(toggle => {
                toggle.setValue(this.plugin.data.settings.loadBalance);
                toggle.onChange(v => {
                    this.plugin.data.settings.loadBalance = v;
                    this.save();
                });
            });

        new Setting(el)
            .setName("Start of day")
            .setDesc("Cards scheduled for today are due after this time (HH:MM:SS).")
            .addText(text => {
                text.setPlaceholder("00:00:00");
                text.setValue(this.plugin.data.settings.startOfDay);
                text.onChange(v => {
                    this.plugin.data.settings.startOfDay = v.trim();
                    this.save();
                });
            });
    }

    // ── Card types ─────────────────────────────────────────────────────────

    private renderCardTypes(el: HTMLElement): void {
        el.createEl("h2", { text: "Card types" });
        el.createEl("p", {
            text: "Keys are used in card syntax (e.g. =n for noun). Colors are shown as badge backgrounds.",
            cls: "setting-item-description",
        });

        const listEl = el.createEl("div", { cls: "ef-ct-list" });
        this.redrawCardTypeList(listEl);
    }

    private redrawCardTypeList(listEl: HTMLElement): void {
        listEl.empty();

        for (let i = 0; i < this.plugin.data.settings.cardTypes.length; i++) {
            this.renderCardTypeRow(listEl, i);
        }

        new Setting(listEl)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText("Add type").onClick(() => {
                    this.plugin.data.settings.cardTypes.push({ key: "", label: "", color: "#888888" });
                    this.save();
                    this.redrawCardTypeList(listEl);
                });
            });
    }

    private renderCardTypeRow(listEl: HTMLElement, i: number): void {
        const tc = this.plugin.data.settings.cardTypes[i] as TypeConfig;

        const setting = new Setting(listEl)
            .addText(text => {
                text.setPlaceholder("key");
                text.setValue(tc.key);
                text.inputEl.style.width = "60px";
                text.onChange(v => {
                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).key = v.trim();
                    this.save();
                });
            })
            .addText(text => {
                text.setPlaceholder("label");
                text.setValue(tc.label);
                text.inputEl.style.width = "100px";
                text.onChange(v => {
                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).label = v;
                    this.save();
                });
            })
            .addColorPicker(picker => {
                picker.setValue(tc.color);
                picker.onChange(v => {
                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).color = v;
                    this.save();
                });
            })
            .addButton((btn: ButtonComponent) => {
                btn.setIcon("trash").setTooltip("Remove").onClick(() => {
                    this.plugin.data.settings.cardTypes.splice(i, 1);
                    this.save();
                    this.redrawCardTypeList(listEl);
                });
            });

        setting.settingEl.style.borderBottom = "none";
        setting.nameEl.style.display = "none";
        setting.descEl.style.display = "none";
    }

    // ── Review ─────────────────────────────────────────────────────────────

    private renderReview(el: HTMLElement): void {
        el.createEl("h2", { text: "Review" });

        new Setting(el)
            .setName("Default card side")
            .setDesc("Which side to prompt first when starting a review session.")
            .addDropdown(drop => {
                drop.addOption("Front", "Front");
                drop.addOption("Back", "Back");
                drop.addOption("Shuffle", "Shuffle");
                drop.setValue(this.plugin.data.settings.defaultCardSide);
                drop.onChange(v => {
                    this.plugin.data.settings.defaultCardSide = v as "Front" | "Back" | "Shuffle";
                    this.save();
                });
            });

        new Setting(el)
            .setName("Show interval on buttons")
            .setDesc("Display the resulting interval (e.g. 4d) on Okay/Good buttons during review.")
            .addToggle(toggle => {
                toggle.setValue(this.plugin.data.settings.showIntervalOnButtons);
                toggle.onChange(v => {
                    this.plugin.data.settings.showIntervalOnButtons = v;
                    this.save();
                });
            });
    }

    // ── Sentence Builder ───────────────────────────────────────────────────

    private renderSentenceBuilder(el: HTMLElement): void {
        el.createEl("h2", { text: "Sentence Builder" });

        new Setting(el)
            .setName("Default card side")
            .setDesc("Which side of each card to display as the word prompt.")
            .addDropdown(drop => {
                drop.addOption("Front", "Front");
                drop.addOption("Back", "Back");
                drop.addOption("Shuffle", "Shuffle");
                drop.setValue(this.plugin.data.settings.defaultSentenceBuilderSide);
                drop.onChange(v => {
                    this.plugin.data.settings.defaultSentenceBuilderSide = v as "Front" | "Back" | "Shuffle";
                    this.save();
                });
            });

        new Setting(el)
            .setName("Word count")
            .setDesc("Number of words shown per sentence (1–20).")
            .addSlider(slider => {
                slider.setLimits(1, 20, 1);
                slider.setValue(this.plugin.data.settings.sentenceBuilderWordCount);
                slider.setDynamicTooltip();
                slider.onChange(v => {
                    this.plugin.data.settings.sentenceBuilderWordCount = v;
                    this.save();
                });
            });

        new Setting(el)
            .setName("Word selection")
            .setDesc("Random: uniform draw. Optimised: ~half mature, rest new.")
            .addDropdown(drop => {
                drop.addOption("Random", "Random");
                drop.addOption("Optimised", "Optimised");
                drop.setValue(this.plugin.data.settings.sentenceBuilderSelection);
                drop.onChange(v => {
                    this.plugin.data.settings.sentenceBuilderSelection = v as "Random" | "Optimised";
                    this.save();
                });
            });
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private addSliderNumber(
        el: HTMLElement,
        name: string,
        desc: string,
        min: number,
        max: number,
        step: number,
        get: () => number,
        set: (v: number) => void,
    ): void {
        new Setting(el)
            .setName(name)
            .setDesc(desc)
            .addSlider(slider => {
                slider.setLimits(min, max, step);
                slider.setValue(get());
                slider.setDynamicTooltip();
                slider.onChange(v => { set(v); this.save(); });
            })
            .addText(text => {
                text.setValue(String(get()));
                text.inputEl.type = "number";
                text.inputEl.style.width = "72px";
                text.onChange(v => {
                    const n = parseFloat(v);
                    if (!isNaN(n) && n >= min && n <= max) { set(n); this.save(); }
                });
            });
    }
}
