import { describe, expect, it } from "vitest";
import { composeDepositAppend, normaliseDepositSentence } from "src/utils/deposit-text";

describe("normaliseDepositSentence", () => {
    it("trims and collapses whitespace", () => {
        expect(normaliseDepositSentence("  yo  voy   a casa \n ")).toBe("yo voy a casa");
    });

    it("flattens newlines into a single line", () => {
        expect(normaliseDepositSentence("uno\ndos")).toBe("uno dos");
    });

    it("returns empty for whitespace only input", () => {
        expect(normaliseDepositSentence("   \n\t ")).toBe("");
    });
});

describe("composeDepositAppend", () => {
    it("writes the first line into an empty file", () => {
        expect(composeDepositAppend("", "hola")).toBe("hola\n");
    });

    it("treats a whitespace only file as empty", () => {
        expect(composeDepositAppend("\n\n", "hola")).toBe("hola\n");
    });

    it("appends below existing content that ends with a newline", () => {
        expect(composeDepositAppend("uno\n", "dos")).toBe("uno\ndos\n");
    });

    it("appends below existing content that has no trailing newline", () => {
        expect(composeDepositAppend("uno", "dos")).toBe("uno\ndos\n");
    });

    it("collapses trailing blank lines to one separator", () => {
        expect(composeDepositAppend("uno\n\n\n", "dos")).toBe("uno\ndos\n");
    });

    it("preserves interior blank lines", () => {
        expect(composeDepositAppend("uno\n\ndos\n", "tres")).toBe("uno\n\ndos\ntres\n");
    });

    it("leaves content untouched for a blank sentence", () => {
        expect(composeDepositAppend("uno\n", "   ")).toBe("uno\n");
    });

    it("flattens a multiline sentence into one appended line", () => {
        expect(composeDepositAppend("uno\n", "dos\ntres")).toBe("uno\ndos tres\n");
    });
});
