import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, EuphoricSettings, CardSide, ReviewMode, WordSelection } from "src/settings";
import { EuphoricSettingsTab } from "src/settings/settings-tab";
import { ExplorerModal } from "src/ui/explorer/index";

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
}

const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    buryDate: "",
    buryList: [],
    expandedDecks: [],
    explorerState: null,
};

export default class EuphoricFlashcardsPlugin extends Plugin {
    data: PluginData = DEFAULT_DATA;

    async onload(): Promise<void> {
        await this.loadData_();

        this.addSettingTab(new EuphoricSettingsTab(this.app, this));

        this.addCommand({
            id: "open-explorer",
            name: "Review",
            callback: () => {
                new ExplorerModal(this.app, this).open();
            },
        });
    }

    async onunload(): Promise<void> {
        await this.saveData_();
    }

    async loadData_(): Promise<void> {
        const saved = await this.loadData() as Partial<PluginData> | null;
        this.data = Object.assign({}, DEFAULT_DATA, saved ?? {});
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
    }

    async saveData_(): Promise<void> {
        await this.saveData(this.data);
    }
}
