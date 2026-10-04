import { DEFAULT_SETTINGS, REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "src/settings";
import type { CardSide, EuphoricSettings, ReviewMode, WordSelection } from "src/settings";
import type { HistogramState } from "src/scheduling/histogram-store";

// Bump this whenever a PluginData key is added with a non-trivial default, or
// removed. Every removal needs a step in STEPS: `Object.assign` in loadData_
// copies unknown saved keys through verbatim, so a key deleted from the
// interface survives in data.json forever unless a migration deletes it.
export const CURRENT_DATA_VERSION = 4;

export interface ExplorerState {
    mode: ReviewMode;
    reviewCardSide: CardSide;
    cramCardSide: CardSide;
    conjureSentencesCardSide: CardSide;
    conjureSentencesSelection: WordSelection;
}

export interface PluginData {
    dataVersion: number;
    settings: EuphoricSettings;
    expandedDecks: string[];
    explorerState: ExplorerState | null;
    histogram: HistogramState;
}

export const DEFAULT_DATA: PluginData = {
    dataVersion: CURRENT_DATA_VERSION,
    settings: DEFAULT_SETTINGS,
    expandedDecks: [],
    explorerState: null,
    histogram: { data: {}, builtAt: null },
};

// Migrations see the loaded object as a bag of unknown keys, because that is
// what it is: every field a past version ever wrote may still be present.
type MutableData = Record<string, unknown>;

function deleteKeys(bag: MutableData | undefined, keys: readonly string[]): void {
    if (bag === undefined || bag === null) return;
    for (const key of keys) delete bag[key];
}

// v1 -> v2: retire the SM-2 keys that Phase 1 removed from the interfaces.
// `easyBonus` lived in settings; `buryDate` / `buryList` were top-level and had
// no readers at all.
function stepV1ToV2(data: MutableData): void {
    deleteKeys(data, ["buryDate", "buryList"]);
    deleteKeys(data["settings"] as MutableData | undefined, ["easyBonus"]);
}

// v2 -> v3: seed the FSRS `requestRetention` setting.
//
// loadData_'s `Object.assign({}, DEFAULT_SETTINGS, saved.settings)` already
// supplies the default when the key is simply absent, so this step exists for
// the case that spread cannot fix: a key that is *present but unusable* — null,
// a string, NaN, or a number a hand-edited data.json put outside the slider's
// range. Left alone, such a value reaches generatorParameters and would skew or
// throw inside the scheduler at review time.
function stepV2ToV3(data: MutableData): void {
    const settings = data["settings"] as MutableData | undefined;
    if (settings === undefined || settings === null) return;
    const stored = settings["requestRetention"];
    const usable =
        typeof stored === "number" &&
        Number.isFinite(stored) &&
        stored >= REQUEST_RETENTION_MIN &&
        stored <= REQUEST_RETENTION_MAX;
    if (!usable) settings["requestRetention"] = DEFAULT_SETTINGS.requestRetention;
}

// v3 -> v4: retire the last three SM-2 tuning knobs. All three lost their only
// consumer when Phase 3 deleted osr.ts — `baseEase` seeded a new card's ease,
// `defaultIntervalChange` scaled an Okay, and `lapsesIntervalChange` collapsed a
// lapsed card's interval. FSRS derives all three from stability and difficulty,
// and B2 explicitly replaces the third with FSRS's own lapse handling. Their sliders
// went with them; without this step they would sit in data.json forever.
function stepV3ToV4(data: MutableData): void {
    deleteKeys(data["settings"] as MutableData | undefined, [
        "baseEase",
        "defaultIntervalChange",
        "lapsesIntervalChange",
    ]);
}

const STEPS: Record<number, (data: MutableData) => void> = {
    1: stepV1ToV2,
    2: stepV2ToV3,
    3: stepV3ToV4,
};

// Runs every step between the saved version and CURRENT_DATA_VERSION, in order,
// mutating `data` in place. In-place matters: the caller's `this.data.histogram`
// is handed to HistogramStore by reference, so migration must finish before that
// object is captured (see main.ts).
//
// Returns the version migrated from, or null if nothing ran.
export function migratePluginData(data: PluginData): number | null {
    const bag = data as unknown as MutableData;
    const savedVersion = typeof bag["dataVersion"] === "number" ? (bag["dataVersion"] as number) : 1;

    // Unknown future version (a downgrade): leave the data alone rather than
    // running steps that were written for an older shape.
    if (savedVersion >= CURRENT_DATA_VERSION) return null;

    for (let v = savedVersion; v < CURRENT_DATA_VERSION; v++) {
        STEPS[v]?.(bag);
    }
    data.dataVersion = CURRENT_DATA_VERSION;
    return savedVersion;
}

// The load-time hydration rules, kept here rather than in main.ts so they are
// testable without the obsidian import, exactly as migratePluginData is.
//
// Two of these are load bearing and have no compile-time protection.
// Installs from 1.4.1 and earlier predate dataVersion, and the Object.assign
// onto DEFAULT_DATA would otherwise hand them the current version so every
// migration is skipped. A genuinely fresh install (saved === null) is already
// current and must not be migrated. The nested clones exist because
// Object.assign is shallow, so without them the settings tab edits the shared
// DEFAULT_SETTINGS arrays in place.
export function hydratePluginData(saved: Partial<PluginData> | null): PluginData {
    const data = Object.assign({}, DEFAULT_DATA, saved ?? {}) as PluginData;
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
    if (saved !== null && typeof saved.dataVersion !== "number") {
        data.dataVersion = 1;
    }
    const h = data.histogram;
    // The inner record is spread too. A fresh wrapper around the same `data`
    // object still shares it with DEFAULT_DATA, and HistogramStore increments
    // that record on every write.
    data.histogram = { data: { ...(h?.data ?? {}) }, builtAt: h?.builtAt ?? null };
    data.settings.cardTypes = data.settings.cardTypes.map(t => ({ ...t }));
    data.settings.constructionConstraints = data.settings.constructionConstraints
        .map(c => ({ labels: [...c.labels], deckTags: [...c.deckTags] }));
    return data;
}
