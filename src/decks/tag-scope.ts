// The deck-tag region rule, factored out so a writer cannot drift from what the
// deck tree counts as a card.
//
// A line is in scope once a recognised root deck tag (or a subtag of one) has
// appeared at or above it in the same file. Nothing clears the region, which is
// exactly what `buildDeckTree` does, so an unrecognised tag does not end one.
// Keeping the two identical is the point: the one-time converter must touch
// precisely the lines the plugin already treats as cards, never a superset.
//
// Normalisation is lowercase only, again matching `buildDeckTree`. A root tag is
// stored as the user typed it, leading `#` included (the settings placeholder
// shows `#español`). A root entered without the `#` does not match there either,
// so it must not match here, or the converter would rewrite cards the plugin
// never schedules.

const TAG_RE = /#([\wÀ-ɏ-]+(?:\/[\wÀ-ɏ-]+)*)/gu;

export function normaliseRootTags(rootTags: string[]): string[] {
    return rootTags.map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
}

function tagsOnLine(line: string): string[] {
    TAG_RE.lastIndex = 0;
    const tags: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line)) !== null) tags.push("#" + m[1]);
    return tags;
}

export function tagIsUnderRoot(tag: string, normRoots: string[]): boolean {
    const n = tag.toLowerCase();
    return normRoots.some(r => n === r || n.startsWith(r + "/"));
}

// Per-line in-scope flags for one file's lines.
//
// An empty root list yields all false, so a vault with no configured decks
// converts nothing. That default matters: treating "no roots" as "whole vault"
// is the behaviour this rule exists to remove.
export function computeDeckScope(lines: string[], rootTags: string[]): boolean[] {
    const normRoots = normaliseRootTags(rootTags);
    const flags = new Array<boolean>(lines.length).fill(false);
    if (normRoots.length === 0) return flags;

    let active = false;
    for (let i = 0; i < lines.length; i++) {
        for (const tag of tagsOnLine(lines[i] ?? "")) {
            if (tagIsUnderRoot(tag, normRoots)) {
                active = true;
                break;
            }
        }
        flags[i] = active;
    }
    return flags;
}
