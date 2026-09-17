import { buildScheduleComment, parseScheduleComment } from "src/persistence/comment-parser";
import type { ScheduleInfo } from "src/persistence/comment-parser";

// types

export interface CardFields {
    word: string;
    explanation: string | null;
    examples: string[];
    type: string | null;      // key from settings.cardTypes, or null (no type set)
    translation: string;
}

export interface ParsedCard {
    fields: CardFields;
    // positional: [front schedule, back schedule]. null means not yet reviewed.
    schedules: [ScheduleInfo | null, ScheduleInfo | null];
    startLine: number;        // 0 based line index of first line in source
    endLine: number;          // 0 based line index of last line (inclusive)
    rawLines: string[];       // raw source lines the card occupies
    originalComment: string | null;   // SR comment found on the last line, or null
}

export type CardSide = "front" | "back";

export interface CardFace {
    side: CardSide;
    prompt: string;
    answer: string;
    schedule: ScheduleInfo | null;
}

export interface CardReveal {
    explanation: string | null;
    examples: string[];
    type: string | null;
}

// card boundary detection

const SR_COMMENT_ANYWHERE_RE = /<!--SR:!.+?-->/;
const SR_COMMENT_TRAILING_RE = /\s*<!--SR:!.+?-->\s*$/;
const SR_ONLY_LINE_RE = /^\s*<!--SR:!.+?-->\s*$/;

// a line continues the current card if, after stripping any trailing SR
// comment, its last non-whitespace characters are "--" or "::".
// en dash (U+2013) and em dash (U+2014) are accepted as equivalents of "--"
// to survive smart-punctuation autocorrect (iOS keyboard, macOS smart dashes,
// Smart Typography plugin) that rewrites consecutive hyphens to a single glyph.
function hasContinuationMarker(line: string): boolean {
    const withoutSR = line.replace(SR_COMMENT_TRAILING_RE, "");
    const trimmed = withoutSR.trimEnd();
    return (
        trimmed.endsWith("--") ||
        trimmed.endsWith("::") ||
        trimmed.endsWith("–") ||
        trimmed.endsWith("—")
    );
}

// a bare SR comment line immediately following the last text line is part of
// the card. this is the preferred write format; legacy inline SR still works.
function isBareSRLine(line: string | undefined): boolean {
    return line !== undefined && SR_ONLY_LINE_RE.test(line);
}

function collectCardLines(
    lines: string[],
    startLine: number,
): { rawLines: string[]; endLine: number } {
    const rawLines: string[] = [];
    let i = startLine;
    while (i < lines.length) {
        const line = lines[i] ?? "";
        rawLines.push(line);
        if (!hasContinuationMarker(line)) break;
        i++;
    }
    // include a following bare SR line as the card's schedule anchor
    if (isBareSRLine(lines[i + 1])) {
        rawLines.push(lines[i + 1] ?? "");
        i++;
    }
    return { rawLines, endLine: i };
}

// tokenisation

type SeparatorKind = "-" | "--" | ":" | "::" | "=";

interface Event {
    sep: SeparatorKind;
    content: string;   // trimmed content that follows this separator
}

interface TokenizedCard {
    word: string;
    events: Event[];
}

// split on `--`, `::`, `-`, `:`, `=` while keeping the separator tokens.
// order in the alternation matters — longer variants first.
// en dash (–, U+2013) and em dash (—, U+2014) are treated as `--` equivalents
// so smart-punctuation autocorrect doesn't break card parsing.
const SEPARATOR_SPLIT_RE = /(--|::|-|:|=|–|—)/;

function tokenize(text: string): TokenizedCard | null {
    const parts = text.split(SEPARATOR_SPLIT_RE);
    if (parts.length < 3) return null;

    const word = (parts[0] ?? "").trim();
    if (!word) return null;

    const events: Event[] = [];
    for (let i = 1; i < parts.length; i += 2) {
        const rawSep = parts[i];
        const content = (parts[i + 1] ?? "").trim();
        if (rawSep === "-" || rawSep === "--" || rawSep === ":" || rawSep === "::" || rawSep === "=") {
            events.push({ sep: rawSep, content });
        } else if (rawSep === "–" || rawSep === "—") {
            events.push({ sep: "--", content });
        }
    }
    return { word, events };
}

function isDashSep(sep: SeparatorKind): boolean {
    return sep === "-" || sep === "--";
}

// field assignment

function assignFields(tokenized: TokenizedCard): CardFields | null {
    const { word, events } = tokenized;
    if (events.length === 0) return null;

    // locate the last dash separator (the translation boundary)
    let lastDashIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
        if (isDashSep(events[i]!.sep)) {
            lastDashIdx = i;
            break;
        }
    }
    if (lastDashIdx === -1) return null;

    const translation = events[lastDashIdx]!.content;
    if (!translation) return null;

    let explanation: string | null = null;
    const examples: string[] = [];
    let type: string | null = null;

    for (let i = 0; i < lastDashIdx; i++) {
        const ev = events[i]!;
        if (isDashSep(ev.sep)) {
            if (explanation !== null) return null;   // more than one explanation is invalid
            if (!ev.content) return null;
            explanation = ev.content;
        } else if (ev.sep === ":" || ev.sep === "::") {
            if (!ev.content) return null;
            examples.push(ev.content);
        } else if (ev.sep === "=") {
            if (type !== null) return null;          // more than one type marker is invalid
            if (!ev.content) return null;
            // unknown type keys are stored as-is and rendered with a neutral colour
            type = ev.content;
        }
    }

    return { word, explanation, examples, type, translation };
}

// SR comment extraction

function extractAndStripComments(rawLines: string[]): { textWithoutSR: string; originalComment: string | null } {
    let originalComment: string | null = null;
    const stripped = rawLines.map((line) => {
        const m = line.match(SR_COMMENT_ANYWHERE_RE);
        if (m) {
            originalComment = m[0];
            return line.replace(SR_COMMENT_ANYWHERE_RE, "").trimEnd();
        }
        return line;
    });
    return { textWithoutSR: stripped.join("\n"), originalComment };
}

function schedulesFromComment(comment: string | null): [ScheduleInfo | null, ScheduleInfo | null] {
    if (comment === null) return [null, null];
    const parsed = parseScheduleComment(comment);
    return [parsed[0] ?? null, parsed[1] ?? null];
}

// public parser

export function parseCard(
    lines: string[],
    startLine: number,
): ParsedCard | null {
    const { rawLines, endLine } = collectCardLines(lines, startLine);
    if (rawLines.length === 0) return null;

    const { textWithoutSR, originalComment } = extractAndStripComments(rawLines);
    const tokenized = tokenize(textWithoutSR);
    if (tokenized === null) return null;

    const fields = assignFields(tokenized);
    if (fields === null) return null;

    const schedules = schedulesFromComment(originalComment);
    return { fields, schedules, startLine, endLine, rawLines, originalComment };
}

// both sided card model

export function frontFace(card: ParsedCard): CardFace {
    return {
        side: "front",
        prompt: card.fields.word,
        answer: card.fields.translation,
        schedule: card.schedules[0],
    };
}

export function backFace(card: ParsedCard): CardFace {
    return {
        side: "back",
        prompt: card.fields.translation,
        answer: card.fields.word,
        schedule: card.schedules[1],
    };
}

export function cardReveal(card: ParsedCard): CardReveal {
    return {
        explanation: card.fields.explanation,
        examples: card.fields.examples,
        type: card.fields.type,
    };
}

// writing back to source

// returns updated rawLines with the SR comment on its own dedicated last line.
// any inline SR on a text line is stripped; any existing bare SR line is replaced.
// result is always [...textLines, srCommentLine] — callers must handle the length change.
export function withUpdatedSchedules(
    card: ParsedCard,
    schedules: [ScheduleInfo | null, ScheduleInfo | null],
    baseEase: number,
): string[] {
    const newComment = buildScheduleComment(schedules, baseEase);

    const textLines: string[] = [];
    for (const line of card.rawLines) {
        // drop lines that were purely an SR comment — the SR is re-emitted below
        if (SR_ONLY_LINE_RE.test(line)) continue;
        // strip any inline SR from mixed text/SR lines
        const stripped = line.replace(SR_COMMENT_TRAILING_RE, "").trimEnd();
        textLines.push(stripped);
    }

    return [...textLines, newComment];
}
