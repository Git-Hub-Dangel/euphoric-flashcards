import type { ParsedCard } from "src/parsing";
import { ReviewResponse } from "src/scheduling/review-response";
import type { AnchorLocation, CardLocation } from "src/learn/pool";
import type { GroupCardState } from "src/learn/group-state";
import { LEARN_SENTENCE_TRIGGER } from "src/learn/constants";

// Number of sentence tasks for this group. Fragile groups (many new + Again
// cards) get more; capped so tasks never exceed ceil(G/2).
export function computeTaskCount(
    groupCards: readonly ParsedCard[],
    states: Map<ParsedCard, GroupCardState>,
): number {
    const G = groupCards.length;
    if (G === 0) return 0;
    let f = 0;
    for (const c of groupCards) {
        const st = states.get(c);
        if (st === undefined) continue;
        if (st.wasNew || st.againCount >= 1) f++;
    }
    const rawT = 1 + (f >= 2 ? 1 : 0) + (f >= 4 ? 1 : 0);
    return Math.min(rawT, Math.ceil(G / 2));
}

// Threshold at which task k should fire (1-indexed).
// T=1 → single trigger at 0.7. T>=2 spreads the tasks across [0.7, 1.0].
export function computeThresholds(T: number): number[] {
    if (T <= 0) return [];
    if (T === 1) return [LEARN_SENTENCE_TRIGGER];
    const out: number[] = [];
    for (let k = 1; k <= T; k++) {
        out.push(LEARN_SENTENCE_TRIGGER + (1 - LEARN_SENTENCE_TRIGGER) * (k - 1) / (T - 1));
    }
    return out;
}

// How many pending thresholds a single answer has now crossed. The caller
// holds `cursor`, the count of tasks already fired for this group.
export function tasksFiring(progress: number, thresholds: readonly number[], cursor: number): number {
    let n = 0;
    for (let i = cursor; i < thresholds.length; i++) {
        if (progress >= thresholds[i]!) n++;
        else break;
    }
    return n;
}

function baseWeight(st: GroupCardState | undefined): number {
    if (st === undefined) return 1;
    if (st.againCount >= 1) return 4;
    if (st.wasNew) return 3;
    if (st.worst === ReviewResponse.Hard) return 2;
    return 1;
}

// Weighted sampling without replacement via the exponential-jump trick:
// keys = -ln(u) / weight; smallest k keys win. Deterministic given rng.
export function weightedSampleWithoutReplacement(
    weights: readonly number[],
    k: number,
    rng: () => number,
): number[] {
    if (k <= 0) return [];
    const scored: { i: number; key: number }[] = [];
    for (let i = 0; i < weights.length; i++) {
        const w = weights[i]!;
        if (w <= 0) continue;
        const u = Math.max(rng(), Number.EPSILON);
        scored.push({ i, key: -Math.log(u) / w });
    }
    scored.sort((a, b) => a.key - b.key);
    return scored.slice(0, Math.min(k, scored.length)).map(s => s.i);
}

export interface SentenceWordSelection {
    card: ParsedCard;
    filePath: string;
    faceIndex: 0 | 1;
    isAnchor: boolean;
}

export function pickSentenceWords(opts: {
    eligible: readonly CardLocation[];
    states: Map<ParsedCard, GroupCardState>;
    appearanceCounts: Map<ParsedCard, number>;
    anchors: readonly AnchorLocation[];
    wordCount: number;
    faceIndex: 0 | 1;
    rng: () => number;
}): SentenceWordSelection[] {
    const { eligible, states, appearanceCounts, anchors, wordCount, faceIndex, rng } = opts;
    if (wordCount <= 0 || eligible.length === 0) return [];

    // With w=1 the single slot is always a group word. With w>=2 an anchor
    // slot exists only when we have anchors; otherwise it falls back to a
    // group word.
    const anchorSlot = wordCount >= 2 && anchors.length > 0 ? 1 : 0;
    const groupSlots = wordCount - anchorSlot;

    const weights = eligible.map(loc => {
        const u = appearanceCounts.get(loc.card) ?? 0;
        return baseWeight(states.get(loc.card)) * Math.pow(0.5, u);
    });
    const groupIdx = weightedSampleWithoutReplacement(weights, groupSlots, rng);
    const picks: SentenceWordSelection[] = groupIdx.map(i => ({
        card: eligible[i]!.card,
        filePath: eligible[i]!.filePath,
        faceIndex,
        isAnchor: false,
    }));

    if (anchorSlot === 1) {
        const anchorWeights = anchors.map(a => 1 / Math.max(a.interval, 1));
        const [pickIdx] = weightedSampleWithoutReplacement(anchorWeights, 1, rng);
        if (pickIdx !== undefined) {
            picks.push({
                card: anchors[pickIdx]!.card,
                filePath: anchors[pickIdx]!.filePath,
                faceIndex,
                isAnchor: true,
            });
        }
    }
    return picks;
}
