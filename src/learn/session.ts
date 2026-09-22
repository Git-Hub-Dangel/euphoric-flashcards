import type { ParsedCard } from "src/parsing";
import { ReviewResponse } from "src/scheduling/review-response";
import { isFaceDue } from "src/scheduling/due";
import type { AnchorLocation, CardLocation, LearnPools } from "src/learn/pool";
import {
    buildInitialQueue,
    groupProgress,
    isEligibleForSentences,
    isGroupComplete,
    makeInitialHistories,
    recordAgain,
    recordClear,
} from "src/learn/group-state";
import type { LearnCardHistory, LearnItem } from "src/learn/group-state";
import { buildLearnGroup } from "src/learn/group-builder";
import { selectCarryover } from "src/learn/carryover";
import {
    computeTaskCount,
    computeThresholds,
    pickSentenceWords,
    tasksFiring,
} from "src/learn/sentence-planner";
import type { SentenceWordSelection } from "src/learn/sentence-planner";
import { resolveFaceIndex } from "src/utils/face";
import type { CardSide } from "src/settings";

export type LearnStep =
    | { kind: "face"; item: LearnItem; isPostAgain: boolean; groupSize: number }
    | { kind: "sentence"; words: SentenceWordSelection[] }
    | { kind: "done"; groupsCompleted: number };

export type FaceAnswer = "Again" | "Okay" | "Good" | "OK";

export interface WriteIntent {
    kind: "graded" | "reset";
    response: ReviewResponse;   // Hard for Okay, Good for Good, Hard for post-Again OK (reset uses it too)
}

export interface FaceAnswerOutcome {
    writeIntent: WriteIntent | null;
    groupCompleted: boolean;
}

export interface LearnSessionOptions {
    groupLimit: number;
    wordCount: number;
    cardSide: CardSide;
    today: Date;
    rng: () => number;
}

interface GroupContext {
    cards: CardLocation[];
    queue: LearnItem[];
    idx: number;
    histories: Map<ParsedCard, LearnCardHistory>;
    thresholds: number[];
    thresholdCursor: number;
    pendingTasks: SentenceWordSelection[][];
    appearanceCounts: Map<ParsedCard, number>;
    taskCount: number;
    // Snapshot of anchors excluding this group's cards (for sentence sampling).
    anchorsForSampling: AnchorLocation[];
}

// LearnSession is a pure state machine. The modal fulfils IO (writes, DOM);
// the session enforces: session-wide write eligibility, session-wide sentence
// planning, carryover, and terminal condition. It never touches the vault.
export class LearnSession {
    private readonly pools: LearnPools;
    private readonly opts: LearnSessionOptions;

    private readonly used = new Set<ParsedCard>();
    private readonly carried = new Set<ParsedCard>();
    private readonly writtenFaces = new Set<string>();

    private groupsCompleted = 0;
    private seqCounter = 0;
    private carryoverForNext: CardLocation | null = null;
    // Carried card's stats snapshotted from the previous group so the new
    // group's history seeds againCount / wasNew correctly (which drives
    // sentence-planner weights).
    private carryoverHistory: {
        againCount: number;
        lastAgainSeq: number;
        wasNew: boolean;
    } | null = null;

    private group: GroupContext | null = null;
    private done = false;

    constructor(pools: LearnPools, opts: LearnSessionOptions) {
        this.pools = pools;
        this.opts = opts;
    }

    start(): void {
        this.beginNextGroup();
    }

    // Peek at what should be rendered next.
    nextStep(): LearnStep {
        if (this.done || this.group === null) {
            return { kind: "done", groupsCompleted: this.groupsCompleted };
        }
        if (this.group.pendingTasks.length > 0) {
            return { kind: "sentence", words: this.group.pendingTasks[0]! };
        }
        const item = this.group.queue[this.group.idx];
        if (item === undefined) {
            return { kind: "done", groupsCompleted: this.groupsCompleted };
        }
        return {
            kind: "face",
            item,
            isPostAgain: this.isFacePending(item),
            groupSize: this.group.cards.length,
        };
    }

    // True iff the face currently sits in its card's pendingFaces set.
    isFacePending(item: LearnItem): boolean {
        if (this.group === null) return false;
        const h = this.group.histories.get(item.card);
        return h !== undefined && h.pendingFaces.has(item.faceIndex);
    }

    // Whether the modal must actually persist a schedule for this item.
    private shouldWrite(item: LearnItem): boolean {
        if (!item.writeEligible) return false;
        return !this.writtenFaces.has(faceKey(item));
    }

    submitFaceAnswer(item: LearnItem, answer: FaceAnswer): FaceAnswerOutcome {
        if (this.group === null) return { writeIntent: null, groupCompleted: false };
        const g = this.group;
        this.seqCounter++;

        let writeIntent: WriteIntent | null = null;
        const wasPending = this.isFacePending(item);

        if (answer === "Again") {
            recordAgain(g.histories, g.queue, g.idx, item, this.seqCounter, this.opts.rng);
            g.idx++;
            // Again never writes.
        } else if (answer === "OK") {
            // Post-Again reset path.
            recordClear(g.histories, item, ReviewResponse.Hard, true);
            g.idx++;
            if (this.shouldWrite(item)) {
                writeIntent = { kind: "reset", response: ReviewResponse.Hard };
            }
        } else {
            // First-pass Okay / Good.
            const response = answer === "Good" ? ReviewResponse.Good : ReviewResponse.Hard;
            recordClear(g.histories, item, response, wasPending);
            g.idx++;
            if (this.shouldWrite(item)) {
                writeIntent = { kind: "graded", response };
            }
        }

        // Enqueue sentence tasks if the fresh progress crosses any threshold.
        this.enqueueDueSentenceTasks();

        const groupCompleted = isGroupComplete(g.histories);
        this.advanceIfGroupComplete();
        return { writeIntent, groupCompleted };
    }

    // Called by the modal after a successful vault write for the given item.
    // Marks the face as written so subsequent sessions the same day skip it.
    confirmWritten(item: LearnItem): void {
        this.writtenFaces.add(faceKey(item));
    }

    // Advance past the current sentence task (user pressed Continue).
    dismissSentence(): void {
        if (this.group === null) return;
        this.group.pendingTasks.shift();
        this.advanceIfGroupComplete();
    }

    // Redraw the current sentence task (user pressed Regenerate).
    regenerateSentence(): SentenceWordSelection[] | null {
        if (this.group === null || this.group.pendingTasks.length === 0) return null;
        // Roll back the appearance counts from the outgoing pick before rerolling.
        const outgoing = this.group.pendingTasks[0]!;
        for (const w of outgoing) {
            if (!w.isAnchor) this.bumpAppearance(w.card, -1);
        }
        const fresh = this.drawSentenceWords();
        this.group.pendingTasks[0] = fresh;
        for (const w of fresh) {
            if (!w.isAnchor) this.bumpAppearance(w.card, +1);
        }
        return fresh;
    }

    // After every user action the modal should call this to see whether the
    // group is complete and either start the next one or finish.
    advanceIfGroupComplete(): void {
        if (this.group === null) return;
        if (!isGroupComplete(this.group.histories)) return;
        if (this.group.pendingTasks.length > 0) return;
        this.groupsCompleted++;
        // Pick carryover and snapshot its stats before we drop the context.
        const carryCard = selectCarryover(this.group.histories, this.carried);
        if (carryCard !== null) {
            const loc = this.group.cards.find(c => c.card === carryCard) ?? null;
            const h = this.group.histories.get(carryCard)!;
            this.carryoverForNext = loc;
            this.carryoverHistory = {
                againCount: h.againCount,
                lastAgainSeq: h.lastAgainSeq,
                wasNew: h.wasNew,
            };
            this.carried.add(carryCard);
        } else {
            this.carryoverForNext = null;
            this.carryoverHistory = null;
        }
        this.group = null;

        if (this.groupsCompleted >= this.opts.groupLimit) {
            this.done = true;
            return;
        }
        this.beginNextGroup();
    }

    heldLocations(): CardLocation[] {
        const out: CardLocation[] = [];
        if (this.group !== null) {
            for (const q of this.group.queue) out.push(q);
        }
        out.push(...this.pools.newCards);
        out.push(...this.pools.matureDue);
        out.push(...this.pools.youngDue);
        out.push(...this.pools.youngFiller);
        out.push(...this.pools.matureAnchors);
        if (this.carryoverForNext !== null) out.push(this.carryoverForNext);
        return out;
    }

    isDone(): boolean {
        return this.done;
    }

    getGroupsCompleted(): number {
        return this.groupsCompleted;
    }

    getGroupLimit(): number {
        return this.opts.groupLimit;
    }

    // Number of cleared faces vs total faces in the current group (0/0 when
    // no group is active).
    getGroupProgress(): { cleared: number; total: number } {
        if (this.group === null) return { cleared: 0, total: 0 };
        let cleared = 0;
        const total = this.group.cards.length * 2;
        for (const h of this.group.histories.values()) {
            if (h.facesCleared[0]) cleared++;
            if (h.facesCleared[1]) cleared++;
        }
        return { cleared, total };
    }

    private beginNextGroup(): void {
        const carry = this.carryoverForNext;
        const carryHistory = this.carryoverHistory;
        this.carryoverForNext = null;
        this.carryoverHistory = null;
        const cards = buildLearnGroup(this.pools, this.used, carry);
        if (cards.length === 0) {
            this.done = true;
            return;
        }
        const histories = makeInitialHistories(cards);
        // For a carried card, re-seed history from the previous group so
        // againCount / wasNew keep driving weighted sampling. facesCleared
        // and pendingFaces reset for the new group.
        if (carry !== null && carryHistory !== null) {
            histories.set(carry.card, {
                againCount: carryHistory.againCount,
                lastAgainSeq: carryHistory.lastAgainSeq,
                worst: ReviewResponse.Again,
                wasNew: carryHistory.wasNew,
                pendingFaces: new Set(),
                facesCleared: [false, false],
            });
        }
        const queue = buildInitialQueue(
            cards,
            (card, faceIndex) => isFaceDue(card.schedules[faceIndex], this.opts.today),
            this.opts.rng,
        );
        const anchorsForSampling = this.pools.matureAnchors.filter(
            a => !cards.some(c => c.card === a.card),
        );
        const taskCount = computeTaskCount(cards.map(c => c.card), histories);
        const thresholds = computeThresholds(taskCount);
        this.group = {
            cards,
            queue,
            idx: 0,
            histories,
            thresholds,
            thresholdCursor: 0,
            pendingTasks: [],
            appearanceCounts: new Map(),
            taskCount,
            anchorsForSampling,
        };
    }

    private enqueueDueSentenceTasks(): void {
        if (this.group === null) return;
        const g = this.group;
        // Recompute T lazily: fragility can grow as Again counts accrue.
        const freshT = computeTaskCount(g.cards.map(c => c.card), g.histories);
        if (freshT !== g.taskCount) {
            g.taskCount = freshT;
            g.thresholds = computeThresholds(freshT);
        }
        const p = groupProgress(g.histories);
        const firing = tasksFiring(p, g.thresholds, g.thresholdCursor);
        for (let k = 0; k < firing; k++) {
            const draw = this.drawSentenceWords();
            g.pendingTasks.push(draw);
            for (const w of draw) {
                if (!w.isAnchor) this.bumpAppearance(w.card, +1);
            }
            g.thresholdCursor++;
        }
    }

    private drawSentenceWords(): SentenceWordSelection[] {
        if (this.group === null) return [];
        const g = this.group;
        const eligible: CardLocation[] = g.cards.filter(loc => {
            const h = g.histories.get(loc.card);
            return h !== undefined && isEligibleForSentences(h);
        });
        const faceIndex = resolveFaceIndex(this.opts.cardSide, this.opts.rng);
        return pickSentenceWords({
            eligible,
            histories: g.histories,
            appearanceCounts: g.appearanceCounts,
            anchors: g.anchorsForSampling,
            wordCount: this.opts.wordCount,
            faceIndex,
            rng: this.opts.rng,
        });
    }

    private bumpAppearance(card: ParsedCard, delta: number): void {
        if (this.group === null) return;
        const prev = this.group.appearanceCounts.get(card) ?? 0;
        this.group.appearanceCounts.set(card, Math.max(0, prev + delta));
    }

}

function faceKey(item: LearnItem): string {
    return `${item.filePath}|${item.card.startLine}|${item.faceIndex}`;
}
