import { describe, expect, it } from "vitest";
import {
    aggregateTeacherAttemptsWithGateway,
    exportTeacherAttemptDatasetWithGateway,
    exportTeacherAttemptPageWithGateway,
    type TeacherAttemptReportingClient,
} from "./teacherAttemptReportingGateway";

const context = {
    organizationId: "org-a",
    organizationName: "Org A",
};

function clientReturning(data: unknown, calls: Array<{ name: string; args: Record<string, unknown> }> = []) {
    return {
        calls,
        client: {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return { data, error: null };
            },
        } as TeacherAttemptReportingClient,
    };
}

describe("teacher attempt reporting gateway", () => {
    it("loads aggregate and rows from one bounded atomic export RPC", async () => {
        const projection = {
            attempt_id: "attempt-a",
            exam_id: "exam-1",
            student_scope_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            status: "completed",
            score_percent: "80",
            is_retake: false,
            handwriting_archived: false,
            handwriting_question_count: "0",
            handwriting_stroke_count: "0",
            started_at: "2026-08-07T00:00:00.000Z",
            finished_at: "2026-08-07T00:10:00.000Z",
        };
        const { client, calls } = clientReturning({
            status: "loaded",
            aggregate: {
                total_attempt_count: "1",
                completed_attempt_count: "1",
                in_progress_attempt_count: "0",
                base_attempt_count: "1",
                completed_base_attempt_count: "1",
                distinct_student_count: "1",
                completed_base_score_percent_sum: "80",
                completed_base_average_score_percent: "80",
                period_attempt_count: "0",
                period_handwriting_archive_count: "0",
                period_handwriting_question_count: "0",
                period_handwriting_stroke_count: "0",
                snapshot_at: "2026-08-07T01:00:00.000Z",
            },
            rowCount: 1,
            rows: [projection],
        });
        await expect(exportTeacherAttemptDatasetWithGateway(client, context, {
            examId: "exam-1",
            limit: 5_000,
        })).resolves.toMatchObject({ status: "loaded", rows: [{ attemptId: "attempt-a" }] });
        expect(calls).toEqual([{
            name: "omr_teacher_attempt_export_v1",
            args: { p_organization_id: "org-a", p_exam_id: "exam-1", p_limit: 5_000 },
        }]);
    });

    it("fails closed when the atomic export count and rows disagree", async () => {
        const { client } = clientReturning({
            status: "loaded",
            aggregate: {
                total_attempt_count: 1,
                completed_attempt_count: 1,
                in_progress_attempt_count: 0,
                base_attempt_count: 1,
                completed_base_attempt_count: 1,
                distinct_student_count: 1,
                completed_base_score_percent_sum: 80,
                completed_base_average_score_percent: 80,
                period_attempt_count: 0,
                period_handwriting_archive_count: 0,
                period_handwriting_question_count: 0,
                period_handwriting_stroke_count: 0,
                snapshot_at: "2026-08-07T01:00:00.000Z",
            },
            rowCount: 0,
            rows: [],
        });
        await expect(exportTeacherAttemptDatasetWithGateway(client, context, {
            limit: 5_000,
        })).resolves.toMatchObject({ status: "service_unavailable" });
    });

    it("loads exact organization and selected-exam aggregates without a row ceiling", async () => {
        const { client, calls } = clientReturning([{
            total_attempt_count: "2501",
            completed_attempt_count: "2400",
            in_progress_attempt_count: "101",
            base_attempt_count: "2300",
            completed_base_attempt_count: "2200",
            distinct_student_count: "97",
            completed_base_score_percent_sum: "176123.5",
            completed_base_average_score_percent: "80.056136",
            period_attempt_count: "301",
            period_handwriting_archive_count: "40",
            period_handwriting_question_count: "120",
            period_handwriting_stroke_count: "5400",
            snapshot_at: "2026-08-07T01:00:00.000Z",
        }]);

        await expect(aggregateTeacherAttemptsWithGateway(client, context, {
            examId: "exam-1",
            periodStart: "2026-08-01T00:00:00.000Z",
            periodEnd: "2026-09-01T00:00:00.000Z",
        })).resolves.toMatchObject({
            status: "loaded",
            aggregate: {
                totalAttemptCount: 2501,
                completedBaseAttemptCount: 2200,
                averageScorePercent: 80.056136,
                periodAttemptCount: 301,
                snapshotAt: "2026-08-07T01:00:00.000Z",
            },
        });
        expect(calls).toEqual([{
            name: "omr_teacher_attempt_aggregate_v1",
            args: {
                p_organization_id: "org-a",
                p_exam_id: "exam-1",
                p_period_start: "2026-08-01T00:00:00.000Z",
                p_period_end: "2026-09-01T00:00:00.000Z",
            },
        }]);
    });

    it("fails closed on malformed or unsafe aggregate projections", async () => {
        const { client } = clientReturning([{
            total_attempt_count: "9007199254740992",
            snapshot_at: "2026-08-07T01:00:00.000Z",
        }]);
        await expect(aggregateTeacherAttemptsWithGateway(client, context)).resolves.toMatchObject({
            status: "service_unavailable",
            error: "Invalid canonical attempt aggregate",
        });
    });

    it("returns a bounded PII-free export page with a stable descending cursor", async () => {
        const { client, calls } = clientReturning([
            {
                attempt_id: "attempt-b",
                exam_id: "exam-1",
                student_scope_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                status: "completed",
                score_percent: "91.5",
                is_retake: false,
                handwriting_archived: true,
                handwriting_question_count: "2",
                handwriting_stroke_count: "90",
                started_at: "2026-08-07T00:00:00.000Z",
                finished_at: "2026-08-07T00:10:00.000Z",
            },
            {
                attempt_id: "attempt-a",
                exam_id: "exam-1",
                student_scope_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                status: "completed",
                score_percent: "0",
                is_retake: false,
                handwriting_archived: false,
                handwriting_question_count: "0",
                handwriting_stroke_count: "0",
                started_at: "2026-08-06T23:50:00.000Z",
                finished_at: "2026-08-07T00:05:00.000Z",
            },
        ]);

        await expect(exportTeacherAttemptPageWithGateway(client, context, {
            examId: "exam-1",
            snapshotAt: "2026-08-07T01:00:00.000Z",
            pageSize: 1,
        })).resolves.toEqual({
            status: "loaded",
            page: {
                rows: [{
                    attemptId: "attempt-b",
                    examId: "exam-1",
                    studentScopeHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    status: "completed",
                    scorePercent: 91.5,
                    isRetake: false,
                    handwritingArchived: true,
                    handwritingQuestionCount: 2,
                    handwritingStrokeCount: 90,
                    startedAt: "2026-08-07T00:00:00.000Z",
                    finishedAt: "2026-08-07T00:10:00.000Z",
                }],
                hasMore: true,
                nextCursor: {
                    finishedAt: "2026-08-07T00:10:00.000Z",
                    id: "attempt-b",
                },
            },
        });
        expect(calls[0]).toEqual({
            name: "omr_teacher_attempt_export_page_v1",
            args: {
                p_organization_id: "org-a",
                p_exam_id: "exam-1",
                p_snapshot_at: "2026-08-07T01:00:00.000Z",
                p_after_finished_at: null,
                p_after_id: null,
                p_limit: 2,
            },
        });
    });

    it("rejects oversized pages and non-monotonic export rows before RPC data is trusted", async () => {
        const neverCalled = clientReturning([]);
        await expect(exportTeacherAttemptPageWithGateway(neverCalled.client, context, {
            snapshotAt: "2026-08-07T01:00:00.000Z",
            pageSize: 500,
        })).resolves.toMatchObject({ status: "invalid_request" });
        expect(neverCalled.calls).toHaveLength(0);

        const { client } = clientReturning([
            {
                attempt_id: "attempt-a",
                exam_id: "exam-1",
                student_scope_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                status: "completed",
                score_percent: 90,
                is_retake: false,
                handwriting_archived: false,
                handwriting_question_count: 0,
                handwriting_stroke_count: 0,
                started_at: "2026-08-07T00:00:00.000Z",
                finished_at: "2026-08-07T00:10:00.000Z",
            },
            {
                attempt_id: "attempt-z",
                exam_id: "exam-1",
                student_scope_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                status: "completed",
                score_percent: 80,
                is_retake: false,
                handwriting_archived: false,
                handwriting_question_count: 0,
                handwriting_stroke_count: 0,
                started_at: "2026-08-07T00:00:00.000Z",
                finished_at: "2026-08-07T00:10:00.000Z",
            },
        ]);
        await expect(exportTeacherAttemptPageWithGateway(client, context, {
            snapshotAt: "2026-08-07T01:00:00.000Z",
            pageSize: 2,
        })).resolves.toMatchObject({
            status: "service_unavailable",
            error: "Invalid canonical attempt export page",
        });
    });

    it("does not expose database errors and rejects non-completed export rows", async () => {
        const databaseFailure = {
            async rpc() {
                return { data: null, error: { message: "relation secret_internal does not exist" } };
            },
        } as TeacherAttemptReportingClient;
        await expect(aggregateTeacherAttemptsWithGateway(databaseFailure, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "Canonical attempt reporting unavailable",
        });

        const { client } = clientReturning([{
            attempt_id: "attempt-live",
            exam_id: "exam-1",
            student_scope_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            status: "in_progress",
            score_percent: 0,
            is_retake: false,
            handwriting_archived: false,
            handwriting_question_count: 0,
            handwriting_stroke_count: 0,
            started_at: "2026-08-07T00:00:00.000Z",
            finished_at: "2026-08-07T00:10:00.000Z",
        }]);
        await expect(exportTeacherAttemptPageWithGateway(client, context, {
            snapshotAt: "2026-08-07T01:00:00.000Z",
        })).resolves.toMatchObject({
            status: "service_unavailable",
            error: "Invalid canonical attempt export page",
        });
    });
});
