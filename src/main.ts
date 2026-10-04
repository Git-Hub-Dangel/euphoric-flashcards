import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS } from "src/settings";
import { EuphoricSettingsTab } from "src/settings/settings-tab";
import { ExplorerModal } from "src/ui/explorer/index";
import { HistogramStore } from "src/scheduling/histogram-store";
import { applyDayBoundary } from "src/scheduling/dates";
import { DEFAULT_DATA, hydratePluginData, migratePluginData } from "src/persistence/plugin-data";
import type { PluginData } from "src/persistence/plugin-data";

export type { ExplorerState, PluginData } from "src/persistence/plugin-data";

export default class EuphoricFlashcardsPlugin extends Plugin {
    data: PluginData = DEFAULT_DATA;
    histogramStore!: HistogramStore;
    private unloaded = false;

    // Awaited rather than fire and forget. A detached load leaves a window in
    // which onunload can run while this.data is still DEFAULT_DATA, which would
    // write the defaults over a real data.json.
    async onload(): Promise<void> {
        await this.loadData_();

        // Must run before HistogramStore captures this.data.histogram by
        // reference, and before any consumer reads a migrated key.
        const migratedFrom = migratePluginData(this.data);
        if (migratedFrom !== null) {
            await this.saveData_();
        }

        this.histogramStore = new HistogramStore(this.data.histogram);

        // Must run before anything reads globalDateProvider.today (P6.1).
        // The histogram rebuild below is the first such reader, and every
        // due-date comparison in the plugin is downstream of it.
        applyDayBoundary(this.data.settings.startOfDay);

        this.addSettingTab(new EuphoricSettingsTab(this.app, this));

        this.addCommand({
            id: "open-explorer",
            name: "Review",
            callback: () => {
                new ExplorerModal(this.app, this).open();
            },
        });

        // Background build if the histogram is empty or older than a day.
        // Failure is not fatal (the algorithm falls through when the histogram
        // is empty). The unloaded guard stops a late finish writing data back
        // after the plugin has already been torn down.
        if (this.data.settings.loadBalance && this.histogramNeedsRebuild()) {
            this.histogramStore.rebuild(this.app.vault)
                .then(() => {
                    if (this.unloaded) return;
                    return this.saveData_();
                })
                .catch(err => console.error("EuphoricFlashcards: histogram build failed", err));
        }
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
        this.unloaded = true;
        void this.saveData_();
    }

    async loadData_(): Promise<void> {
        const saved = await this.loadData() as Partial<PluginData> | null;
        // Every hydration rule lives in hydratePluginData so it stays testable
        // without the obsidian import. See the notes there before changing it.
        this.data = hydratePluginData(saved);
    }

    async saveData_(): Promise<void> {
        await this.saveData(this.data);
    }
}
