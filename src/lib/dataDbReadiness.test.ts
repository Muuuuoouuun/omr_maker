import { describe, expect, it } from "vitest";
import { buildDataDbReadiness } from "./dataDbReadiness";

describe("data DB readiness", () => {
    it("summarizes local-only storage with roster and analytics counts", () => {
        const summary = buildDataDbReadiness({
            syncSources: [{ remoteLoaded: false }],
            examCount: 2,
            attemptCount: 7,
            rosterStudentCount: 12,
            rosterGroupCount: 3,
            tombstones: { students: {}, groups: {} },
        });

        expect(summary).toMatchObject({
            label: "로컬 저장",
            detail: "Supabase 미연결",
            tombstoneCount: 0,
        });
        expect(summary.metrics.map(metric => [metric.key, metric.value])).toEqual([
            ["exams", "2개"],
            ["attempts", "7건"],
            ["roster", "12명"],
            ["deleted_rows", "0개"],
        ]);
        expect(summary.syncSources).toEqual([
            expect.objectContaining({
                key: "source-1",
                label: "저장소 1 로컬 저장",
                tone: "neutral",
                remoteLoaded: false,
                pendingCount: 0,
            }),
        ]);
        expect(summary.checks.map(check => [check.key, check.tone])).toEqual([
            ["storage", "neutral"],
            ["roster", "ready"],
            ["analytics", "ready"],
            ["deletions", "ready"],
            ["production_rls", "warning"],
        ]);
        expect(summary.checks).toContainEqual(expect.objectContaining({
            key: "production_rls",
            label: "실사용 RLS 전환 확인",
            detail: expect.stringContaining("production-rls.sql"),
        }));
    });

    it("surfaces remote errors and pending deletion tombstones", () => {
        const summary = buildDataDbReadiness({
            syncSources: [
                { sourceKey: "exams", sourceLabel: "시험", remoteLoaded: true, remoteSynced: true },
                { sourceKey: "attempts", sourceLabel: "제출", remoteLoaded: false, remoteError: "network failed", pendingSyncCount: 2 },
            ],
            examCount: 1,
            attemptCount: 1,
            rosterStudentCount: 0,
            rosterGroupCount: 0,
            tombstones: {
                students: { "student-1": "2026-06-16T00:00:00.000Z" },
                groups: { "group-1": "2026-06-16T00:00:00.000Z" },
            },
        });

        expect(summary.persistence).toMatchObject({
            kind: "error",
            pendingCount: 2,
            error: "network failed",
        });
        expect(summary.tombstoneCount).toBe(2);
        expect(summary.syncSources).toEqual([
            expect.objectContaining({
                key: "exams",
                label: "시험 원격 동기화",
                tone: "ready",
            }),
            expect.objectContaining({
                key: "attempts",
                label: "제출 확인 필요",
                detail: "network failed · 2건 재시도 대기",
                tone: "error",
                pendingCount: 2,
            }),
        ]);
        expect(summary.checks).toEqual([
            expect.objectContaining({ key: "storage", tone: "error" }),
            expect.objectContaining({ key: "roster", tone: "warning" }),
            expect.objectContaining({ key: "analytics", tone: "ready" }),
            expect.objectContaining({ key: "deletions", tone: "warning" }),
            expect.objectContaining({ key: "production_rls", tone: "warning" }),
        ]);
    });

    it("keeps blank workspaces in a non-error waiting state", () => {
        const summary = buildDataDbReadiness({
            syncSources: [],
            examCount: Number.NaN,
            attemptCount: -1,
            rosterStudentCount: 0,
            rosterGroupCount: 0,
        });

        expect(summary.persistence.kind).toBe("checking");
        expect(summary.syncSources).toEqual([]);
        expect(summary.metrics.map(metric => metric.value)).toEqual(["0개", "0건", "0명", "0개"]);
        expect(summary.checks.map(check => [check.key, check.tone])).toEqual([
            ["storage", "neutral"],
            ["roster", "warning"],
            ["analytics", "neutral"],
            ["deletions", "ready"],
            ["production_rls", "warning"],
        ]);
    });
});
