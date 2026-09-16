import { resolve } from "path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
    plugins: [tsconfigPaths()],
    resolve: {
        alias: {
            obsidian: resolve(__dirname, "tests/obsidian-stub.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/main.ts", "src/ui/**", "src/settings/**"],
        },
    },
});
