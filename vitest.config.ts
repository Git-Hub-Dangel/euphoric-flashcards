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
        // Pinned so day-boundary and DST behaviour is deterministic rather than a
        // property of the machine running the suite. Europe/Berlin observes DST,
        // so the spring-forward regression in day-boundary.test.ts can assert.
        env: { TZ: "Europe/Berlin" },
        include: ["src/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/main.ts", "src/ui/**", "src/settings/**"],
        },
    },
});
