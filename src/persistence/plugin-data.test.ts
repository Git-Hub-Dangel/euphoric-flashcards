import { describe, expect, it } from "vitest";

import {
    DEFAULT_SETTINGS,
    REQUEST_RETENTION_MAX,
    REQUEST_RETENTION_MIN,
} from "src/settings";
import {
    CURRENT_DATA_VERSION,
    DEFAULT_DATA,
    migratePluginData,
} from "src/persistence/plugin-data";
import type { PluginData } from "src/persistence/plugin-data";

// A data.json as a 1.4.1 install would have written it: no dataVersion, plus
// every key the migration chain retires — `easyBonus` in v2, the three SM-2
// tuning knobs in v4. Shaped loosely because that is how it arrives off disk:
// the whole point of the migration is that the saved object does not match the
// current interface.
function legacyData(): Record<string, unknown> {
    return {
        settings: {
            ...DEFAULT_SETTINGS,
            easyBonus: 1.45,
            baseEase: 270,
            defaultIntervalChange: 1.2,
            lapsesIntervalChange: 0.01,
            maximumInterval: 180,
        },
        buryDate: "2026-09-20",
        buryList: ["deck/one", "deck/two"],
        expandedDecks: ["Spanish", "Spanish/verbs"],
        explorerState: null,
        histogram: { data: { "3": 2, "9": 1 }, builtAt: "2026-09-20T10:00:00.000Z" },
    };
}

describe("migratePluginData", () => {
    it("treats a missing dataVersion as v1 and stamps the current version", () => {
        const data = legacyData() as unknown as PluginData;
        expect(migratePluginData(data)).toBe(1);
        expect(data.dataVersion).toBe(CURRENT_DATA_VERSION);
    });

    it("deletes the retired top-level keys", () => {
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);
        const bag = data as unknown as Record<string, unknown>;
        expect("buryDate" in bag).toBe(false);
        expect("buryList" in bag).toBe(false);
    });

    it("deletes the retired settings keys", () => {
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);
        const settings = data.settings as unknown as Record<string, unknown>;
        expect("easyBonus" in settings).toBe(false);
    });

    // v3 -> v4. These three lost their last consumer when osr.ts was deleted;
    // Object.assign would otherwise copy them through from disk forever.
    it("deletes the three SM-2 tuning knobs", () => {
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);
        const settings = data.settings as unknown as Record<string, unknown>;
        expect("baseEase" in settings).toBe(false);
        expect("defaultIntervalChange" in settings).toBe(false);
        expect("lapsesIntervalChange" in settings).toBe(false);
    });

    it("deletes the SM-2 knobs even when migrating only the last step", () => {
        const data = legacyData() as unknown as PluginData;
        (data as unknown as Record<string, unknown>)["dataVersion"] = 3;
        expect(migratePluginData(data)).toBe(3);
        const settings = data.settings as unknown as Record<string, unknown>;
        expect("baseEase" in settings).toBe(false);
        // ...while a key an earlier step owns is left as it was found, because
        // that step did not run.
        expect("easyBonus" in settings).toBe(true);
    });

    // The exit criterion that matters most: a real install must not lose
    // anything it still uses.
    it("loses no live key or value", () => {
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);

        expect(data.settings.maximumInterval).toBe(180);
        expect(data.settings.loadBalance).toBe(DEFAULT_SETTINGS.loadBalance);
        expect(data.expandedDecks).toEqual(["Spanish", "Spanish/verbs"]);
        expect(data.explorerState).toBeNull();
        expect(data.histogram).toEqual({
            data: { "3": 2, "9": 1 },
            builtAt: "2026-09-20T10:00:00.000Z",
        });
    });

    // The histogram object identity must survive: main.ts hands this exact
    // object to HistogramStore, which mutates it in place so saves pick up
    // increments. A migration that replaced it would silently decouple them.
    it("keeps the histogram object identity", () => {
        const data = legacyData() as unknown as PluginData;
        const before = data.histogram;
        migratePluginData(data);
        expect(data.histogram).toBe(before);
    });

    it("is a no-op on already-current data and reports no migration", () => {
        const data: PluginData = {
            ...DEFAULT_DATA,
            dataVersion: CURRENT_DATA_VERSION,
            expandedDecks: ["kept"],
        };
        expect(migratePluginData(data)).toBeNull();
        expect(data.expandedDecks).toEqual(["kept"]);
        expect(data.dataVersion).toBe(CURRENT_DATA_VERSION);
    });

    it("is idempotent: a second run changes nothing", () => {
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);
        const snapshot = JSON.stringify(data);
        expect(migratePluginData(data)).toBeNull();
        expect(JSON.stringify(data)).toBe(snapshot);
    });

    // A downgrade (user rolls the plugin back, then forward again) must not run
    // steps written against an older shape.
    it("leaves data from a future version untouched", () => {
        const data = {
            ...legacyData(),
            dataVersion: CURRENT_DATA_VERSION + 5,
        } as unknown as PluginData;
        expect(migratePluginData(data)).toBeNull();
        const bag = data as unknown as Record<string, unknown>;
        expect(bag["buryDate"]).toBe("2026-09-20");
        expect(data.dataVersion).toBe(CURRENT_DATA_VERSION + 5);
    });

    // The v1->v2 step deletes a key out of `data.settings`. main.ts replaces
    // this.data.settings with a fresh Object.assign copy before migrating, so
    // the step never reaches the shared DEFAULT_SETTINGS literal. If that order
    // ever changes, a migration would strip the module-level defaults for the
    // whole process (C3, "nested mutable defaults").
    it("does not mutate the shared DEFAULT_SETTINGS literal", () => {
        const keysBefore = Object.keys(DEFAULT_SETTINGS).sort();
        const data = legacyData() as unknown as PluginData;
        migratePluginData(data);
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(keysBefore);
    });

    it("tolerates a missing settings object", () => {
        const data = { expandedDecks: [] } as unknown as PluginData;
        expect(() => migratePluginData(data)).not.toThrow();
        expect(data.dataVersion).toBe(CURRENT_DATA_VERSION);
    });
});

// ---------------------------------------------------------------------------
// v2 -> v3: seed the FSRS request_retention setting
// ---------------------------------------------------------------------------

describe("migratePluginData — requestRetention seeding", () => {
    function v2Data(requestRetention?: unknown): PluginData {
        const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
        delete settings["requestRetention"];
        if (arguments.length > 0) settings["requestRetention"] = requestRetention;
        return {
            dataVersion: 2,
            settings,
            expandedDecks: [],
            explorerState: null,
            histogram: { data: {}, builtAt: null },
        } as unknown as PluginData;
    }

    it("seeds the default when the key is absent", () => {
        const data = v2Data();
        expect(migratePluginData(data)).toBe(2);
        expect(data.settings.requestRetention).toBe(DEFAULT_SETTINGS.requestRetention);
    });

    it("preserves a valid stored value", () => {
        const data = v2Data(0.82);
        migratePluginData(data);
        expect(data.settings.requestRetention).toBe(0.82);
    });

    it.each([
        ["null", null],
        ["a string", "0.9"],
        ["NaN", NaN],
        ["Infinity", Infinity],
        ["below the slider range", 0.2],
        ["above the slider range", 1.5],
    ])("replaces an unusable value (%s) with the default", (_label, stored) => {
        const data = v2Data(stored);
        migratePluginData(data);
        expect(data.settings.requestRetention).toBe(DEFAULT_SETTINGS.requestRetention);
    });

    it("accepts the exact slider bounds", () => {
        for (const bound of [REQUEST_RETENTION_MIN, REQUEST_RETENTION_MAX]) {
            const data = v2Data(bound);
            migratePluginData(data);
            expect(data.settings.requestRetention).toBe(bound);
        }
    });

    // A 1.4.1 install has to cross both steps in one load.
    it("carries a v1 install through both steps in order", () => {
        const data = legacyData() as unknown as Record<string, unknown>;
        delete (data["settings"] as Record<string, unknown>)["requestRetention"];
        const typed = data as unknown as PluginData;
        expect(migratePluginData(typed)).toBe(1);
        expect(typed.dataVersion).toBe(CURRENT_DATA_VERSION);
        // v1->v2 deletions happened...
        expect("buryDate" in data).toBe(false);
        expect("easyBonus" in (data["settings"] as object)).toBe(false);
        // ...and v2->v3 seeding happened.
        expect(typed.settings.requestRetention).toBe(DEFAULT_SETTINGS.requestRetention);
    });

    it("tolerates a missing settings object at v2", () => {
        const data = { expandedDecks: [] } as unknown as PluginData;
        expect(() => migratePluginData(data)).not.toThrow();
        expect(data.dataVersion).toBe(CURRENT_DATA_VERSION);
    });
});

describe("DEFAULT_DATA", () => {
    it("declares the current data version so a fresh install never migrates", () => {
        expect(DEFAULT_DATA.dataVersion).toBe(CURRENT_DATA_VERSION);
    });

    it("carries no retired key", () => {
        const bag = DEFAULT_DATA as unknown as Record<string, unknown>;
        expect("buryDate" in bag).toBe(false);
        expect("buryList" in bag).toBe(false);
        expect("easyBonus" in DEFAULT_SETTINGS).toBe(false);
    });
});
