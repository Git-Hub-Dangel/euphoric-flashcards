import type { ParsedCard } from "src/parsing";
import { ReviewResponse } from "src/scheduling/review-response";
import { reinsertWithMinLag } from "src/utils/queue";
import { LEARN_AGAIN_MIN_LAG } from "src/learn/constants";
import type { CardLocation } from "src/learn/pool";

export interface LearnItem extends CardLocation {
    faceIndex: 0 | 1;
    writeEligible: boolean;
}

// Per-card bookkeeping for one group. Never persisted. Discarded when the
// group ends, apart from the three fields the carryover snapshot copies forward.
export interface GroupCardState {
    againCount: number;
    lastAgainSeq: number;
    worst: ReviewResponse | null;
    wasNew: boolean;
    pendingFaces: Set<0 | 1>;
    facesCleared: [boolean, boolean];
}

// Assemble the initial queue: both faces of every group card, ordered so
// that no adjacent pair shares the same ParsedCard whenever possible. Uses
// rejection sampling — draw uniformly from any card that isn't the one just
// emitted, falling back only when it's the only card remaining (unavoidable
// for a group of 1).
export function buildInitialQueue(
    group: CardLocation[],
    writeEligibleFor: (card: ParsedCard, faceIndex: 0 | 1) => boolean,
    rng: () => number = Math.random,
): LearnItem[] {
    const remaining = new Map<ParsedCard, LearnItem[]>();
    for (const loc of group) {
        const faces: LearnItem[] = [
            { ...loc, faceIndex: 0, writeEligible: writeEligibleFor(loc.card, 0) },
            { ...loc, faceIndex: 1, writeEligible: writeEligibleFor(loc.card, 1) },
        ];
        if (rng() < 0.5) faces.reverse();
        remaining.set(loc.card, faces);
    }

    const queue: LearnItem[] = [];
    let last: ParsedCard | null = null;
    while (remaining.size > 0) {
        const entries = [...remaining.entries()];
        const eligible = entries.filter(([c]) => c !== last);
        // Prefer the card with the most remaining faces to prevent a
        // "stuck alone" endgame that would force adjacency.
        let pool: [ParsedCard, LearnItem[]][];
        if (eligible.length === 0) {
            pool = entries;
        } else {
            let maxCount = 0;
            for (const [, f] of eligible) if (f.length > maxCount) maxCount = f.length;
            pool = eligible.filter(([, f]) => f.length === maxCount);
        }
        const [pickCard, faces] = pool[Math.floor(rng() * pool.length)]!;
        queue.push(faces.shift()!);
        if (faces.length === 0) remaining.delete(pickCard);
        last = pickCard;
    }
    return queue;
}

export function makeInitialStates(group: CardLocation[]): Map<ParsedCard, GroupCardState> {
    const out = new Map<ParsedCard, GroupCardState>();
    for (const loc of group) {
        const wasNew = loc.card.schedules[0] === null || loc.card.schedules[1] === null;
        out.set(loc.card, {
            againCount: 0,
            lastAgainSeq: -1,
            worst: null,
            wasNew,
            pendingFaces: new Set(),
            facesCleared: [false, false],
        });
    }
    return out;
}

// Mutate group state and queue in response to an Again on `item`. The item is
// reinserted at least LEARN_AGAIN_MIN_LAG positions past `currentIdx`.
export function recordAgain(
    states: Map<ParsedCard, GroupCardState>,
    queue: LearnItem[],
    currentIdx: number,
    item: LearnItem,
    seq: number,
    rng: () => number = Math.random,
): void {
    const st = stateFor(states, item.card);
    st.againCount++;
    st.lastAgainSeq = seq;
    st.pendingFaces.add(item.faceIndex);
    st.worst = worstOf(st.worst, ReviewResponse.Again);
    reinsertWithMinLag(queue, currentIdx, item, LEARN_AGAIN_MIN_LAG, rng);
}

// Clear a face. First-pass Okay/Good updates `worst`; post-Again OK clears
// pending without altering `worst` beyond what Again already recorded.
export function recordClear(
    states: Map<ParsedCard, GroupCardState>,
    item: LearnItem,
    response: ReviewResponse,
    isPostAgain: boolean,
): void {
    const st = stateFor(states, item.card);
    st.facesCleared[item.faceIndex] = true;
    st.pendingFaces.delete(item.faceIndex);
    if (!isPostAgain) st.worst = worstOf(st.worst, response);
}

export function isGroupComplete(states: Map<ParsedCard, GroupCardState>): boolean {
    for (const st of states.values()) {
        if (!st.facesCleared[0] || !st.facesCleared[1]) return false;
    }
    return true;
}

export function groupProgress(states: Map<ParsedCard, GroupCardState>): number {
    let total = 0;
    let cleared = 0;
    for (const st of states.values()) {
        total += 2;
        if (st.facesCleared[0]) cleared++;
        if (st.facesCleared[1]) cleared++;
    }
    return total === 0 ? 0 : cleared / total;
}

// Eligible for sentence sampling: at least one face cleared and no face still
// pending after an Again.
export function isEligibleForSentences(st: GroupCardState): boolean {
    return (st.facesCleared[0] || st.facesCleared[1]) && st.pendingFaces.size === 0;
}

// Group state is seeded for every group card when the group is built. A miss
// means the queue and the state map have diverged, which is a bug worth
// surfacing rather than papering over with a blank record.
function stateFor(map: Map<ParsedCard, GroupCardState>, card: ParsedCard): GroupCardState {
    const st = map.get(card);
    if (st === undefined) {
        throw new Error(`Learn: no group state for card "${card.fields.word}"`);
    }
    return st;
}

// ReviewResponse enum encodes quality: Easy=0, Good=1, Hard=2, Again=3.
// The "worst" recorded response is the largest enum value seen so far.
function worstOf(prev: ReviewResponse | null, next: ReviewResponse): ReviewResponse {
    if (prev === null) return next;
    return next > prev ? next : prev;
}
