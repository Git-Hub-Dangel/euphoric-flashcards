import type { ParsedCard } from "src/parsing";
import type { ScheduleInfo } from "src/persistence";
import { isFaceDue } from "src/scheduling/due";
import { fisherYates } from "src/utils/shuffle";
import { LEARN_ANCHOR_MIN_INTERVAL_DAYS, LEARN_MATURE_INTERVAL_DAYS } from "src/learn/constants";

export interface CardLocation {
    card: ParsedCard;
    filePath: string;
}

export interface AnchorLocation extends CardLocation {
    interval: number;
}

export interface LearnPools {
    newCards: CardLocation[];
    matureDue: CardLocation[];
    youngDue: CardLocation[];
    youngFiller: CardLocation[];
    matureAnchors: AnchorLocation[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function minSeenInterval(card: ParsedCard): number {
    let m = Infinity;
    for (const s of card.schedules) {
        if (s !== null && s.interval < m) m = s.interval;
    }
    return m;
}

function minSeenEase(card: ParsedCard): number {
    let m = Infinity;
    for (const s of card.schedules) {
        if (s !== null && s.latestEase < m) m = s.latestEase;
    }
    return m === Infinity ? 0 : m;
}

// Overdue ratio per face: 1 + days_overdue / interval. A face due exactly
// today scores 1; a face overdue by its full interval scores 2.
function overdueRatio(schedule: ScheduleInfo, todayMs: number): number {
    const days = (todayMs - schedule.dueDate.valueOf()) / MS_PER_DAY;
    return 1 + days / schedule.interval;
}

function maxOverdueRatio(card: ParsedCard, today: Date): number {
    const todayMs = today.valueOf();
    let m = -Infinity;
    for (const s of card.schedules) {
        if (s !== null && isFaceDue(s, today)) {
            const r = overdueRatio(s, todayMs);
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
        const iv = minSeenInterval(card);
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
        if (iv >= LEARN_ANCHOR_MIN_INTERVAL_DAYS) matureAnchors.push({ ...loc, interval: iv });
    }

    // Rank due pools by descending overdue ratio, tie-break by lowest ease.
    const rankDue = (a: CardLocation, b: CardLocation): number => {
        const ra = maxOverdueRatio(a.card, today);
        const rb = maxOverdueRatio(b.card, today);
        if (rb !== ra) return rb - ra;
        return minSeenEase(a.card) - minSeenEase(b.card);
    };
    matureDue.sort(rankDue);
    youngDue.sort(rankDue);

    // Young filler drawn lowest-ease first when we spill into it.
    youngFiller.sort((a, b) => minSeenEase(a.card) - minSeenEase(b.card));

    // New pool is shuffled so thematically adjacent lines disperse.
    fisherYates(newCards, rng);

    return { newCards, matureDue, youngDue, youngFiller, matureAnchors };
}
