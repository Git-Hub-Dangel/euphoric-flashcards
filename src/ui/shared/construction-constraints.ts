import type { EuphoricSettings } from "src/settings";

// Prefix-on-slash matching: a binding on "espanol" fires for "espanol" and
// every "espanol/..." subdeck but not for "espanolito". Multiple collections
// binding the same deck tag stack (their labels are unioned).
export function buildConstructionConstraintPool(
    settings: EuphoricSettings,
    selectionDeckTag: string,
): string[] {
    if (!settings.enableConstructionConstraints) return [];
    const target = selectionDeckTag.replace(/^#/, "").toLowerCase();
    const pool: string[] = [];
    for (const cc of settings.constructionConstraints) {
        const match = cc.deckTags.some(t => {
            const bound = t.replace(/^#/, "").toLowerCase();
            if (bound.length === 0) return false;
            return target === bound || target.startsWith(bound + "/");
        });
        if (match) pool.push(...cc.labels);
    }
    return pool;
}
