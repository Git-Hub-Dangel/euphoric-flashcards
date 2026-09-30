import { DEFAULT_SETTINGS } from "src/settings";
import type { CardSide, EuphoricSettings, ReviewMode, WordSelection } from "src/settings";
import type { HistogramState } from "src/scheduling/histogram-store";

// Bump this whenever a PluginData key is added with a non-trivial default, or
// removed. Every removal needs a step in STEPS: `Object.assign` in loadData_
// copies unknown saved keys through verbatim, so a key deleted from the
// interface survives in data.json forever unless a migration deletes it.
export const CURRENT_DATA_VERSION = 2;

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

const STEPS: Record<number, (data: MutableData) => void> = {
    1: stepV1ToV2,
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
