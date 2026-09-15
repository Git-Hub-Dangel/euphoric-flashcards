# Euphoric Flashcards

An Obsidian spaced-repetition plugin: tag-based decks, structured card syntax, both-sided cards, SM-2-OSR scheduling, and a Sentence Builder mode for language learning.

## Card syntax
```
word - translation
word - explanation - translation
word - explanation :: example :: example =n - translation
```
`word` and `translation` required; `explanation`, `examples` (`:` / `::`), `type` (`=key`) optional. `-` / `:` = single-line; `--` / `::` at end-of-line = multi-line continuation. Type keys come from **Settings → Card types**.

## Decks
Register root tags in **Settings → Decks** (e.g. `#español`). Any tag under a root is a deck; `/` nests (`#español/2026/palabras`). Cards belong to the nearest recognised tag above them until the next one.

## Review modes
- **Review** — due-only, Again / Okay / Good, writes schedules.
- **Cram** — all cards, no schedule changes.
- **Sentence Builder** — N words from any deck, reveal per word; no schedule changes.

## Building
```sh
npm install
npm run build       # tsc --noEmit + esbuild → build/euphoric-flashcards/
npm run dev         # esbuild watch → build/euphoric-flashcards/
npm test            # vitest (89 tests)
```
Output goes to `build/euphoric-flashcards/` (`main.js`, `manifest.json`, `styles.css`). To install, drop that folder into `<vault>/.obsidian/plugins/` and enable in Obsidian.

## Layout
- `src/scheduling/` — SM-2-OSR algorithm
- `src/persistence/` — `<!--SR:...-->` comment parser (positional both-sided segments)
- `src/decks/` — tag-based deck tree
- `src/parsing/` — card syntax parser
- `src/ui/` — Explorer, Review, Sentence Builder modals
- `src/settings/` — types, defaults, settings tab
