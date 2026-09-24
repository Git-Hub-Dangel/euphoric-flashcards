// Text composition for the sentence deposit feature. Pure so it stays unit
// testable. Every formatting decision about a deposited line lives here, so a
// future prefix or heading format only has to change this file.

/** Collapses a raw input value into a single trimmed line. */
export function normaliseDepositSentence(raw: string): string {
    return raw.replace(/\s+/g, " ").trim();
}

/**
 * Returns the file body with `sentence` appended as its own line. Exactly one
 * newline separates it from the existing content (trailing blank lines are
 * collapsed) and the result always ends with a newline. A blank sentence
 * leaves the content untouched.
 */
export function composeDepositAppend(content: string, sentence: string): string {
    const line = normaliseDepositSentence(sentence);
    if (line === "") return content;
    if (content.trim() === "") return line + "\n";
    return content.replace(/\s+$/, "") + "\n" + line + "\n";
}
