export type CardSide = "Front" | "Back" | "Shuffle";
// Optional override applied to Conjure Sentences steps *inside Learn mode*
// when the active Learn side is "Shuffle". "Default" means no override:
// sentence draws keep their per-draw random face pick. When the active Learn
// side is monodirectional ("Front"/"Back") this setting is ignored.
export type LearnSentenceSide = "Default" | "Front" | "Back";
export type ReviewMode = "Review" | "Cram" | "ConjureSentences" | "Learn";
export type WordSelection = "Random" | "Optimised";

// Bounds for the FSRS `request_retention` slider. Declared here rather than in
// src/scheduling/fsrs.ts so the settings tab and the data migration can both
// reach them without importing the engine (and with it, ts-fsrs).
export const REQUEST_RETENTION_MIN = 0.7;
export const REQUEST_RETENTION_MAX = 0.99;
export const REQUEST_RETENTION_STEP = 0.01;

export interface TypeConfig {
    key: string;
    label: string;
    color: string;
}

export interface ConstructionConstraintCollection {
    labels: string[];
    deckTags: string[];
}

export interface EuphoricSettings {
    // Decks
    rootDeckTags: string[];

    // Scheduling
    // FSRS: the target probability of recall at the moment a card comes due.
    // Lower means longer intervals and more forgetting. Maps to the FSRS
    // parameter `request_retention`; the weights `w` are never user-editable.
    requestRetention: number;
    baseEase: number;
    defaultIntervalChange: number;
    lapsesIntervalChange: number;
    loadBalance: boolean;
    maximumInterval: number;
    startOfDay: string;

    // Card types
    cardTypes: TypeConfig[];

    // Review
    defaultCardSide: CardSide;
    showIntervalOnButtons: boolean;
    showKeybindingsOnDesktop: boolean;

    // Conjure Sentences
    defaultConjureSentencesSide: CardSide;
    conjureSentencesWordCount: number;
    conjureSentencesSelection: WordSelection;
    enableSentenceDeposit: boolean;
    depositInboxPath: string;
    showDepositNotification: boolean;
    enableConstructionConstraints: boolean;
    constructionConstraints: ConstructionConstraintCollection[];

    // Learn
    learnGroupsPerSession: number;
    learnSentenceSide: LearnSentenceSide;

    // Appearance
    animationDurationMs: number;
}

export const DEFAULT_SETTINGS: EuphoricSettings = {
    rootDeckTags: [],

    requestRetention: 0.9,
    baseEase: 250,
    defaultIntervalChange: 1.2,
    lapsesIntervalChange: 0.01,
    loadBalance: true,
    maximumInterval: 365,
    startOfDay: "00:00:00",

    cardTypes: [
        { key: "n", label: "noun", color: "#4a9eff" },
        { key: "v", label: "verb", color: "#ff7043" },
        { key: "a", label: "adjective", color: "#66bb6a" },
        { key: "p", label: "phrase", color: "#B349C1" },
        { key: "i", label: "idiom", color: "#DFD06D" },
    ],

    defaultCardSide: "Shuffle",
    showIntervalOnButtons: true,
    showKeybindingsOnDesktop: true,

    defaultConjureSentencesSide: "Shuffle",
    conjureSentencesWordCount: 3,
    conjureSentencesSelection: "Optimised",
    enableSentenceDeposit: false,
    depositInboxPath: "",
    showDepositNotification: true,
    enableConstructionConstraints: false,
    constructionConstraints: [],

    learnGroupsPerSession: 3,
    learnSentenceSide: "Default",

    animationDurationMs: 240,
};
