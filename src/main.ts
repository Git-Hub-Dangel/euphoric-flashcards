import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, EuphoricSettings, CardSide, ReviewMode, WordSelection } from "src/settings";
import { EuphoricSettingsTab } from "src/settings/settings-tab";
import { ExplorerModal } from "src/ui/explorer/index";
import { HistogramStore, HistogramState } from "src/scheduling/histogram-store";

interface ExplorerState {
    mode: ReviewMode;
    reviewCardSide: CardSide;
    cramCardSide: CardSide;
    sentenceBuilderCardSide: CardSide;
    sentenceBuilderSelection: WordSelection;
}

interface PluginData {
    settings: EuphoricSettings;
    buryDate: string;
    buryList: string[];
    expandedDecks: string[];
    explorerState: ExplorerState | null;
    histogram: HistogramState;
}

const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    buryDate: "",
    buryList: [],
    expandedDecks: [],
    explorerState: null,
    histogram: { data: {}, builtAt: null },
};

export default class EuphoricFlashcardsPlugin extends Plugin {
    data: PluginData = DEFAULT_DATA;
    histogramStore!: HistogramStore;

    onload(): void {
        void (async (): Promise<void> => {
            await this.loadData_();

            this.histogramStore = new HistogramStore(this.data.histogram);

            this.addSettingTab(new EuphoricSettingsTab(this.app, this));

            this.addCommand({
                id: "open-explorer",
                name: "Review",
                callback: () => {
                    new ExplorerModal(this.app, this).open();
                },
            });

            // background build if the histogram is empty or older than a day.
            // failure is non-fatal — the algorithm falls through when the
            // histogram is empty.
            if (this.data.settings.loadBalance && this.histogramNeedsRebuild()) {
                this.histogramStore.rebuild(this.app.vault)
                    .then(() => this.saveData_())
                    .catch(err => console.error("EuphoricFlashcards: histogram build failed", err));
            }
        })();
    }

    private histogramNeedsRebuild(): boolean {
        if (this.histogramStore.isEmpty()) return true;
        const builtAt = this.histogramStore.getBuiltAt();
        if (builtAt === null) return true;
        const ageMs = Date.now() - new Date(builtAt).valueOf();
        const oneDayMs = 24 * 60 * 60 * 1000;
        return ageMs >= oneDayMs;
    }

    async onunload(): Promise<void> {
        await this.saveData_();
    }

    async loadData_(): Promise<void> {
        const saved = await this.loadData() as Partial<PluginData> | null;
        this.data = Object.assign({}, DEFAULT_DATA, saved ?? {});
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
        // fresh histogram object so the shared DEFAULT_DATA reference isn't mutated
        const h = this.data.histogram;
        this.data.histogram = { data: h?.data ?? {}, builtAt: h?.builtAt ?? null };
    }

    async saveData_(): Promise<void> {
        await this.saveData(this.data);
    }
}
