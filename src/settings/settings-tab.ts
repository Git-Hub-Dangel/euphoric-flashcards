import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem, TFile } from "obsidian";
import type EuphoricFlashcardsPlugin from "src/main";
import type { ConstructionConstraintCollection, TypeConfig } from "src/settings/index";
import {
    DEFAULT_SETTINGS,
    REQUEST_RETENTION_MAX,
    REQUEST_RETENTION_MIN,
    REQUEST_RETENTION_STEP,
} from "src/settings/index";
import { describeReport, runConversion } from "src/migration/convert-vault";
import { applyDayBoundary } from "src/scheduling/dates";

export class EuphoricSettingsTab extends PluginSettingTab {
    private readonly plugin: EuphoricFlashcardsPlugin;
    // Reentrancy guard for the one-time converter. It rewrites notes across the
    // whole vault, so two overlapping runs must not be possible from one button.
    private converting = false;

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
        } else if (key === "startOfDay" || key === "depositInboxPath") {
            s[key] = typeof value === "string" ? value.trim() : value;
        } else {
            s[key] = value;
        }
        await this.plugin.saveData_();
        // The day boundary lives on the date provider, not in settings, so the
        // provider has to be told. Doing it here rather than on modal open means
        // a session already in progress picks the new boundary up too.
        if (key === "startOfDay") applyDayBoundary(this.plugin.data.settings.startOfDay);
        // The deposit inbox and notification rows are disabled while the
        // feature is off, so their disabled state has to be re-evaluated.
        if (key === "enableSentenceDeposit") this.update();
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const s = this.plugin.data.settings;

        const builtAt = this.plugin.histogramStore.getBuiltAt();
        const builtAtStr = builtAt ? new Date(builtAt).toLocaleString() : "never. A rebuild is recommended";

        return [
            // Info
            {
                type: "group",
                heading: "",
                items: [
                    {
                        name: "",
                        desc: "Access the official introductory follow-along guide to Euphoric Flashcards. There, you'll also find links to the repo and docs. ",
                        render: (setting: Setting): void => {
                            setting.addButton(btn => {
                                btn.setButtonText("Open Guide")
                                    .onClick(() => { window.open("https://www.jrdk.de/projects/euphoric-flashcards", "_blank"); });
                            });
                        },
                    },
                ],
            },

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
                heading: "Card Types",
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

            // Learn
            {
                type: "group",
                heading: "Learn",
                items: [
                    {
                        name: "Groups per session",
                        desc: "The default number of card groups appearing per Learn session. Card groups are sets of 4-8 flashcards that you first review, then train sentence forming in Conjure Sentence exercises with. The current group's amount of cards and the total amount of groups in the active session is displayed in the upper right durring Learn mode.",
                        control: {
                            type: "slider",
                            key: "learnGroupsPerSession",
                            min: 1,
                            max: 5,
                            step: 1,
                        },
                    },
                    {
                        name: "Card side for conjuring sentences",
                        desc: "Decide what side of the cards is initially shown to you in sentence forming exercises during Learn mode. I recommend to only use the side that contains the word's translation into your native / proficient language. (e.g. If you use the syntax 'word - translation', then set this setting to 'Back') This way we simulate the real-life situation, in which you'll first need to retrieve the word in your target language, then apply it.",
                        control: {
                            type: "dropdown",
                            key: "learnSentenceSide",
                            options: { Default: "Default", Front: "Front", Back: "Back" },
                        },
                    },
                ],
            },

            // Conjure Sentences
            {
                type: "group",
                heading: "Conjure Sentences",
                items: [
                    {
                        name: "Word count",
                        desc: "Number of words chosen per sentence.",
                        control: {
                            type: "slider",
                            key: "conjureSentencesWordCount",
                            min: 1,
                            max: 6,
                            step: 1,
                        },
                    },
                    {
                        name: "Word selection method",
                        desc: "Optimised: assures that the selection contains an even mix of older and newer cards.\n\nRandom: arbitrary random draw",
                        control: {
                            type: "dropdown",
                            key: "conjureSentencesSelection",
                            options: { Optimised: "Optimised", Random: "Random" },
                        },
                    },
                    {
                        name: "Enable sentence deposit",
                        desc: "When on, sentence exercises show an input below the word list. Pressing 'Good' appends what you typed to the deposit inbox note as a new line. Works in Conjure Sentences and in the sentence steps of Learn mode.",
                        control: {
                            type: "toggle",
                            key: "enableSentenceDeposit",
                        },
                    },
                    {
                        name: "Deposit inbox",
                        desc: "The note your sentences are appended to. Sentences are added at the end of the file, one per line.",
                        control: {
                            type: "file",
                            key: "depositInboxPath",
                            placeholder: "Inbox/Sentences.md",
                            filter: (file: TFile): boolean => file.extension === "md",
                            disabled: (): boolean => !this.plugin.data.settings.enableSentenceDeposit,
                        },
                    },
                    {
                        name: "Show deposit notification",
                        desc: "Show a confirmation banner after a sentence is appended. Failures are always reported regardless of this setting.",
                        control: {
                            type: "toggle",
                            key: "showDepositNotification",
                            disabled: (): boolean => !this.plugin.data.settings.enableSentenceDeposit,
                        },
                    },
                    {
                        name: "Enable construction constraints",
                        desc: "When on, each Conjure Sentences session shows a random construction constraint at the top, drawn from collections bound to the current source deck.",
                        control: {
                            type: "toggle",
                            key: "enableConstructionConstraints",
                        },
                    },
                ],
            },

            // Construction Constraints (sits directly under the Conjure
            // Sentences group so it visually attaches to the toggle above).
            {
                type: "list",
                heading: "Construction Constraints",
                desc: "Each collection defines constraint labels (left) and the source-deck tags they apply to (right). Entries are separated by newlines.",
                emptyState: "No construction constraint collections yet. Construction constraints are additional notices that instruct you to use a particular tense, case or syntax when conjuring sentences.",
                items: s.constructionConstraints.map((_cc, i) => ({
                    name: "",
                    render: (setting: Setting): void => {
                        const cc = this.plugin.data.settings.constructionConstraints[i] as ConstructionConstraintCollection;
                        setting
                            .addTextArea(ta => {
                                ta.setPlaceholder("constraints e.g.\nPresent\nPreterite\nImperfect\nFuture\nConditional\nSubjunctive");
                                ta.setValue(cc.labels.join("\n"));
                                ta.inputEl.addClass("ef-cc-labels-input");
                                ta.inputEl.rows = 4;
                                ta.onChange(v => {
                                    (this.plugin.data.settings.constructionConstraints[i] as ConstructionConstraintCollection).labels =
                                        v.split("\n").map(x => x.trim()).filter(x => x.length > 0);
                                    void this.plugin.saveData_();
                                });
                            })
                            .addTextArea(ta => {
                                ta.setPlaceholder("deck tags to apply these constraints to e.g.\n #español");
                                ta.setValue(cc.deckTags.join("\n"));
                                ta.inputEl.addClass("ef-cc-tags-input");
                                ta.inputEl.rows = 4;
                                ta.onChange(v => {
                                    (this.plugin.data.settings.constructionConstraints[i] as ConstructionConstraintCollection).deckTags =
                                        v.split("\n").map(x => x.trim().replace(/^#/, "")).filter(x => x.length > 0);
                                    void this.plugin.saveData_();
                                });
                            });
                        setting.settingEl.addClass("ef-cc-row");
                    },
                })),
                onDelete: (i: number): void => {
                    this.plugin.data.settings.constructionConstraints.splice(i, 1);
                    void this.plugin.saveData_();
                    this.update();
                },
                addItem: {
                    name: "Add collection",
                    action: (): void => {
                        this.plugin.data.settings.constructionConstraints.push({ labels: [], deckTags: [] });
                        void this.plugin.saveData_();
                        this.update();
                    },
                },
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
                            cur.requestRetention = d.requestRetention;
                            cur.maximumInterval = d.maximumInterval;
                            cur.loadBalance = d.loadBalance;
                            cur.startOfDay = d.startOfDay;
                            applyDayBoundary(cur.startOfDay);
                            void this.plugin.saveData_();
                            this.update();
                        },
                    },
                    {
                        name: "Reset FSRS parameters to defaults",
                        desc: "Restores the target retention and maximum interval to their shipped values. The FSRS model weights themselves are always the algorithm's published defaults — they are not stored, not editable, and not affected by this button.",
                        action: (): void => {
                            const d = DEFAULT_SETTINGS;
                            const cur = this.plugin.data.settings;
                            cur.requestRetention = d.requestRetention;
                            cur.maximumInterval = d.maximumInterval;
                            void this.plugin.saveData_();
                            this.update();
                        },
                    },
                    {
                        name: "Target retention",
                        desc: "The probability of recall FSRS aims for at the moment a card comes due. 0.90 means you should remember about 90% of cards when they appear. Lower values mean longer intervals and less reviewing, at the cost of more forgetting.",
                        control: {
                            type: "slider",
                            key: "requestRetention",
                            min: REQUEST_RETENTION_MIN,
                            max: REQUEST_RETENTION_MAX,
                            step: REQUEST_RETENTION_STEP,
                        },
                    },
                    {
                        name: "Maximum interval",
                        // P3.10: the old wording ("Cards will not be scheduled
                        // beyond this many days") was true under SM-2 and became
                        // false the moment FSRS took over. maximum_interval is a
                        // soft ceiling: FSRS clamps each grade to it and then
                        // enforces again < hard < good < easy by bumping each
                        // past the previous, so saturated intervals land a day or
                        // two above the limit. That ordering is what the interval
                        // previews depend on, so it is not clamped away.
                        desc: "The longest interval FSRS will aim for, in days. Once a card reaches this ceiling the better answers may still land a day or two beyond it, so that the response buttons stay in order.",
                        control: { type: "slider", key: "maximumInterval", min: 7, max: 36525, step: 1 },
                    },
                    {
                        name: "Start of day",
                        desc: "Cards whose due date is today only become available after this time. Set to e.g. 02:00:00 if you study past midnight and want yesterday's cards to stay due until then. Format: HH:MM:SS, and anything else falls back to midnight.",
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

            // Appearance
            {
                type: "group",
                heading: "Appearance",
                items: [
                    {
                        name: "Show interval on buttons",
                        desc: "Display a preview of the resulting interval on buttons during review. (e.g. 4d, 15d, 3.5m)",
                        control: {
                            type: "toggle",
                            key: "showIntervalOnButtons",
                        },
                    },
                    {
                        name: "Show keybindings on desktop",
                        desc: "Show the keyboard shortcut number on each review button (1, 2, 3). Keybindings remain functional regardless of visibility. Always hidden on mobile device.",
                        control: {
                            type: "toggle",
                            key: "showKeybindingsOnDesktop",
                        },
                    },
                    {
                        name: "Animation duration",
                        desc: "Duration in milliseconds for subtle animations throughout Euphoric Flashcards' features. Set to 0 to disable all animations. Respects reduced motion.",
                        control: { type: "slider", key: "animationDurationMs", min: 0, max: 500, step: 10 },
                    },
                ],
            },

            // Convert SM-2 cards (FSRS plan P5.3). Last group in the tab.
            {
                type: "group",
                heading: "Convert SM-2 cards",
                items: [
                    {
                        name: "Convert vault to FSRS",
                        desc: "Rewrites every pre-FSRS card in the vault to the FSRS format. Cards already in the FSRS format are left alone, so running this twice changes nothing.",
                        action: (): void => { void this.runConverter(); },
                    },
                ],
            },
        ];
    }

    // The one-time SM-2 to FSRS conversion (plan §B5).
    //
    // A dry run goes first, so a vault with nothing to convert reports that and
    // writes nothing. It is not a confirmation step: this button converts on the
    // first click, by design for now.
    //
    // The histogram is rebuilt afterwards (§P5.6) because every converted card
    // has just gained a due date the old scan could not read.
    private async runConverter(): Promise<void> {
        if (this.converting) return;
        this.converting = true;
        try {
            const dryRun = await runConversion(this.app.vault, { write: false });
            if (dryRun.commentsConverted === 0) {
                new Notice(describeReport(dryRun, true));
                return;
            }

            const report = await runConversion(this.app.vault, { write: true });
            await this.plugin.histogramStore.rebuild(this.app.vault);
            await this.plugin.saveData_();
            new Notice(describeReport(report, false));
        } catch (err) {
            console.error("EuphoricFlashcards: conversion failed", err);
            new Notice("Conversion failed. See the developer console.");
        } finally {
            this.converting = false;
            this.update();
        }
    }
}
