import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import type { TypeConfig } from "src/settings/index";
import { DEFAULT_SETTINGS } from "src/settings/index";

export class EuphoricSettingsTab extends PluginSettingTab {
    private readonly plugin: EuphoricFlashcardsPlugin;

    constructor(app: App, plugin: EuphoricFlashcardsPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    getControlValue(key: string): unknown {
        const s = this.plugin.data.settings;
        if (key === "rootDeckTagsStr") return s.rootDeckTags.join("\n");
        return (s as unknown as Record<string, unknown>)[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        const s = this.plugin.data.settings as unknown as Record<string, unknown>;
        if (key === "rootDeckTagsStr") {
            const raw = typeof value === "string" ? value : String(value ?? "");
            this.plugin.data.settings.rootDeckTags = raw
                .split(/[\n,]+/)
                .map(t => t.trim())
                .filter(t => t.length > 0);
        } else if (key === "startOfDay") {
            s[key] = typeof value === "string" ? value.trim() : value;
        } else {
            s[key] = value;
        }
        await this.plugin.saveData_();
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const s = this.plugin.data.settings;

        const builtAt = this.plugin.histogramStore.getBuiltAt();
        const builtAtStr = builtAt ? new Date(builtAt).toLocaleString() : "never — rebuild recommended";

        return [
            // Decks
            {
                type: "group",
                heading: "Decks",
                items: [
                    {
                        name: "Root deck tags",
                        desc: "One tag per line. (e.g. #español) Card definitions in notes located under these tags are included. Specifying a tag will include all of its subdecks. (e.g. defining #español will include all words defined under tag patterns #español, #español/...,  #español/.../..., etc. (e.g. #español/palabras-clave,  #español/verbos)",
                        control: {
                            type: "textarea",
                            key: "rootDeckTagsStr",
                            placeholder: "#español\n#deutsch",
                            rows: 4,
                        },
                    },
                ],
            },

            // Card Types
            {
                type: "list",
                heading: "Card types",
                desc: "Keys are used in card syntax (e.g. =n for noun). Define colors to differentiate types visually",
                emptyState: "No card types yet.",
                items: s.cardTypes.map((_tc, i) => ({
                    name: "",
                    render: (setting: Setting): void => {
                        const tc = this.plugin.data.settings.cardTypes[i] as TypeConfig;
                        setting
                            .addText(text => {
                                text.setPlaceholder("key");
                                text.setValue(tc.key);
                                text.inputEl.addClass("ef-ct-key-input");
                                text.onChange(v => {
                                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).key = v.trim();
                                    void this.plugin.saveData_();
                                });
                            })
                            .addText(text => {
                                text.setPlaceholder("label");
                                text.setValue(tc.label);
                                text.inputEl.addClass("ef-ct-label-input");
                                text.onChange(v => {
                                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).label = v;
                                    void this.plugin.saveData_();
                                });
                            })
                            .addColorPicker(picker => {
                                picker.setValue(tc.color);
                                picker.onChange(v => {
                                    (this.plugin.data.settings.cardTypes[i] as TypeConfig).color = v;
                                    void this.plugin.saveData_();
                                });
                            });
                        setting.settingEl.addClass("ef-ct-row");
                    },
                })),
                onDelete: (i: number): void => {
                    this.plugin.data.settings.cardTypes.splice(i, 1);
                    void this.plugin.saveData_();
                    this.update();
                },
                addItem: {
                    name: "Add type",
                    action: (): void => {
                        this.plugin.data.settings.cardTypes.push({ key: "", label: "", color: "#888888" });
                        void this.plugin.saveData_();
                        this.update();
                    },
                },
            },

            // Review
            {
                type: "group",
                heading: "Review",
                items: [
                    {
                        name: "Show interval on buttons",
                        desc: "Display the resulting interval (e.g. 4d) on Okay/Good buttons during review.",
                        control: {
                            type: "toggle",
                            key: "showIntervalOnButtons",
                        },
                    },
                ],
            },

            // Sentence Builder
            {
                type: "group",
                heading: "Sentence Builder",
                items: [
                    {
                        name: "Word count",
                        desc: "Number of words shown per sentence.",
                        control: {
                            type: "slider",
                            key: "sentenceBuilderWordCount",
                            min: 1,
                            max: 17,
                            step: 1,
                        },
                    },
                    {
                        name: "Word selection method",
                        desc: "Random: random draw from selected deck. Optimised: assures, that the selection contains an even mix of older and newer cards.",
                        control: {
                            type: "dropdown",
                            key: "sentenceBuilderSelection",
                            options: { Random: "Random", Optimised: "Optimised" },
                        },
                    },
                ],
            },

            // Scheduling
            {
                type: "group",
                heading: "Scheduling",
                items: [
                    {
                        name: "Restore Default Settings",
                        action: (): void => {
                            const d = DEFAULT_SETTINGS;
                            const cur = this.plugin.data.settings;
                            cur.baseEase = d.baseEase;
                            cur.easyBonus = d.easyBonus;
                            cur.lapsesIntervalChange = d.lapsesIntervalChange;
                            cur.maximumInterval = d.maximumInterval;
                            cur.maxLinkFactor = d.maxLinkFactor;
                            cur.loadBalance = d.loadBalance;
                            cur.startOfDay = d.startOfDay;
                            void this.plugin.saveData_();
                            this.update();
                        },
                    },
                    {
                        name: "Base ease (%)",
                        desc: "Starting ease factor for new cards.",
                        control: { type: "slider", key: "baseEase", min: 130, max: 400, step: 10 },
                    },
                    {
                        name: "Easy bonus",
                        desc: "Multiplier applied to interval on an Easy response.",
                        control: { type: "slider", key: "easyBonus", min: 1.0, max: 2.0, step: 0.05 },
                    },
                    {
                        name: "Lapse interval change",
                        desc: "Interval multiplier after a lapse (Again).",
                        control: { type: "slider", key: "lapsesIntervalChange", min: 0.01, max: 1.0, step: 0.01 },
                    },
                    {
                        name: "Maximum interval (days)",
                        desc: "Cards will not be scheduled beyond this many days.",
                        control: { type: "slider", key: "maximumInterval", min: 7, max: 36525, step: 1 },
                    },
                    {
                        name: "Max link factor",
                        desc: "Weight given to the linked note's ease during scheduling.",
                        control: { type: "slider", key: "maxLinkFactor", min: 0, max: 1.0, step: 0.05 },
                    },
                    {
                        name: "Start of day",
                        desc: "Cards whose due date is today only become available after this time. Set to e.g. 04:00:00 if you study past midnight and want yesterday's cards to stay due until then (HH:MM:SS).",
                        control: {
                            type: "text",
                            key: "startOfDay",
                            placeholder: "00:00:00",
                        },
                    },
                ],
            },

            // Load Balancing
            {
                type: "group",
                heading: "Load Balancing",
                desc: "A count of how many cards are due on each future day. Load balance uses this to nudge scheduled cards toward less-crowded days. Updates automatically as you review and does a full rebuild about once a day.",
                items: [
                    {
                        name: "Enable Load Balancing",
                        desc: "Spread cards across nearby days to avoid review spikes.",
                        control: { type: "toggle", key: "loadBalance" },
                    },
                    {
                        name: "Rebuild histogram",
                        desc: `Rescans every note in the vault. Takes a few seconds. Last full rebuild: ${builtAtStr}.`,
                        action: (): void => {
                            void (async () => {
                                try {
                                    await this.plugin.histogramStore.rebuild(this.app.vault);
                                    await this.plugin.saveData_();
                                } catch (err) {
                                    console.error("EuphoricFlashcards: histogram rebuild failed", err);
                                } finally {
                                    this.update();
                                }
                            })();
                        },
                    },
                ],
            },
        ];
    }
}
