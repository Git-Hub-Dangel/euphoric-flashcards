import { TFile, Vault } from "obsidian";
import { parseCard } from "src/parsing";
import type { ParsedCard } from "src/parsing";
import type { DeckNode, CardLocation } from "src/decks";

const TAG_RE = /#([\wÀ-ɏ-]+(?:\/[\wÀ-ɏ-]+)*)/gu;

function tagsOnLine(line: string): string[] {
    TAG_RE.lastIndex = 0;
    const tags: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(line)) !== null) tags.push("#" + m[1]);
    return tags;
}

function tagMatchesTarget(tag: string, targetTag: string): boolean {
    const n = tag.toLowerCase(), t = targetTag.toLowerCase();
    return n === t || n.startsWith(t + "/");
}

function tagIsRecognised(tag: string, normRoots: string[]): boolean {
    const n = tag.toLowerCase();
    return normRoots.some(r => n === r || n.startsWith(r + "/"));
}

function collectFilePaths(node: DeckNode): string[] {
    const paths = new Set<string>();
    const walk = (n: DeckNode): void => {
        n.cards.forEach((c: CardLocation) => paths.add(c.filePath));
        n.children.forEach(child => walk(child));
    };
    walk(node);
    return [...paths];
}

export interface ReviewCard {
    card: ParsedCard;
    filePath: string;
}

export async function loadCardsForDeck(
    vault: Vault,
    node: DeckNode,
    rootTags: string[],
): Promise<ReviewCard[]> {
    const normRoots = rootTags.map(t => t.toLowerCase());
    const filePaths = collectFilePaths(node);
    const results: ReviewCard[] = [];

    for (const path of filePaths) {
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;

        const content = await vault.read(file);
        const lines = content.split("\n");
        let active = false;
        let i = 0;

        while (i < lines.length) {
            const line = lines[i] ?? "";
            const lineTags = tagsOnLine(line);
            let tagFound = false;

            for (const tag of lineTags) {
                if (tagMatchesTarget(tag, node.tag)) {
                    active = true;
                    tagFound = true;
                } else if (tagIsRecognised(tag, normRoots)) {
                    active = false;
                    tagFound = true;
                }
            }

            if (tagFound) { i++; continue; }
            if (!active) { i++; continue; }

            const card = parseCard(lines, i);
            if (card !== null) {
                results.push({ card, filePath: path });
                i = card.endLine + 1;
            } else {
                i++;
            }
        }
    }

    return results;
}

// Write updated raw lines back to a file, using an in-session cache so
// multiple writes to the same file within one review session stay consistent.
export async function writeCardBack(
    vault: Vault,
    fileCache: Map<string, string>,
    filePath: string,
    card: ParsedCard,
    newRawLines: string[],
): Promise<void> {
    const file = vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return;

    const content = fileCache.get(filePath) ?? await vault.read(file);
    const allLines = content.split("\n");

    allLines.splice(card.startLine, card.endLine - card.startLine + 1, ...newRawLines);
    const newContent = allLines.join("\n");

    fileCache.set(filePath, newContent);
    await vault.modify(file, newContent);
}
