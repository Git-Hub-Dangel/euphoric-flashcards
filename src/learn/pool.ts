import type { ParsedCard } from "src/parsing";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { isFaceNew } from "src/scheduling/fsrs";
import { isFaceDue } from "src/scheduling/due";
import { fisherYates } from "src/utils/shuffle";
import { LEARN_ANCHOR_MIN_STABILITY, LEARN_MATURE_STABILITY } from "src/learn/constants";

export interface CardLocation {
    card: ParsedCard;
    filePath: string;
}

export interface AnchorLocation extends CardLocation {
    // Stability, not an interval. Named for the field it holds so the anchor
    // weighting cannot quietly keep reading one as the other.
    stability: number;
}

export interface LearnPools {
    newCards: CardLocation[];
    matureDue: CardLocation[];
    youngDue: CardLocation[];
    youngFiller: CardLocation[];
    matureAnchors: AnchorLocation[];
}

// Probability of recalling one face right now, in [0, 1]. Injected rather than
// constructed here so this module stays pure ranking logic: the modal supplies a
// closure over the live FSRS engine, and tests supply the real engine too (a
// stubbed curve would let a sign error through).
export type RetrievabilityFn = (schedule: ScheduleInfo, now: Date) => number;

// Min across faces, deliberately: a card is only as well known as its weaker
// direction. This is a pedagogical rule, not an artefact of SM-2, and it had to
// survive the move to FSRS quantities (plan §B3).
function minSeenStability(card: ParsedCard): number {
    let m = Infinity;
    for (const s of card.schedules) {
        if (!isFaceNew(s) && s!.stability < m) m = s!.stability;
    }
    return m;
}

// The shakiest face's difficulty. ⚠️ Sign flip from the ease this replaced: low
// ease meant a struggling card, and so does *high* difficulty. Read the wrong way
// round this silently serves the user's easiest cards first and nothing else in
// the suite would notice (plan §C3) — hence the explicit ordering tests.
//
// Max across faces, mirroring minSeenStability: one shaky direction is enough to
// promote a card.
function maxSeenDifficulty(card: ParsedCard): number {
    let m = -Infinity;
    for (const s of card.schedules) {
        if (!isFaceNew(s) && s!.difficulty > m) m = s!.difficulty;
    }
    return m === -Infinity ? 0 : m;
}

// The card's urgency: the lowest recall probability across its due faces.
// Ascending order of this value is the due ranking (plan §B3) — least likely to
// be remembered goes first. It replaces the old overdueRatio outright, and with
// it the last place SM-2's `interval` was still being read.
//
// ⚠️ New faces are skipped, not merely absent. get_retrievability returns exactly
// 0 for State.New, and 0 is the *most urgent* slot in an ascending sort, so a New
// face reaching this function would silently jump the entire queue (plan P4.2b).
// classifyPools already routes such cards to newCards, but this function does not
// rely on that: it is defensive in its own right.
function minRetrievability(card: ParsedCard, now: Date, retrievability: RetrievabilityFn): number {
    let m = Infinity;
    for (const s of card.schedules) {
        if (isFaceNew(s)) continue;
        if (!isFaceDue(s, now)) continue;
        const r = retrievability(s!, now);
        if (r < m) m = r;
    }
    return m;
}

export function classifyPools(
    cards: readonly CardLocation[],
    now: Date,
    retrievability: RetrievabilityFn,
    rng: () => number = Math.random,
): LearnPools {
    const newCards: CardLocation[] = [];
    const matureDue: CardLocation[] = [];
    const youngDue: CardLocation[] = [];
    const youngFiller: CardLocation[] = [];
    const matureAnchors: AnchorLocation[] = [];

    for (const loc of cards) {
        const { card } = loc;
        // A face is new when it has no schedule at all, or carries State.New.
        if (isFaceNew(card.schedules[0]) || isFaceNew(card.schedules[1])) {
            newCards.push(loc);
            continue;
        }
        const stability = minSeenStability(card);
        const hasDue =
            isFaceDue(card.schedules[0], now) || isFaceDue(card.schedules[1], now);
        const mature = stability >= LEARN_MATURE_STABILITY;
        if (hasDue) {
            (mature ? matureDue : youngDue).push(loc);
            continue;
        }
        // A semi mature card (past the anchor floor, short of maturity) is both
        // group filler and anchor material. The two pools overlap for that band,
        // so sampling filters anchors against cards the session has already used
        // and shiftLocationsForDelta dedupes by card identity.
        if (!mature) youngFiller.push(loc);
        if (stability >= LEARN_ANCHOR_MIN_STABILITY) {
            matureAnchors.push({ ...loc, stability });
        }
    }

    // Rank due pools by ascending retrievability — least likely to be recalled
    // first — tie-broken by *highest* difficulty, the shakiest card first.
    //
    // The tie-break is load-bearing, not decorative: ts-fsrs floors elapsed time
    // to whole days, so any two faces last reviewed on the same day with equal
    // stability return exactly the same retrievability. Ties are the common case,
    // not the edge case.
    const rankDue = (a: CardLocation, b: CardLocation): number => {
        const ra = minRetrievability(a.card, now, retrievability);
        const rb = minRetrievability(b.card, now, retrievability);
        if (ra !== rb) return ra - rb;
        return maxSeenDifficulty(b.card) - maxSeenDifficulty(a.card);
    };
    matureDue.sort(rankDue);
    youngDue.sort(rankDue);

    // Young filler drawn hardest-first when we spill into it.
    youngFiller.sort((a, b) => maxSeenDifficulty(b.card) - maxSeenDifficulty(a.card));

    // New pool is shuffled so thematically adjacent lines disperse.
    fisherYates(newCards, rng);

    return { newCards, matureDue, youngDue, youngFiller, matureAnchors };
}
