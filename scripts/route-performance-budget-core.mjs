import { gzipSync } from "node:zlib";

/**
 * @typedef {{ maximumUncompressedBytes: number; maximumCompressedBytes: number }} RoutePerformanceBudget
 */

/** @type {Readonly<Record<string, Readonly<RoutePerformanceBudget>>>} */
export const CORE_ROUTE_PERFORMANCE_BUDGETS = Object.freeze({
    "/": Object.freeze({ maximumUncompressedBytes: 780_000, maximumCompressedBytes: 240_000 }),
    "/student/dashboard": Object.freeze({ maximumUncompressedBytes: 790_000, maximumCompressedBytes: 240_000 }),
    "/solve/[id]": Object.freeze({ maximumUncompressedBytes: 880_000, maximumCompressedBytes: 270_000 }),
    "/create": Object.freeze({ maximumUncompressedBytes: 940_000, maximumCompressedBytes: 290_000 }),
    "/teacher/dashboard": Object.freeze({ maximumUncompressedBytes: 930_000, maximumCompressedBytes: 285_000 }),
    "/teacher/live": Object.freeze({ maximumUncompressedBytes: 870_000, maximumCompressedBytes: 265_000 }),
    "/teacher/users": Object.freeze({ maximumUncompressedBytes: 1_010_000, maximumCompressedBytes: 310_000 }),
    "/student/review/[attemptId]": Object.freeze({ maximumUncompressedBytes: 840_000, maximumCompressedBytes: 260_000 }),
});

function validBudget(value) {
    return value
        && Number.isSafeInteger(value.maximumUncompressedBytes)
        && value.maximumUncompressedBytes > 0
        && Number.isSafeInteger(value.maximumCompressedBytes)
        && value.maximumCompressedBytes > 0;
}

function validChunkPaths(paths) {
    if (!Array.isArray(paths) || paths.length === 0 || new Set(paths).size !== paths.length) return false;
    return paths.every(path => (
        typeof path === "string"
        && /^\.next\/static\/chunks\/[a-zA-Z0-9_./-]+\.js$/.test(path)
        && !path.split("/").includes("..")
    ));
}

/**
 * @param {unknown[]} routeStats
 * @param {(path: string) => Buffer | null} readChunk
 * @param {Readonly<Record<string, Readonly<RoutePerformanceBudget>>>} budgets
 */
export function evaluateRoutePerformanceBudgets(
    routeStats,
    readChunk,
    budgets = CORE_ROUTE_PERFORMANCE_BUDGETS,
) {
    if (!Array.isArray(routeStats) || typeof readChunk !== "function" || !budgets || typeof budgets !== "object") {
        throw new Error("Route performance budget input is invalid");
    }

    const failures = [];
    const routes = [];
    const statsByRoute = new Map();
    for (const stat of routeStats) {
        if (!stat || typeof stat.route !== "string" || statsByRoute.has(stat.route)) continue;
        statsByRoute.set(stat.route, stat);
    }

    for (const [route, budget] of Object.entries(budgets)) {
        if (!validBudget(budget)) throw new Error("Route performance budget configuration is invalid");
        const stat = statsByRoute.get(route);
        if (!stat) {
            failures.push(`missing_route:${route}`);
            continue;
        }
        if (!validChunkPaths(stat.firstLoadChunkPaths)) {
            failures.push(`invalid_chunks:${route}`);
            continue;
        }

        let compressedBytes = 0;
        let missingChunk = false;
        for (const chunkPath of stat.firstLoadChunkPaths) {
            const bytes = readChunk(chunkPath);
            if (!Buffer.isBuffer(bytes)) {
                missingChunk = true;
                break;
            }
            compressedBytes += gzipSync(bytes, { level: 9 }).byteLength;
        }

        const uncompressedBytes = stat.firstLoadUncompressedJsBytes;
        if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 0) {
            failures.push(`invalid_stats:${route}`);
        } else if (uncompressedBytes > budget.maximumUncompressedBytes) {
            failures.push(`uncompressed_budget:${route}`);
        }
        if (missingChunk) {
            failures.push(`missing_chunk:${route}`);
        } else if (compressedBytes > budget.maximumCompressedBytes) {
            failures.push(`compressed_budget:${route}`);
        }
        routes.push({
            route,
            uncompressedBytes,
            compressedBytes: missingChunk ? null : compressedBytes,
            chunkCount: stat.firstLoadChunkPaths.length,
            budget,
        });
    }

    return Object.freeze({ passed: failures.length === 0, failures, routes });
}
