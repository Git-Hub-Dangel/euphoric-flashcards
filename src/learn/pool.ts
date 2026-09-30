import type { ParsedCard } from "src/parsing";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { isFaceDue } from "src/scheduling/due";
import { fisherYates } from "src/utils/shuffle";
import { LEARN_ANCHOR_MIN_INTERVAL_DAYS, LEARN_MATURE_INTERVAL_DAYS } from "src/learn/constants";

export interface CardLocation {
    card: ParsedCard;
    filePath: string;
}

export interface AnchorLocation extends CardLocation {
    // Stability, not an interval. Renamed with the field it now holds so the
    // anchor weighting cannot quietly keep reading one as the other.
    stability: number;
}

export interface LearnPools {
    newCards: CardLocation[];
    matureDue: CardLocation[];
    youngDue: CardLocation[];
    youngFiller: CardLocation[];
    matureAnchors: AnchorLocation[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Min across faces, deliberately: a card is only as well known as its weaker
// direction. This is a pedagogical rule, not an artefact of SM-2, and it must
// survive the move to FSRS quantities (plan §B3).
function minSeenStability(card: ParsedCard): number {
    let m = Infinity;
    for (const s of card.schedules) {
        if (s !== null && s.stability < m) m = s.stability;
    }
    return m;
}

// The shakiest face's difficulty. ⚠️ Sign flip from the ease this replaced:
// low ease meant a struggling card, and so does *high* difficulty. Read the
// wrong way round this silently prioritises the user's easiest cards, and
// nothing else in the suite would catch it (plan §C3) — hence the explicit
// ordering test in pool.test.ts.
function maxSeenDifficulty(card: ParsedCard): number {
    let m = -Infinity;
    for (const s of card.schedules) {
        if (s !== null && s.difficulty > m) m = s.difficulty;
    }
    return m === -Infinity ? 0 : m;
}

// Overdue ratio per face: 1 + days_overdue / stability. A face due exactly today
// scores 1; a face overdue by its own stability scores 2.
//
// Phase 3 port only: stability stands in where `interval` used to, preserving the
// ranking's shape while the data model changes underneath it. P4.2 replaces this
// function outright with retrievability ascending. The Math.max(1, ...) floor is
// new and temporary — FSRS stability can legitimately sit below 1 day for a badly
// lapsed card, where SM-2's interval could not, and an unfloored divisor would
// let one such face swamp the ranking.
function overdueRatio(schedule: ScheduleInfo, nowMs: number): number {
    const days = (nowMs - schedule.due.valueOf()) / MS_PER_DAY;
    return 1 + days / Math.max(1, schedule.stability);
}

function maxOverdueRatio(card: ParsedCard, today: Date): number {
    const nowMs = today.valueOf();
    let m = -Infinity;
    for (const s of card.schedules) {
        if (s !== null && isFaceDue(s, today)) {
            const r = overdueRatio(s, nowMs);
            if (r > m) m = r;
        }
    }
    return m;
}

export function classifyPools(
    cards: readonly CardLocation[],
    today: Date,
    rng: () => number = Math.random,
): LearnPools {
    const newCards: CardLocation[] = [];
    const matureDue: CardLocation[] = [];
    const youngDue: CardLocation[] = [];
    const youngFiller: CardLocation[] = [];
    const matureAnchors: AnchorLocation[] = [];

    for (const loc of cards) {
        const { card } = loc;
        const hasNew = card.schedules[0] === null || card.schedules[1] === null;
        if (hasNew) {
            newCards.push(loc);
            continue;
        }
        const iv = minSeenStability(card);
        const hasDue =
            (card.schedules[0] !== null && isFaceDue(card.schedules[0], today)) ||
            (card.schedules[1] !== null && isFaceDue(card.schedules[1], today));
        const mature = iv >= LEARN_MATURE_INTERVAL_DAYS;
        if (hasDue) {
            (mature ? matureDue : youngDue).push(loc);
            continue;
        }
        // A semi mature card (past the anchor floor, short of maturity) is both
        // group filler and anchor material. The two pools overlap for that
        // band, so sampling filters anchors against cards the session has
        // already used and shiftLocationsForDelta dedupes by card identity.
        if (!mature) youngFiller.push(loc);
        if (iv >= LEARN_ANCHOR_MIN_INTERVAL_DAYS) matureAnchors.push({ ...loc, stability: iv });
    }

    // Rank due pools by descending overdue ratio, tie-break by *highest*
    // difficulty — the shakiest card first, which is what lowest-ease used to mean.
    const rankDue = (a: CardLocation, b: CardLocation): number => {
        const ra = maxOverdueRatio(a.card, today);
        const rb = maxOverdueRatio(b.card, today);
        if (rb !== ra) return rb - ra;
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
