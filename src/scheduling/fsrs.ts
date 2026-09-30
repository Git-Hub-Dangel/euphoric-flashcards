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
import { TICKS_PER_DAY } from "src/scheduling/constants";
import { ReviewResponse } from "src/scheduling/review-response";

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

// --- The persisted card state (FSRS plan §B4) -------------------------------
//
// One face of one card. This replaces SM-2's RepItemScheduleInfoOsr; `interval`
// and `latestEase` are gone, and `Moment` has left the scheduling core.
//
// Deliberately NOT a ts-fsrs `Card`. Two fields of `Card` are derived state that
// B4 requires be recomputed at load rather than stored:
//
//   - elapsed_days   days since last_review
//   - scheduled_days days from last_review to due
//
// Storing them would let the file disagree with the clock. Both are recomputed
// in toCard() below, and ts-fsrs ignores the incoming values anyway: both
// AbstractScheduler.init() and get_retrievability() measure from `last_review`
// directly (verified in 5.4.2, dist/index.mjs:362-369 and :1662).
//
// `learning_steps` is likewise absent: under B1's enable_short_term: false it is
// always 0, so there is nothing to persist.
//
// On last_review's type: ts-fsrs models "never reviewed" as `undefined`
// (optional property); B4 specifies `null`. We keep `null` — it survives JSON,
// it cannot be produced by a typo'd property name, and it makes the "new face"
// case explicit at every read site. The two converters are the only places the
// two spellings meet.
export interface ScheduleInfo {
    due: Date;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: State;
    last_review: Date | null;
}

// A face with no schedule at all, or one still carrying State.New, is new.
//
// Both spellings occur: the comment parser returns null for a dummy-dated
// segment, while a stored segment could carry State.New explicitly. Anything
// ranking faces must treat the two identically — get_retrievability returns
// exactly 0 for State.New, which is the most urgent slot in an ascending sort
// (plan P4.2b).
export function isFaceNew(schedule: ScheduleInfo | null): boolean {
    return schedule === null || schedule.state === State.New;
}

// Whole days between two instants, floored, matching ts-fsrs's own date_diff.
// Floored rather than rounded so "same day" is 0 and a card is never credited
// with elapsed time it has not had.
export function diffInDays(from: Date, to: Date): number {
    return Math.floor((to.valueOf() - from.valueOf()) / TICKS_PER_DAY);
}

// The interval a schedule represents: last_review → due, in whole days. This is
// the quantity ts-fsrs calls scheduled_days, recomputed rather than stored. It
// is what the button previews render through textInterval.
export function scheduledDays(s: ScheduleInfo): number {
    if (s.last_review === null) return 0;
    return Math.max(0, diffInDays(s.last_review, s.due));
}

// ScheduleInfo → the shape ts-fsrs wants, with the two derived fields restored.
export function toCard(s: ScheduleInfo, now: Date): Card {
    const lastReview = s.last_review;
    return {
        due: s.due,
        stability: s.stability,
        difficulty: s.difficulty,
        elapsed_days: lastReview === null ? 0 : Math.max(0, diffInDays(lastReview, now)),
        scheduled_days: scheduledDays(s),
        learning_steps: 0,
        reps: s.reps,
        lapses: s.lapses,
        state: s.state,
        ...(lastReview === null ? {} : { last_review: lastReview }),
    };
}

// ts-fsrs → our persisted shape, dropping the derived fields.
export function toScheduleInfo(c: Card): ScheduleInfo {
    return {
        due: c.due,
        stability: c.stability,
        difficulty: c.difficulty,
        reps: c.reps,
        lapses: c.lapses,
        state: c.state,
        last_review: c.last_review ?? null,
    };
}

// --- Rating translation (FSRS plan §C3) ------------------------------------
//
// ReviewResponse is Easy=0, Good=1, Hard=2, Again=3. FSRS Rating is Again=1,
// Hard=2, Good=3, Easy=4 — the reverse order, except that Hard is 2 in both.
// That single coincidence is what makes a naive cast so dangerous: three of the
// four values invert while the one a spot-check is most likely to land on keeps
// working. This table is exhaustive and explicitly tested; never inline a cast.
const RATING_FOR_RESPONSE: Record<ReviewResponse, Grade> = {
    [ReviewResponse.Easy]: Rating.Easy,
    [ReviewResponse.Good]: Rating.Good,
    [ReviewResponse.Hard]: Rating.Hard,
    [ReviewResponse.Again]: Rating.Again,
};

export function ratingFor(response: ReviewResponse): Grade {
    return RATING_FOR_RESPONSE[response];
}
