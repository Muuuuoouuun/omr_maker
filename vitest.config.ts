import { defineConfig } from "vitest/config";
import path from "node:path";

const disableNodeWebStorageFlag = "--no-experimental-webstorage";

export default defineConfig({
    test: {
        environment: "node",
        globals: false,
        include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
        // Node 25 exposes a process-level localStorage object that can shadow
        // jsdom's complete Storage implementation inside Vitest workers.
        execArgv: process.allowedNodeEnvironmentFlags.has(disableNodeWebStorageFlag)
            ? [disableNodeWebStorageFlag]
            : [],
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
