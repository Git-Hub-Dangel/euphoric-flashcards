import { buildScheduleComment } from "src/persistence/comment-parser";
import { DUMMY_DUE_DATE_FOR_NEW_CARD, PREFERRED_DATE_FORMAT, TICKS_PER_DAY } from "src/scheduling/constants";
import { formatDate, parseLegacyDate } from "src/scheduling/dates";
import { State } from "src/scheduling/fsrs";
import type { ScheduleInfo } from "src/scheduling/fsrs";
import { computeDeckRegions } from "src/decks/tag-scope";

// The one-time SM-2 to FSRS converter (FSRS plan §B5, Phase 5).
//
// This is the only legacy reader left in the plugin. The runtime parser in
// src/persistence/comment-parser.ts is FSRS-only on purpose: a pre-FSRS comment
// reads as null there rather than being half-understood, which is what makes an
// unconverted vault show its cards as neither new nor due. Everything needed to
// read the old shape lives here instead, so there is no dual-format path in the
// hot code.
//
// Obsidian-free, like the other migration code, so the seeding rules are unit
// testable without a vault. The vault walk lives in convert-vault.ts.

// The legacy on-disk format, two shapes of it:
//
//   upstream OSR, one segment   <!--SR:!2024-01-02,25,249-->
//   Euphoric, two segments      <!--SR:!2026-09-26,5,203!2026-09-30,6,223-->
//
// Three fields per segment, positional: due, interval (days), ease (percent).
// The wrapper, the `!` segment delimiter and the `,` field delimiter are the
// same as the FSRS format, which is exactly why the field count is the only
// reliable way to tell the two apart.
const LEGACY_FIELDS_PER_SEGMENT = 3;
const FSRS_FIELDS_PER_SEGMENT = 7;

// SM-2 ease, as a percent. 250 was the plugin's own baseEase default and is the
// fallback for a segment whose ease field is missing or unreadable.
const LEGACY_EASE_MIN = 130;
const LEGACY_EASE_MAX = 350;
const LEGACY_DEFAULT_EASE = 250;

// FSRS difficulty runs 1 (easiest) to 10 (hardest), the opposite direction to
// ease. The map is linear across the ease range, so 130 becomes 10 and 350
// becomes 1 (plan §B5).
const DIFFICULTY_AT_EASE_MIN = 10;
const DIFFICULTY_AT_EASE_MAX = 1;

export const SR_COMMENT_PATTERN = /<!--SR:!.+?-->/g;

export type SegmentKind = "legacy" | "fsrs" | "malformed";

export interface LegacySegment {
    due: Date;
    interval: number;
    ease: number;
}

// ⚠️ Polarity. Low ease meant a card the user kept getting wrong; high
// difficulty means the same thing. The map therefore runs downhill, and getting
// it backwards would hand every struggling card the difficulty of an easy one
// with nothing to flag it. Asserted at both boundaries.
export function difficultyFromEase(ease: number): number {
    const usable = Number.isFinite(ease) ? ease : LEGACY_DEFAULT_EASE;
    const clamped = Math.min(LEGACY_EASE_MAX, Math.max(LEGACY_EASE_MIN, usable));
    const t = (clamped - LEGACY_EASE_MIN) / (LEGACY_EASE_MAX - LEGACY_EASE_MIN);
    const d = DIFFICULTY_AT_EASE_MIN + t * (DIFFICULTY_AT_EASE_MAX - DIFFICULTY_AT_EASE_MIN);
    return Math.round(d * 10000) / 10000;
}

// How many fields a segment carries, which is what identifies its format.
export function classifySegment(segment: string): SegmentKind {
    const fields = segment.split(",");
    if (fields.length >= FSRS_FIELDS_PER_SEGMENT) return "fsrs";
    if (fields.length === LEGACY_FIELDS_PER_SEGMENT) return "legacy";
    return "malformed";
}

// Read one legacy segment. Dates go through parseLegacyDate because a 1.4.1
// vault can hold any of the three ALLOWED_DATE_FORMATS shapes; that tolerance
// was kept in dates.ts for this function specifically.
//
// Returns null for the dummy date, which is how the old format spelled "this
// face has never been reviewed". The caller turns that into a New face.
export function parseLegacySegment(segment: string): LegacySegment | null {
    const fields = segment.split(",");
    const due = parseLegacyDate(fields[0] ?? "");
    if (due === null) return null;
    if (formatDate(due.valueOf(), PREFERRED_DATE_FORMAT) === DUMMY_DUE_DATE_FOR_NEW_CARD) return null;

    const interval = parseFloat(fields[1] ?? "");
    const ease = parseFloat(fields[2] ?? "");
    return {
        due,
        interval: Number.isFinite(interval) ? Math.max(0, interval) : 0,
        ease: Number.isFinite(ease) ? ease : LEGACY_DEFAULT_EASE,
    };
}

// Seed an FSRS face from a legacy one (plan §B5).
//
// stability = interval, with **no floor**. A card sitting at interval 1 migrates
// as genuinely low-retention, and a lapsed card at interval 0 migrates with
// stability 0, which FSRS reads as retrievability 0 and therefore maximum
// urgency. Both are intended. Inflating stability to make a converted deck look
// healthier would be a lie the user then has to review their way out of.
//
// reps and lapses are **lost**, not guessed: SM-2 never recorded them. This is
// the one documented data loss in the conversion.
export function seedFromLegacy(legacy: LegacySegment): ScheduleInfo {
    // Whole days, because invariant 40 requires both stored dates to be calendar
    // dates. The interval itself may be fractional and keeps its precision in
    // stability; only the date arithmetic is rounded.
    const wholeDays = Math.round(legacy.interval);
    return {
        due: legacy.due,
        stability: legacy.interval,
        difficulty: difficultyFromEase(legacy.ease),
        reps: 0,
        lapses: 0,
        state: State.Review,
        last_review: new Date(legacy.due.valueOf() - wholeDays * TICKS_PER_DAY),
    };
}

export type CommentStatus = "converted" | "already-fsrs" | "malformed";

export interface CommentResult {
    status: CommentStatus;
    // The replacement comment, present only when status is "converted".
    comment: string | null;
    // How many faces carried a real legacy schedule and were seeded.
    seededFaces: number;
}

// Convert one SR comment. Splitting matches parseScheduleComment exactly so the
// two readers cannot disagree about where a segment begins.
//
// A comment is only rewritten when at least one segment is legacy. One that is
// already FSRS comes back as "already-fsrs" with no replacement, which is what
// makes a second run a no-op (plan §P5.7).
export function convertComment(comment: string): CommentResult {
    const inner = comment.replace(/^<!--SR:/, "").replace(/-->$/, "");
    const segments = inner
        .split("!")
        .map(s => s.trim())
        .filter(s => s.length > 0);

    if (segments.length === 0) return { status: "malformed", comment: null, seededFaces: 0 };

    const kinds = segments.map(classifySegment);
    if (kinds.some(k => k === "malformed")) {
        return { status: "malformed", comment: null, seededFaces: 0 };
    }
    if (kinds.every(k => k === "fsrs")) {
        return { status: "already-fsrs", comment: null, seededFaces: 0 };
    }
    // A mixed comment (one face already converted, one not) cannot be produced
    // by either version of the plugin, so it is treated as damage rather than
    // half-converted in place.
    if (kinds.some(k => k === "fsrs")) {
        return { status: "malformed", comment: null, seededFaces: 0 };
    }

    let seededFaces = 0;
    // Positional and padded to two: front is segment 0, back is segment 1. The
    // upstream single-segment shape seeds the front and leaves the back New.
    const schedules: (ScheduleInfo | null)[] = [null, null];
    for (let i = 0; i < Math.min(2, segments.length); i++) {
        const legacy = parseLegacySegment(segments[i] ?? "");
        if (legacy === null) continue;
        schedules[i] = seedFromLegacy(legacy);
        seededFaces++;
    }

    return {
        status: "converted",
        comment: buildScheduleComment(schedules),
        seededFaces,
    };
}

export interface ContentResult {
    content: string;
    commentsConverted: number;
    facesSeeded: number;
    alreadyFsrs: number;
    malformed: number;
    // True when the note holds at least one line inside a configured deck. Lets
    // the vault walk report a denominator of notes it actually considered.
    inScope: boolean;
    // Cards converted per deck tag, as the user wrote the tag. Feeds the
    // confirmation dialog, which lists the decks a run would touch.
    deckCounts: Record<string, number>;
}

// Rewrite the legacy SR comments inside one note's deck regions.
//
// A pure textual substitution, deliberately not a parseCard round trip: it
// touches only the inside of the comment, so a note's line count cannot change
// and none of the shiftLocationsForDelta machinery is involved. It also means a
// comment the card parser would reject for unrelated reasons still gets its
// schedule converted.
// Scoped to the configured root deck tags, never the whole note.
//
// A note can hold plugin decks and unrelated content side by side, and an
// `<!--SR:!...-->` comment is not proof that a line belongs to this plugin. So
// only lines inside an active deck region are rewritten (see computeDeckScope).
// Everything else is returned byte for byte, and the counters ignore it too, so
// a dry run reports the same scope the real run will write.
//
// Splitting on "\n" and rejoining on "\n" is lossless for CRLF notes, because a
// trailing "\r" stays attached to its line.
export function convertContent(content: string, rootTags: string[]): ContentResult {
    let commentsConverted = 0;
    let facesSeeded = 0;
    let alreadyFsrs = 0;
    let malformed = 0;

    const lines = content.split("\n");
    const regions = computeDeckRegions(lines, rootTags);
    const deckCounts: Record<string, number> = {};

    const converted = lines.map((line, i) => {
        const deck = regions[i];
        if (deck === undefined || deck === null) return line;
        return line.replace(SR_COMMENT_PATTERN, (match) => {
            const result = convertComment(match);
            if (result.status === "already-fsrs") {
                alreadyFsrs++;
                return match;
            }
            if (result.status === "malformed" || result.comment === null) {
                malformed++;
                return match;
            }
            commentsConverted++;
            facesSeeded += result.seededFaces;
            deckCounts[deck] = (deckCounts[deck] ?? 0) + 1;
            return result.comment;
        });
    });

    return {
        content: converted.join("\n"),
        commentsConverted,
        facesSeeded,
        alreadyFsrs,
        malformed,
        inScope: regions.some(tag => tag !== null),
        deckCounts,
    };
}
