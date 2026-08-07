import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { attemptToSupabaseRow } from "@/lib/omrPersistence";
import {
    listTeacherAttemptSummariesWithGateway,
    listTeacherAttemptsWithGateway,
    type TeacherAttemptGatewayClient,
} from "@/lib/teacherAttemptGateway";
import type { Attempt } from "@/types/omr";

// Regression: ISSUE-CAPACITY-001 — the 2,001st organization attempt blanked every teacher read.
// Found by /qa on 2026-08-07.
// Report: docs/initial-ops-user-journey-audit-2026-08-07.md

const baseAttempt: Attempt = {
    id: "attempt-00000",
    examId: "exam-1",
    examTitle: "시험",
    organizationId: "org-a",
    studentName: "학생",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:01:00.000Z",
    score: 1,
    totalScore: 1,
    answers: { 1: 2 },
    status: "completed",
};

function attemptListRow(item: Attempt) {
    const row = { ...attemptToSupabaseRow(item) };
    Reflect.deleteProperty(row, "payload");
    return {
        ...row,
        exam_title: item.examTitle,
        answers: item.answers,
    };
}

function clientWithNewestRows(
    rows: ReturnType<typeof attemptListRow>[],
    serverMaxRows = Number.POSITIVE_INFINITY,
) {
    const limits: number[] = [];
    const ranges: Array<[number, number]> = [];
    const orders: Array<[string, { ascending: boolean }]> = [];
    const client = {
        from() {
            const query = {
                eq() { return query; },
                gt() { return query; },
                order(column: string, options: { ascending: boolean }) {
                    orders.push([column, options]);
                    return query;
                },
                async limit(value: number) {
                    limits.push(value);
                    return {
                        data: [...rows]
                            .sort((left, right) => right.finished_at.localeCompare(left.finished_at)
                                || right.id.localeCompare(left.id))
                            .slice(0, Math.min(value, serverMaxRows)),
                        error: null,
                    };
                },
                async range(from: number, to: number) {
                    ranges.push([from, to]);
                    return {
                        data: [...rows]
                            .sort((left, right) => right.finished_at.localeCompare(left.finished_at)
                                || right.id.localeCompare(left.id))
                            .slice(from, Math.min(to + 1, from + serverMaxRows)),
                        error: null,
                    };
                },
            };
            return { select: () => query };
        },
    } as unknown as TeacherAttemptGatewayClient;
    return { client, limits, ranges, orders };
}

function rows(count: number) {
    return Array.from({ length: count }, (_, index) => attemptListRow({
        ...baseAttempt,
        id: `attempt-${String(index).padStart(5, "0")}`,
        finishedAt: new Date(Date.parse(baseAttempt.finishedAt) + index * 1_000).toISOString(),
    }));
}

describe("teacher attempt capacity fail-soft page", () => {
    it("marks exactly 2,000 attempts as a complete bounded page", async () => {
        const fixture = clientWithNewestRows(rows(INITIAL_OPERATIONS_LIMITS.teacherAttempts));

        await expect(listTeacherAttemptsWithGateway(fixture.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({
            status: "loaded",
            attempts: { length: INITIAL_OPERATIONS_LIMITS.teacherAttempts },
            page: { partial: false, hasMore: false },
        });

        expect(fixture.limits).toEqual([]);
        expect(fixture.ranges).toHaveLength(9);
        expect(fixture.ranges[0]).toEqual([0, INITIAL_OPERATIONS_LIMITS.listPageSize - 1]);
        expect(fixture.ranges.at(-1)).toEqual([
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
        ]);
    });

    it.each([
        ["full", listTeacherAttemptsWithGateway],
        ["summary", listTeacherAttemptSummariesWithGateway],
    ] as const)("keeps the newest 2,000 %s rows and marks the 2,001st as partial", async (_kind, list) => {
        const fixture = clientWithNewestRows(rows(INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1));

        const result = await list(fixture.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });

        expect(result).toMatchObject({
            status: "loaded",
            attempts: { length: INITIAL_OPERATIONS_LIMITS.teacherAttempts },
            page: {
                partial: true,
                hasMore: true,
                itemCount: INITIAL_OPERATIONS_LIMITS.teacherAttempts,
                nextCursor: {
                    id: "attempt-00001",
                    finishedAt: new Date(Date.parse(baseAttempt.finishedAt) + 1_000).toISOString(),
                },
            },
        });
        if (result.status === "loaded") {
            expect(result.attempts[0]?.id).toBe("attempt-02000");
            expect(result.attempts.at(-1)?.id).toBe("attempt-00001");
            expect(result.attempts.some(item => item.id === "attempt-00000")).toBe(false);
        }
        expect(fixture.limits).toEqual([]);
        expect(fixture.ranges).toHaveLength(9);
        expect(fixture.ranges.at(-1)).toEqual([
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
        ]);
        expect(fixture.orders.slice(0, 2)).toEqual([
            ["finished_at", { ascending: false }],
            ["id", { ascending: false }],
        ]);
    });

    it("keeps the database boundary cursor stable when many rows share a finish timestamp", async () => {
        const sameTimeRows = Array.from(
            { length: INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1 },
            (_, index) => attemptListRow({
                ...baseAttempt,
                id: `attempt-${String(index).padStart(5, "0")}`,
            }),
        );
        const fixture = clientWithNewestRows(sameTimeRows);

        const result = await listTeacherAttemptSummariesWithGateway(fixture.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });

        expect(result).toMatchObject({
            status: "loaded",
            page: {
                partial: true,
                nextCursor: {
                    finishedAt: baseAttempt.finishedAt,
                    id: "attempt-00001",
                },
            },
        });
    });

    it("does not mistake a hosted max_rows truncation for a complete attempt list", async () => {
        const fixture = clientWithNewestRows(
            rows(INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1),
            INITIAL_OPERATIONS_LIMITS.listPageSize,
        );

        const result = await listTeacherAttemptSummariesWithGateway(fixture.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });

        expect(result).toMatchObject({
            status: "loaded",
            attempts: { length: INITIAL_OPERATIONS_LIMITS.teacherAttempts },
            page: { partial: true, hasMore: true },
        });
        expect(fixture.ranges.at(-1)).toEqual([
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
        ]);
    });
});
