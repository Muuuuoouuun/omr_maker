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
    const orders: Array<[string, { ascending: boolean }]> = [];
    const client = {
        from() {
            let cursorId: string | undefined;
            const query = {
                eq() { return query; },
                gt() { return query; },
                or(filter: string) {
                    cursorId = /id\.lt\."([^"]+)"/.exec(filter)?.[1];
                    return query;
                },
                order(column: string, options: { ascending: boolean }) {
                    orders.push([column, options]);
                    return query;
                },
                async limit(value: number) {
                    limits.push(value);
                    const orderedRows = [...rows]
                        .sort((left, right) => right.finished_at.localeCompare(left.finished_at)
                            || right.id.localeCompare(left.id));
                    const start = cursorId
                        ? Math.max(0, orderedRows.findIndex(row => row.id === cursorId) + 1)
                        : 0;
                    return {
                        data: orderedRows.slice(start, start + Math.min(value, serverMaxRows)),
                        error: null,
                    };
                },
            };
            return { select: () => query };
        },
    } as unknown as TeacherAttemptGatewayClient;
    return { client, limits, orders };
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

        expect(fixture.limits).toHaveLength(9);
        expect(fixture.limits[0]).toBe(INITIAL_OPERATIONS_LIMITS.listPageSize);
    });

    it.each([
        ["full", listTeacherAttemptsWithGateway],
        ["summary", listTeacherAttemptSummariesWithGateway],
    ] as const)("rejects an incomplete %s collection at the 2,001st row", async (_kind, list) => {
        const fixture = clientWithNewestRows(rows(INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1));

        const result = await list(fixture.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });
        expect(result).toEqual({
            status: "service_unavailable",
            error: "Incomplete canonical attempt collection",
        });
        expect(fixture.limits).toHaveLength(9);
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

        expect(result).toEqual({
            status: "service_unavailable",
            error: "Incomplete canonical attempt collection",
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

        expect(result).toEqual({
            status: "service_unavailable",
            error: "Incomplete canonical attempt collection",
        });
        expect(fixture.limits).toHaveLength(9);
    });
});
