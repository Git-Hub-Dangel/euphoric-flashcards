import {
    createEmptyCard,
    fsrs,
    generatorParameters,
    Rating,
    State,
    default_w,
} from "ts-fsrs";
import type { Card, FSRS, FSRSParameters, Grade } from "ts-fsrs";

import { REQUEST_RETENTION_MAX, REQUEST_RETENTION_MIN } from "src/settings";
import type { EuphoricSettings } from "src/settings";

// The single boundary between this plugin and ts-fsrs. Nothing else in src/ may
// import "ts-fsrs" — enforced by a grep in the FSRS plan's Phase 7 scan. Keeping
// the surface to one file is what makes the engine swappable and unit-testable,
// and it is where every locked parameter decision lives.
//
// Re-exported so consumers get the enums and types without reaching past this
// boundary.
export { Rating, State };
export type { Card, Grade };

// Rating.Manual (0) is not a grade. These four are, in ascending quality.
export const FSRS_GRADES = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;

// A grade-keyed record, as previewAll returns.
export type GradeRecord<T> = Record<Grade, T>;

// --- Locked parameters (FSRS plan §B1) -------------------------------------
//
// enable_short_term: false selects the LongTermScheduler. Consequences the rest
// of the plugin relies on, verified by fsrs.test.ts:
//   - every outcome, Again included, lands in State.Review
//   - State.Learning / State.Relearning never occur
//   - scheduled_days is always >= 1, so day granularity survives and
//     textInterval keeps working
//
// enable_fuzz: false is deliberate and must stay false. The load-balancing
// histogram owns all jitter; two independent jitter sources would make the
// seeded-rng test seam non-authoritative.
const HARDCODED: Pick<
    FSRSParameters,
    "enable_short_term" | "enable_fuzz" | "learning_steps" | "relearning_steps"
> = {
    enable_short_term: false,
    enable_fuzz: false,
    learning_steps: [],
    relearning_steps: [],
};

// The slider's bounds (from src/settings) are applied defensively here too: a
// hand-edited data.json must not be able to skew or throw inside the scheduler
// at review time.
function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
}

// Built fresh from settings on each use, mirroring how SRAlgorithmOsr was
// constructed per call, so a slider move takes effect immediately.
export function buildFsrsParameters(settings: EuphoricSettings): FSRSParameters {
    return generatorParameters({
        ...HARDCODED,
        request_retention: clamp(
            settings.requestRetention,
            REQUEST_RETENTION_MIN,
            REQUEST_RETENTION_MAX,
        ),
        // 1:1 with the existing setting and its existing slider. No rename.
        maximum_interval: Math.max(1, Math.round(settings.maximumInterval)),
        // w is never surfaced, never stored, and never edited. The library's
        // defaults are the only weights this plugin ships.
        w: default_w,
    });
}

// The FSRS weights currently in force. Exposed for tests and for the settings
// tab's "reset" affordance to describe; never rendered as editable controls.
export function fsrsDefaultWeights(): readonly number[] {
    return default_w;
}

// A brand-new card: State.New, zero stability/difficulty, no last_review.
export function emptyCard(now: Date): Card {
    return createEmptyCard(now);
}

// Wrapper around one configured FSRS instance.
export class FsrsEngine {
    private readonly f: FSRS;
    readonly params: FSRSParameters;

    constructor(settings: EuphoricSettings) {
        this.params = buildFsrsParameters(settings);
        this.f = fsrs(this.params);
    }

    // The card state a given grade would produce. This is the write path.
    schedule(card: Card, grade: Grade, now: Date): Card {
        return this.f.next(card, now, grade).card;
    }

    // All four outcomes from a single repeat() call. Previews and the
    // subsequent write must come from the same snapshot — computing them
    // separately is how a previewed interval and a written interval drift apart.
    previewAll(card: Card, now: Date): GradeRecord<Card> {
        const preview = this.f.repeat(card, now);
        return {
            [Rating.Again]: preview[Rating.Again].card,
            [Rating.Hard]: preview[Rating.Hard].card,
            [Rating.Good]: preview[Rating.Good].card,
            [Rating.Easy]: preview[Rating.Easy].card,
        };
    }

    // Probability of recall right now, in [0, 1]. Ascending order of this value
    // is the Learn due ranking.
    //
    // Two properties callers must know: a State.New card returns exactly 0, and
    // elapsed time is floored to whole days inside ts-fsrs, so cards reviewed on
    // the same day tie and the caller's tie-break carries real weight.
    retrievability(card: Card, now: Date): number {
        return this.f.get_retrievability(card, now, false);
    }
}
