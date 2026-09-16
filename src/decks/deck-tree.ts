import { parseScheduleComment } from "src/persistence/comment-parser";
import { DUMMY_DUE_DATE_FOR_NEW_CARD } from "src/scheduling/constants";

export interface CardLocation {
    filePath: string;
    lineIndex: number;   // 0 based line index in the file
    deckTag: string;     // full tag that owns this card, e.g. "#español/palabras"
}

export interface DeckStats {
    total: number;
    due: number;
    new: number;
}

export interface DeckNode {
    name: string;        // leaf segment, e.g. "palabras"
    fullPath: string;    // slash joined from root, e.g. "español/palabras"
    tag: string;         // canonical tag form, e.g. "#español/palabras"
    stats: DeckStats;
    cards: CardLocation[];
    children: Map<string, DeckNode>;
}

export interface FileLines {
    path: string;
    lines: string[];
}

export interface BuildDeckTreeOptions {
    rootTags: string[];
    today: Date;
}

// helpers

const TAG_RE = /#([\wÀ-ɏ-]+(?:\/[\wÀ-ɏ-]+)*)/gu;
const SR_COMMENT_RE = /<!--SR:!.+?-->/;
const SR_ONLY_LINE_RE = /^\s*<!--SR:!.+?-->\s*$/;

function createNode(name: string, fullPath: string): DeckNode {
    return {
        name,
        fullPath,
        tag: "#" + fullPath,
        stats: { total: 0, due: 0, new: 0 },
        cards: [],
        children: new Map(),
    };
}

function extractTags(line: string): string[] {
    const tags: string[] = [];
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line)) !== null) {
        tags.push("#" + m[1]);
    }
    return tags;
}

function normalise(tag: string): string {
    return tag.toLowerCase();
}

// returns the matching root tag (normalised) if `tag` belongs under any root
function findRoot(tag: string, normalisedRoots: string[]): string | null {
    const n = normalise(tag);
    for (const root of normalisedRoots) {
        if (n === root || n.startsWith(root + "/")) return root;
    }
    return null;
}

function segmentsOf(tag: string): string[] {
    return tag.replace(/^#/, "").split("/");
}

function isSkippableLine(line: string): boolean {
    const t = line.trim();
    if (!t) return true;
    // bare SR comment line (dedicated schedule line, not a card of its own)
    if (SR_ONLY_LINE_RE.test(line)) return true;
    // pure tag lines
    if (/^(#[\wÀ-ɏ-]+(?:\/[\wÀ-ɏ-]+)*\s*)+$/.test(t)) return true;
    // markdown headings
    if (/^#{1,6}\s/.test(t)) return true;
    // code fences and horizontal rules
    if (/^(```|~~~|---+|===+|\*\*\*+)/.test(t)) return true;
    return false;
}

// returns true if the line has no SR schedule comment (so it's new)
function lineIsNew(line: string): boolean {
    return !SR_COMMENT_RE.test(line);
}

// returns true if the line has a schedule comment with at least one side due
function lineIsDue(line: string, todayMidnight: number): boolean {
    const m = SR_COMMENT_RE.exec(line);
    if (!m) return false;
    const schedules = parseScheduleComment(m[0]);
    for (const s of schedules) {
        if (s === null) {
            // this side is "new" per dummy date, so treat as not due but not truly new either
            continue;
        }
        if (s.dueDate.valueOf() <= todayMidnight) return true;
    }
    return false;
}

// tree construction

function ensureNode(root: DeckNode, tag: string, rootNorm: string): DeckNode {
    const rootSegs = segmentsOf(rootNorm);       // ["español"]
    const allSegs = segmentsOf(normalise(tag));  // ["español","2026","palabras"]
    const extra = allSegs.slice(rootSegs.length);

    let node = root;
    let path = root.fullPath;

    for (const seg of extra) {
        path = path + "/" + seg;
        if (!node.children.has(seg)) {
            node.children.set(seg, createNode(seg, path));
        }
        node = node.children.get(seg)!;
    }

    return node;
}

function processFile(
    file: FileLines,
    normalisedRoots: string[],
    roots: Map<string, DeckNode>,
    todayMidnight: number,
): void {
    let activeDeckTag: string | null = null;
    let activeRoot: string | null = null;

    for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? "";
        const tags = extractTags(line);

        // check for a recognised deck tag on this line — last one wins
        let foundDeckTag = false;
        for (const tag of tags) {
            const root = findRoot(tag, normalisedRoots);
            if (root !== null) {
                activeDeckTag = tag;
                activeRoot = root;
                foundDeckTag = true;
            }
        }
        if (foundDeckTag) continue;

        if (activeDeckTag === null || activeRoot === null) continue;
        if (isSkippableLine(line)) continue;

        const node = ensureNode(roots.get(activeRoot)!, activeDeckTag, activeRoot);
        node.cards.push({ filePath: file.path, lineIndex: i, deckTag: activeDeckTag });
        node.stats.total++;

        // SR may live inline on the same text line (legacy) or on the bare line
        // immediately after (current format). peek at both.
        const nextLine = file.lines[i + 1] ?? "";
        const srBearingLine = SR_COMMENT_RE.test(line)
            ? line
            : (SR_ONLY_LINE_RE.test(nextLine) ? nextLine : "");

        if (lineIsNew(srBearingLine)) {
            node.stats.new++;
        } else if (lineIsDue(srBearingLine, todayMidnight)) {
            node.stats.due++;
        }
    }
}

function bubbleStats(node: DeckNode): DeckStats {
    let { total, due } = node.stats;
    let newCards = node.stats.new;

    for (const child of node.children.values()) {
        const cs = bubbleStats(child);
        total += cs.total;
        due += cs.due;
        newCards += cs.new;
    }

    node.stats = { total, due, new: newCards };
    return node.stats;
}

// public API

export function buildDeckTree(
    files: FileLines[],
    options: BuildDeckTreeOptions,
): Map<string, DeckNode> {
    const { rootTags, today } = options;
    const normRoots = rootTags.map(normalise);
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).valueOf();

    const roots = new Map<string, DeckNode>();
    for (const rt of normRoots) {
        const name = rt.replace(/^#/, "");
        roots.set(rt, createNode(name, name));
    }

    for (const file of files) {
        processFile(file, normRoots, roots, todayMidnight);
    }

    for (const root of roots.values()) {
        bubbleStats(root);
    }

    return roots;
}

export function flattenDeckTree(roots: Map<string, DeckNode>): DeckNode[] {
    const result: DeckNode[] = [];
    for (const root of roots.values()) {
        collectNodes(root, result);
    }
    return result;
}

function collectNodes(node: DeckNode, out: DeckNode[]): void {
    out.push(node);
    for (const child of node.children.values()) {
        collectNodes(child, out);
    }
}
