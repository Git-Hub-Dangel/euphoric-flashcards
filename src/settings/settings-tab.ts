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
        const builtAtStr = builtAt ? new Date(builtAt).toLocaleString() : "never. A rebuild is recommended";

        return [
            // Decks
            {
                type: "group",
                heading: "Decks",
                items: [
                    {
                        name: "Root deck tags",
                        desc: "One tag per line. Card definitions in notes located under the defined tags are included in the deck. Declaring a tag will include all of its subdecks.\n\nExample: Defining the base tag #español will include all tags with a path-like name #español/... For example #español/palabras-clave, #español/verbos, and #español/2026/09.",
                        control: {
                            type: "textarea",
                            key: "rootDeckTagsStr",
                            placeholder: "#español\n#polski\n#slovenčina",
                            rows: 4,
                        },
                    },
                ],
            },

            // Card Types
            {
                type: "list",
                heading: "Card types",
                desc: "Keys are used in the '=' operator card definition syntax: =key",
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
                        desc: "Display a preview of the resulting interval on buttons during review. e.g. '4d', '1d', '3.5m'",
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
                        desc: "Number of words chosen per sentence.",
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
                        desc: "Optimised: assures that the selection contains an even mix of older and newer cards.\n\nRandom: arbitrary random draw",
                        control: {
                            type: "dropdown",
                            key: "sentenceBuilderSelection",
                            options: { Optimised: "Optimised", Random: "Random" },
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
                            cur.defaultIntervalChange = d.defaultIntervalChange;
                            cur.lapsesIntervalChange = d.lapsesIntervalChange;
                            cur.maximumInterval = d.maximumInterval;
                            cur.loadBalance = d.loadBalance;
                            cur.startOfDay = d.startOfDay;
                            void this.plugin.saveData_();
                            this.update();
                        },
                    },
                    {
                        name: "Base ease",
                        desc: "Default ease factor for new cards.",
                        control: { type: "slider", key: "baseEase", min: 100, max: 400, step: 10 },
                    },
                    {
                        name: "Good bonus",
                        desc: "Interval multiplier applied to cards reviewed as 'Good'",
                        control: { type: "slider", key: "easyBonus", min: 1.0, max: 2.0, step: 0.05 },
                    },
                    {
                        name: "Okay interval change",
                        desc: "Interval multiplier applied to cards reviewed as 'Okay'",
                        control: { type: "slider", key: "defaultIntervalChange", min: 1.0, max: 1.8, step: 0.05 },
                    },
                    {
                        name: "Lapse interval change",
                        desc: "Interval multiplier applied to cards reviewed as 'Okay' after they were reshuffled into the session due to being toggled as 'Again'. The default value resets the card's progress completely.",
                        control: { type: "slider", key: "lapsesIntervalChange", min: 0.01, max: 1.0, step: 0.01 },
                    },
                    {
                        name: "Maximum interval",
                        desc: "Cards will not be scheduled beyond this many days.",
                        control: { type: "slider", key: "maximumInterval", min: 7, max: 36525, step: 1 },
                    },
                    {
                        name: "Start of day",
                        desc: "Cards whose due date is today only become available after this time. Set to e.g. 02:00:00 if you study past midnight and want yesterday's cards to stay due until then. Format: HH:MM:SS.",
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
                        desc: "Uses a histogram to spread cards across nearby days to avoid review spikes.",
                        control: { type: "toggle", key: "loadBalance" },
                    },
                    {
                        name: "Rebuild histogram",
                        desc: `Rescans every note in the vault. Takes a few seconds.\n\nLast full rebuild: ${builtAtStr}.`,
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
