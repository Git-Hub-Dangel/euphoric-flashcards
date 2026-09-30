import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS } from "src/settings";
import { EuphoricSettingsTab } from "src/settings/settings-tab";
import { ExplorerModal } from "src/ui/explorer/index";
import { HistogramStore } from "src/scheduling/histogram-store";
import { CURRENT_DATA_VERSION, DEFAULT_DATA, migratePluginData } from "src/persistence/plugin-data";
import type { PluginData } from "src/persistence/plugin-data";

export type { ExplorerState, PluginData } from "src/persistence/plugin-data";

export default class EuphoricFlashcardsPlugin extends Plugin {
    data: PluginData = DEFAULT_DATA;
    histogramStore!: HistogramStore;

    onload(): void {
        void (async (): Promise<void> => {
            await this.loadData_();

            // Must run before HistogramStore captures this.data.histogram by
            // reference, and before any consumer reads a migrated key.
            const migratedFrom = migratePluginData(this.data);
            if (migratedFrom !== null) {
                console.log(
                    `EuphoricFlashcards: migrated plugin data v${migratedFrom} -> v${CURRENT_DATA_VERSION}`,
                );
                await this.saveData_();
            }

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

    onunload(): void {
        void this.saveData_();
    }

    async loadData_(): Promise<void> {
        const saved = await this.loadData() as Partial<PluginData> | null;
        this.data = Object.assign({}, DEFAULT_DATA, saved ?? {});
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
        // Installs from 1.4.1 and earlier predate dataVersion. The DEFAULT_DATA
        // spread above would otherwise hand them the current version and the
        // migration runner would skip them. A genuinely fresh install (saved ===
        // null) is already current and must not be migrated.
        if (saved !== null && typeof saved.dataVersion !== "number") {
            this.data.dataVersion = 1;
        }
        // fresh histogram object so the shared DEFAULT_DATA reference isn't mutated
        const h = this.data.histogram;
        this.data.histogram = { data: h?.data ?? {}, builtAt: h?.builtAt ?? null };
    }

    async saveData_(): Promise<void> {
        await this.saveData(this.data);
    }
}
