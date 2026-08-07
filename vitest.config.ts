import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        environment: "node",
        globals: false,
        include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
            "next/dist/compiled/server-only": path.resolve(
                __dirname,
                "./node_modules/next/dist/compiled/server-only/empty.js",
            ),
        },
    },
});
