import { describe, expect, it } from "vitest";
import {
    CORE_ROUTE_PERFORMANCE_BUDGETS,
    evaluateRoutePerformanceBudgets,
} from "./route-performance-budget-core.mjs";

const homeBudget = CORE_ROUTE_PERFORMANCE_BUDGETS["/"];

describe("route performance budget", () => {
    it("covers the heaviest teacher roster and student review routes", () => {
        expect(CORE_ROUTE_PERFORMANCE_BUDGETS).toHaveProperty("/teacher/users");
        expect(CORE_ROUTE_PERFORMANCE_BUDGETS).toHaveProperty("/student/review/[attemptId]");
    });
    it("accepts a complete core route whose raw and compressed bundles stay within budget", () => {
        const result = evaluateRoutePerformanceBudgets(
            [{
                route: "/",
                firstLoadUncompressedJsBytes: homeBudget.maximumUncompressedBytes - 1,
                firstLoadChunkPaths: [".next/static/chunks/home.js"],
            }],
            (path: string) => path.endsWith("home.js") ? Buffer.from("compressible".repeat(100)) : null,
            { "/": homeBudget },
        );

        expect(result).toMatchObject({ passed: true, failures: [] });
        expect(result.routes).toHaveLength(1);
        expect(result.routes[0]).toMatchObject({ route: "/", chunkCount: 1 });
        expect(result.routes[0].compressedBytes).toBeGreaterThan(0);
    });

    it("fails closed for a missing route, oversized raw bundle, oversized compressed bundle, and missing chunk", () => {
        const missingRoute = evaluateRoutePerformanceBudgets([], () => null, { "/": homeBudget });
        expect(missingRoute.failures).toEqual(["missing_route:/"]);

        const oversizedRaw = evaluateRoutePerformanceBudgets([{
            route: "/",
            firstLoadUncompressedJsBytes: homeBudget.maximumUncompressedBytes + 1,
            firstLoadChunkPaths: [".next/static/chunks/home.js"],
        }], () => Buffer.from("ok"), { "/": homeBudget });
        expect(oversizedRaw.failures).toContain("uncompressed_budget:/");

        const oversizedCompressed = evaluateRoutePerformanceBudgets([{
            route: "/",
            firstLoadUncompressedJsBytes: 10,
            firstLoadChunkPaths: [".next/static/chunks/home.js"],
        }], () => Buffer.from(Array.from({ length: homeBudget.maximumCompressedBytes + 1 }, (_, index) => index % 251)), {
            "/": { ...homeBudget, maximumCompressedBytes: 32 },
        });
        expect(oversizedCompressed.failures).toContain("compressed_budget:/");

        const missingChunk = evaluateRoutePerformanceBudgets([{
            route: "/",
            firstLoadUncompressedJsBytes: 10,
            firstLoadChunkPaths: [".next/static/chunks/missing.js"],
        }], () => null, { "/": homeBudget });
        expect(missingChunk.failures).toContain("missing_chunk:/");
    });

    it("rejects duplicate or traversal-like build chunk paths before reading them", () => {
        const stats = [{
            route: "/",
            firstLoadUncompressedJsBytes: 10,
            firstLoadChunkPaths: [
                ".next/static/chunks/home.js",
                ".next/static/chunks/home.js",
                ".next/static/chunks/../../../secret.js",
            ],
        }];
        let reads = 0;
        const result = evaluateRoutePerformanceBudgets(stats, () => {
            reads += 1;
            return Buffer.from("ok");
        }, { "/": homeBudget });

        expect(result.passed).toBe(false);
        expect(result.failures).toContain("invalid_chunks:/");
        expect(reads).toBe(0);
    });
});
