import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
    CORE_ROUTE_PERFORMANCE_BUDGETS,
    evaluateRoutePerformanceBudgets,
} from "./route-performance-budget-core.mjs";

const root = process.cwd();
const diagnosticsPath = resolve(root, ".next/diagnostics/route-bundle-stats.json");
const chunksRoot = `${resolve(root, ".next/static/chunks")}${sep}`;

function readBoundedJson(path) {
    const size = statSync(path).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 * 1024) {
        throw new Error("Route performance diagnostics are invalid");
    }
    return JSON.parse(readFileSync(path, "utf8"));
}

try {
    const routeStats = readBoundedJson(diagnosticsPath);
    const result = evaluateRoutePerformanceBudgets(routeStats, chunkPath => {
        const absolute = resolve(root, chunkPath);
        if (!absolute.startsWith(chunksRoot)) return null;
        try {
            return readFileSync(absolute);
        } catch {
            return null;
        }
    }, CORE_ROUTE_PERFORMANCE_BUDGETS);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
} catch {
    process.stdout.write(`${JSON.stringify({ passed: false, failures: ["invalid_build_diagnostics"] })}\n`);
    process.exitCode = 1;
}
