import { describe, expect, it } from "vitest";
import { preferLocalDashboardItems } from "./teacherDashboardLoad";

describe("teacher dashboard load fallback", () => {
    const cached = [{ id: "cached" }];

    it("preserves cached items when the canonical read reports an error", () => {
        expect(preferLocalDashboardItems({ items: [], remoteError: "offline" }, cached)).toEqual(cached);
    });

    it("accepts an authoritative empty canonical response", () => {
        expect(preferLocalDashboardItems({ items: [] }, cached)).toEqual([]);
    });

    it("uses successfully loaded canonical items", () => {
        const remote = [{ id: "remote" }];
        expect(preferLocalDashboardItems({ items: remote }, cached)).toEqual(remote);
    });

    it("keeps a usable stale or partial snapshot visible while a newer generation retries", async () => {
        const dashboardLoad = await import("./teacherDashboardLoad");
        const beginRetry = (dashboardLoad as typeof dashboardLoad & {
            beginDashboardDetailBackgroundRetry?: <T>(input: {
                generation: number;
                snapshot: { generation: number; items: T[]; sampleStatus: "ready" | "partial" | "stale" } | null;
            }) => unknown;
        }).beginDashboardDetailBackgroundRetry;

        expect(beginRetry).toBeTypeOf("function");
        if (!beginRetry) return;
        expect(beginRetry({
            generation: 4,
            snapshot: { generation: 4, items: cached, sampleStatus: "partial" },
        })).toEqual({
            generation: 5,
            items: cached,
            loadStatus: "ready",
            sampleStatus: "partial",
        });
    });

    it("keeps cached rows with a stale warning when a matching retry generation fails", async () => {
        const dashboardLoad = await import("./teacherDashboardLoad");
        const resolveFailure = (dashboardLoad as typeof dashboardLoad & {
            resolveDashboardDetailRetryFailure?: <T>(input: {
                requestedGeneration: number;
                currentGeneration: number;
                snapshot: { generation: number; items: T[]; sampleStatus: "ready" | "partial" | "stale" } | null;
                message: string;
            }) => unknown;
        }).resolveDashboardDetailRetryFailure;

        expect(resolveFailure).toBeTypeOf("function");
        if (!resolveFailure) return;
        expect(resolveFailure({
            requestedGeneration: 5,
            currentGeneration: 5,
            snapshot: { generation: 4, items: cached, sampleStatus: "partial" },
            message: "offline",
        })).toEqual({
            kind: "cached",
            items: cached,
            loadStatus: "ready",
            sampleStatus: "stale",
            warning: "offline",
        });
    });

    it("ignores retry failures from an obsolete generation", async () => {
        const dashboardLoad = await import("./teacherDashboardLoad");
        const resolveFailure = (dashboardLoad as typeof dashboardLoad & {
            resolveDashboardDetailRetryFailure?: (input: {
                requestedGeneration: number;
                currentGeneration: number;
                snapshot: null;
                message: string;
            }) => unknown;
        }).resolveDashboardDetailRetryFailure;

        expect(resolveFailure).toBeTypeOf("function");
        if (!resolveFailure) return;
        expect(resolveFailure({
            requestedGeneration: 4,
            currentGeneration: 5,
            snapshot: null,
            message: "late failure",
        })).toEqual({ kind: "obsolete" });
    });
});
