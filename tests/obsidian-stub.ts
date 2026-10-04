// Stub for the "obsidian" module, aliased in vitest.config.ts. It is
// deliberately empty. Every module reachable from a test imports obsidian
// type-only (histogram-store.ts, convert-vault.ts), and a type-only import is
// erased before runtime, so there is nothing left to stand in for. The file and
// its alias stay because the alias is what stops a real resolution attempt.
//
// Do not grow this into a partial Obsidian. When a rule inside a Plugin or a
// Modal needs testing, extract it into a pure module the way plugin-data.ts
// holds the migration runner and hydratePluginData.
export {};
