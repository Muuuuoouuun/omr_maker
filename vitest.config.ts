import { defineConfig } from "vitest/config";
import path from "node:path";

const disableNodeWebStorageFlag = "--no-experimental-webstorage";

export default defineConfig({
    test: {
        environment: "node",
        // Unit tests use explicit fixtures, never connected service settings
        // inherited from the host. vi.stubEnv can still override these per test.
        env: {
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
            SUPABASE_URL: "",
            SUPABASE_ANON_KEY: "",
            SUPABASE_PUBLISHABLE_KEY: "",
            SUPABASE_SERVICE_ROLE_KEY: "",
        },
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
