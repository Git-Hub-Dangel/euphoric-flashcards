import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS } from "src/settings";
import { EuphoricSettingsTab } from "src/settings/settings-tab";
import { ExplorerModal } from "src/ui/explorer/index";
import { HistogramStore } from "src/scheduling/histogram-store";
import { applyDayBoundary } from "src/scheduling/dates";
import { runConversion } from "src/migration/convert-vault";
import { DEFAULT_DATA, hydratePluginData, migratePluginData } from "src/persistence/plugin-data";
import type { PluginData } from "src/persistence/plugin-data";

export type { ExplorerState, PluginData } from "src/persistence/plugin-data";

export default class EuphoricFlashcardsPlugin extends Plugin {
    data: PluginData = DEFAULT_DATA;
    histogramStore!: HistogramStore;
    private unloaded = false;
    // Shown at most once per load, so reopening the Explorer does not nag. A
    // fresh Obsidian session reminds the user again, which is the right cadence
    // for a migration they have not done yet.
    private legacyNoticeShown = false;

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
                this.nudgeLegacyCards();
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

    // Warn once if the vault still holds pre-FSRS cards.
    //
    // Fired from the Review command rather than from onload, because this is the
    // moment it matters: an unconverted card parses to a null schedule, so it is
    // served as new, and answering it rewrites the comment and discards the SM-2
    // interval and ease for good.
    //
    // The converter's own dry run does the detection. It uses cachedRead and
    // writes nothing, and it is already covered by tests, so there is no second
    // legacy detector to keep in step with the first. Fire and forget, so the
    // Explorer opens without waiting on a vault scan.
    private nudgeLegacyCards(): void {
        if (this.legacyNoticeShown) return;
        const rootTags = this.data.settings.rootDeckTags;
        if (rootTags.length === 0) return;

        runConversion(this.app.vault, { write: false, rootTags })
            .then(report => {
                if (this.unloaded || report.commentsConverted === 0) return;
                this.legacyNoticeShown = true;
                new Notice(
                    `${report.commentsConverted} cards still use the old SM-2 scheduling comment format.`
                    + " Convert them now in the Euphoric Flashcards settings under the 'Migrate Flashcards' section to the new format to transfer their "
                    + "schedules. If you instead continue to review your flashcards without converting, all of your card's scheduling will be lost permanently.",
                    30000,
                );
            })
            .catch(err => console.error("EuphoricFlashcards: legacy card scan failed", err));
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
