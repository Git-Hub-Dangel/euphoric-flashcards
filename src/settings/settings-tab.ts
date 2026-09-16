import { App, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import type { TypeConfig } from "src/settings/index";
import { DEFAULT_SETTINGS } from "src/settings/index";

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

    // decks

    private renderDecks(el: HTMLElement): void {
        el.createEl("h2", { text: "Decks" });

        new Setting(el)
            .setName("Root deck tags")
            .setDesc("One tag per line. (e.g. #español) Card definitions in notes located under these tags are included. Specifying a tag will include all of its subdecks. (e.g. defining #español will include all words defined under tag patterns #español, #español/...,  #español/.../..., etc. (e.g. #español/palabras-clave,  #español/verbos)")
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

    // scheduling

    private renderScheduling(el: HTMLElement): void {
        el.createEl("h2", { text: "Scheduling" });

        new Setting(el)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText("Restore Default Settings").onClick(() => {
                    const d = DEFAULT_SETTINGS;
                    const s = this.plugin.data.settings;
                    s.baseEase = d.baseEase;
                    s.easyBonus = d.easyBonus;
                    s.lapsesIntervalChange = d.lapsesIntervalChange;
                    s.maximumInterval = d.maximumInterval;
                    s.maxLinkFactor = d.maxLinkFactor;
                    s.loadBalance = d.loadBalance;
                    s.startOfDay = d.startOfDay;
                    this.save();
                    this.display();
                });
            });

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
            .setName("Start of day")
            .setDesc("Cards whose due date is today only become available after this time. Set to e.g. 04:00:00 if you study past midnight and want yesterday's cards to stay due until then (HH:MM:SS).")
            .addText(text => {
                text.setPlaceholder("00:00:00");
                text.setValue(this.plugin.data.settings.startOfDay);
                text.onChange(v => {
                    this.plugin.data.settings.startOfDay = v.trim();
                    this.save();
                });
            });

        this.renderHistogramControls(el);
    }

    // card types

    private renderCardTypes(el: HTMLElement): void {
        el.createEl("h2", { text: "Card types" });
        el.createEl("p", {
            text: "Keys are used in card syntax (e.g. =n for noun). Define colors to differentiate types visually",
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

    // review

    private renderReview(el: HTMLElement): void {
        el.createEl("h2", { text: "Review" });

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

    // sentence builder

    private renderSentenceBuilder(el: HTMLElement): void {
        el.createEl("h2", { text: "Sentence Builder" });

        new Setting(el)
            .setName("Word count")
            .setDesc("Number of words shown per sentence.")
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
            .setName("Word selection method")
            .setDesc("Random: random draw from selected deck. Optimised: assures, that the selection contains an even mix of older and newer cards.")
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

    private renderHistogramControls(el: HTMLElement): void {
        el.createEl("h3", { text: "Load Balancing" });
        el.createEl("p", {
            cls: "setting-item-description",
            text: "A count of how many cards are due on each future day. Load balance uses this to nudge scheduled cards toward less-crowded days. Updates automatically as you review and does a full rebuild about once a day.",
        });

        new Setting(el)
            .setName("Enable Load Balancing")
            .setDesc("Spread cards across nearby days to avoid review spikes.")
            .addToggle(toggle => {
                toggle.setValue(this.plugin.data.settings.loadBalance);
                toggle.onChange(v => {
                    this.plugin.data.settings.loadBalance = v;
                    this.save();
                });
            });

        const builtAt = this.plugin.histogramStore.getBuiltAt();
        const builtAtStr = builtAt ? new Date(builtAt).toLocaleString() : "never — rebuild recommended";

        new Setting(el)
            .setName("Rebuild histogram")
            .setDesc(`Rescans every note in the vault. Takes a few seconds. Last full rebuild: ${builtAtStr}.`)
            .addButton((btn: ButtonComponent) => {
                btn.setButtonText("Rebuild now").onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText("Rebuilding…");
                    try {
                        await this.plugin.histogramStore.rebuild(this.app.vault);
                        this.save();
                    } catch (err) {
                        console.error("EuphoricFlashcards: histogram rebuild failed", err);
                    } finally {
                        this.display();
                    }
                });
            });
    }

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
        let sliderEl: HTMLInputElement | null = null;
        let textEl: HTMLInputElement | null = null;
        new Setting(el)
            .setName(name)
            .setDesc(desc)
            .addSlider(slider => {
                slider.setLimits(min, max, step);
                slider.setValue(get());
                slider.setDynamicTooltip();
                sliderEl = slider.sliderEl;
                slider.onChange(v => {
                    set(v);
                    if (textEl) textEl.value = String(v);
                    this.save();
                });
            })
            .addText(text => {
                textEl = text.inputEl;
                text.setValue(String(get()));
                text.inputEl.type = "number";
                text.inputEl.style.width = "72px";
                text.onChange(v => {
                    const n = parseFloat(v);
                    if (!isNaN(n) && n >= min && n <= max) {
                        set(n);
                        if (sliderEl) sliderEl.value = String(n);
                        this.save();
                    }
                });
            });
    }
}
