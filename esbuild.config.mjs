import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { mkdirSync, copyFileSync } from "node:fs";
import process from "process";

const prod = process.argv[2] === "production";
const OUT_DIR = "build/euphoric-flashcards";

mkdirSync(OUT_DIR, { recursive: true });

const copyStaticAssets = () => {
    copyFileSync("manifest.json", `${OUT_DIR}/manifest.json`);
    copyFileSync("styles.css", `${OUT_DIR}/styles.css`);
    // Also mirror main.js to the repo root so the marketplace linter (which
    // expects main.js at ., dist/, build/, or out/) can find it.
    copyFileSync(`${OUT_DIR}/main.js`, "main.js");
};

const context = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: `${OUT_DIR}/main.js`,
    loader: { ".css": "text" },
    plugins: [{
        name: "copy-static-assets",
        setup(build) {
            build.onEnd(() => copyStaticAssets());
        },
    }],
});

if (prod) {
    await context.rebuild().catch(() => process.exit(1));
    await context.dispose();
} else {
    await context.watch().catch(() => process.exit(1));
}
