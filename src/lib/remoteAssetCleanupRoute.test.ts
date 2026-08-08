import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("remote asset cleanup cron route", () => {
    it("ships a daily Vercel schedule whose bounded drain exceeds the admitted orphan budget", () => {
        const route = readFileSync(resolve(process.cwd(), "src/app/api/internal/asset-gc/route.ts"), "utf8");
        const config = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
            crons?: Array<{ path?: string; schedule?: string }>;
        };
        expect(config.crons).toContainEqual({
            path: "/api/internal/asset-gc",
            schedule: "17 3 * * *",
        });
        expect(route).toContain("authorizeRemoteAssetCleanupRequest");
        expect(route).toContain("drainRemoteAssetCleanupWithGateway");
        expect(route).toContain("batchSize: 25");
        expect(route).toContain("maxBatches: 4");
        expect(route).toContain("deadlineAtMs");
        expect(route).toContain("minimumBatchBudgetMs");
        expect(route).toContain("reportOperationalHeartbeat");
        expect(route).toContain("recordOperationalJobStatus");
        expect(route).toContain("reportServerError");
        expect(route).toContain("observability:");
        expect(route).toContain("result.failed > 0");
        expect(route).toMatch(/backendTimeoutMs:\s*Math\.min\(config\.backendTimeoutMs,\s*10_000\)/);
        expect(route).toContain("Cache-Control");
        expect(route).not.toContain("error.message");
    });
});
