import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { attemptToSupabaseRow } from "@/lib/omrPersistence";
import type { Attempt } from "@/types/omr";
import * as teacherAttemptGateway from "./teacherAttemptGateway";
import {
    listTeacherAttemptSummariesWithGateway,
    listTeacherAttemptsWithGateway,
    loadTeacherAttemptWithGateway,
    type TeacherAttemptGatewayClient,
} from "./teacherAttemptGateway";

const attempt: Attempt = {
    id: "attempt-1",
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
        guest_id: item.guestId,
        answers: item.answers,
        question_results: item.questionResults,
        question_timings: item.questionTimings,
        focus_loss_events: item.focusLossEvents,
        student_questions: item.studentQuestions,
        auto_submitted: item.autoSubmitted,
        tab_foci_lost_count: item.tabFociLostCount,
        drawings_ref: item.drawingsRef,
        handwriting: item.handwriting,
        handwriting_archived: item.handwritingArchived,
        handwriting_plan: item.handwritingPlan,
        drawing_page_count: item.drawingPageCount,
        drawing_stroke_count: item.drawingStrokeCount,
        question_drawings: item.questionDrawings,
        retake: item.retake,
    };
}

function clientWithRows(rows: unknown[]): { client: TeacherAttemptGatewayClient; filters: Array<[string, string]> } {
    const filters: Array<[string, string]> = [];
    return {
        filters,
        client: {
            from: () => ({
                select: () => {
                    let afterId = "";
                    const query = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return query;
                        },
                        gt(_column: string, value: string) {
                            afterId = value;
                            return query;
                        },
                        async maybeSingle() {
                            return { data: rows[0] || null, error: null };
                        },
                        order() { return query; },
                        async limit(value: number) {
                            return {
                                data: rows.filter(row => {
                                    const record = row as { id?: string; payload?: { id?: string } };
                                    return (record.id || record.payload?.id || "") > afterId;
                                }).slice(0, value),
                                error: null,
                            };
                        },
                    };
                    return query;
                },
            }),
        } as unknown as TeacherAttemptGatewayClient,
    };
}

function keysetClient(
    initialRows: Array<Record<string, unknown>>,
    mutateBeforeSecondPage?: (rows: Array<Record<string, unknown>>) => void,
) {
    const timestampMicros = (value: unknown) => {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(String(value));
        if (!match) throw new Error(`invalid test timestamp: ${String(value)}`);
        return `${match[1]}.${(match[2] || "").padEnd(6, "0")}Z`;
    };
    const rows = [...initialRows];
    const calls: Array<[string, ...unknown[]]> = [];
    let requests = 0;
    const client = {
        from() {
            let cursor: { finished_at: string; id: string } | undefined;
            const query = {
                eq(column: string, value: string) { calls.push(["eq", column, value]); return query; },
                gt() { return query; },
                or(filter: string) {
                    calls.push(["or", filter]);
                    const match = /^finished_at\.lt\."([^"]+)",and\(finished_at\.eq\."\1",id\.lt\."([^"]+)"\)$/.exec(filter);
                    if (!match) throw new Error(`invalid keyset filter: ${filter}`);
                    cursor = { finished_at: match[1], id: match[2] };
                    return query;
                },
                order(column: string, options: { ascending: boolean }) {
                    calls.push(["order", column, options]);
                    return query;
                },
                async limit(value: number) {
                    calls.push(["limit", value]);
                    requests += 1;
                    if (requests === 2) mutateBeforeSecondPage?.(rows);
                    const sorted = [...rows]
                        .sort((left, right) => timestampMicros(right.finished_at).localeCompare(timestampMicros(left.finished_at))
                            || String(right.id).localeCompare(String(left.id)))
                        .filter(row => !cursor
                            || timestampMicros(row.finished_at) < timestampMicros(cursor.finished_at)
                            || (timestampMicros(row.finished_at) === timestampMicros(cursor.finished_at)
                                && String(row.id) < cursor.id));
                    const data = sorted.slice(0, value);
                    return { data, error: null };
                },
            };
            return { select: () => query };
        },
    } as unknown as TeacherAttemptGatewayClient;
    return { client, calls, get requests() { return requests; } };
}

describe("teacher attempt gateway", () => {
    it("lists lightweight summaries through the same organization/exam keyset boundary", async () => {
        const selected: string[] = [];
        const filters: Array<[string, string]> = [];
        const row = attemptListRow(attempt);
        const client = {
            from() {
                const query = {
                    eq(column: string, value: string) { filters.push([column, value]); return query; },
                    gt() { return query; },
                    order() { return query; },
                    async limit() { return { data: [row], error: null }; },
                };
                return { select(columns: string) { selected.push(columns); return query; } };
            },
        } as unknown as TeacherAttemptGatewayClient;

        const result = await listTeacherAttemptSummariesWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1");

        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["exam_id", "exam-1"],
        ]);
        expect(selected[0]).not.toMatch(/answers:|question_results:|question_timings:|focus_loss_events:|handwriting:payload|question_drawings:/);
        expect(result).toMatchObject({
            status: "loaded",
            attempts: [{ id: "attempt-1", detailLevel: "summary", answers: {} }],
        });
    });

    it("lists attempts only through the server-owned organization filter", async () => {
        const postgresUtcRow = {
            ...attemptListRow(attempt),
            started_at: "2026-07-14T00:00:00+00:00",
            finished_at: "2026-07-14T00:01:00.123456+00:00",
        };
        const { client, filters } = clientWithRows([postgresUtcRow]);
        const result = await listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });
        expect(result).toMatchObject({
            status: "loaded",
            attempts: [{
                id: "attempt-1",
                startedAt: "2026-07-14T00:00:00.000Z",
                finishedAt: "2026-07-14T00:01:00.123Z",
            }],
            page: { nextCursor: { finishedAt: "2026-07-14T00:01:00.123Z", id: "attempt-1" } },
            meta: {
                organizationId: "org-a",
                rawCount: 1,
                parsedCount: 1,
            },
        });
        if (result.status === "loaded") {
            expect(Object.keys(result.meta).sort()).toEqual([
                "loadedAt",
                "organizationId",
                "parsedCount",
                "rawCount",
            ]);
            expect(new Date(result.meta.loadedAt).toISOString()).toBe(result.meta.loadedAt);
        }
        expect(filters).toContainEqual(["organization_id", "org-a"]);
    });

    it("round-trips the exact targeted assignment generation through the remote teacher list", async () => {
        const targeted = {
            ...attempt,
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
        };
        const { client } = clientWithRows([attemptListRow(targeted)]);

        const result = await listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });

        expect(result).toMatchObject({
            status: "loaded",
            attempts: [{ assignmentId: "assignment-reused", assignmentRevision: 8 }],
        });
    });

    it.each([
        ["a blank id", { ...attemptListRow({ ...attempt, id: "attempt-0" }), id: "   " }],
        ["a missing organization", { ...attemptListRow({ ...attempt, id: "attempt-0" }), organization_id: undefined }],
        ["a whitespace-padded organization", { ...attemptListRow({ ...attempt, id: "attempt-0" }), organization_id: " org-a " }],
        ["a wrong-organization row", { ...attemptListRow(attempt), id: "attempt-other", organization_id: "org-b" }],
        ["a blank exam id", { ...attemptListRow({ ...attempt, id: "attempt-0" }), exam_id: "" }],
        ["a blank student name", { ...attemptListRow({ ...attempt, id: "attempt-0" }), student_name: "" }],
        ["a blank exam title", { ...attemptListRow({ ...attempt, id: "attempt-0" }), exam_title: "" }],
        ["an invalid status", { ...attemptListRow({ ...attempt, id: "attempt-0" }), status: "submitted" }],
        ["a nonnumeric score", { ...attemptListRow({ ...attempt, id: "attempt-0" }), score: "1" }],
        ["a nonfinite total score", { ...attemptListRow({ ...attempt, id: "attempt-0" }), total_score: Number.NaN }],
        ["a whitespace-padded start timestamp", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }),
            started_at: ` ${attempt.startedAt} `,
        }],
        ["a noncanonical finish timestamp", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }),
            finished_at: "2026-07-14T09:01:00+09:00",
        }],
        ["a calendar-impossible finish timestamp", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }),
            finished_at: "2026-02-30T00:01:00.123456Z",
        }],
        ["a malformed answers projection", { ...attemptListRow({ ...attempt, id: "attempt-0" }), answers: [] }],
        ["a malformed question-results entry", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), question_results: [{ questionId: "bad" }],
        }],
        ["a malformed question-timing entry", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), question_timings: [{ questionId: 1, totalTimeSec: "3" }],
        }],
        ["a malformed focus-loss entry", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), focus_loss_events: [{ at: attempt.finishedAt, count: 1, reason: "focus" }],
        }],
        ["a nonblank generated student-question body", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }),
            student_questions: [{ questionId: 1, questionNumber: 1, body: "private", createdAt: "", status: "queued" }],
        }],
        ["a malformed drawings reference", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), drawings_ref: { store: "remote", key: "drawing", size: "4" },
        }],
        ["a coerced auto-submitted flag", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), auto_submitted: "false",
        }],
        ["a nonnumeric answer key", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), answers: { "question-1": 2 },
        }],
        ["a nonnumeric answer value", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), answers: { 1: "2" },
        }],
        ["a nonfinite answer value", {
            ...attemptListRow({ ...attempt, id: "attempt-0" }), answers: { 1: Number.POSITIVE_INFINITY },
        }],
    ])("rejects every attempt when the collection contains %s", async (_label, invalidRow) => {
        const { client } = clientWithRows([attemptListRow(attempt), invalidRow]);

        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid canonical attempt collection",
        });
    });

    it("rejects an answers projection whose numeric entry is inherited rather than own", async () => {
        const inheritedAnswers = Object.create({ 1: 2 }) as Record<string, number>;
        const invalidRow = { ...attemptListRow({ ...attempt, id: "attempt-inherited" }), answers: inheritedAnswers };
        const { client } = clientWithRows([invalidRow]);

        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid canonical attempt collection",
        });
    });

    it("narrows live polling to the selected exam", async () => {
        const { client, filters } = clientWithRows([attemptListRow(attempt)]);
        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1")).resolves.toMatchObject({ status: "loaded" });
        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["exam_id", "exam-1"],
        ]);
    });

    it("uses the indexed newest-first boundary after organization and exam scopes", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.listPageSize + 1 }, (_, index) => attemptListRow({
                ...attempt,
                id: `attempt-${String(index).padStart(4, "0")}`,
                finishedAt: index % 2 === 0 ? "2026-07-14T00:02:00.000Z" : "2026-07-14T00:01:00.000Z",
        }));
        const { client, calls } = keysetClient(rows);

        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1")).resolves.toMatchObject({ status: "loaded", attempts: { length: rows.length } });

        expect(calls.slice(0, 3)).toEqual([
            ["eq", "organization_id", "org-a"],
            ["eq", "exam_id", "exam-1"],
            ["order", "finished_at", { ascending: false }],
        ]);
        expect(calls.filter(([method]) => method === "order").slice(0, 2)).toEqual([
            ["order", "finished_at", { ascending: false }],
            ["order", "id", { ascending: false }],
        ]);
        expect(calls.filter(([method]) => method === "limit")).toEqual([
            ["limit", INITIAL_OPERATIONS_LIMITS.listPageSize],
            ["limit", INITIAL_OPERATIONS_LIMITS.listPageSize],
        ]);
        expect(calls.filter(([method]) => method === "or")).toEqual([
            ["or", expect.stringContaining("finished_at.lt.")],
        ]);

        const result = await listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1");
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.attempts.slice(0, 3).map(item => item.id)).toEqual([
                "attempt-0250",
                "attempt-0248",
                "attempt-0246",
            ]);
        }
    });

    it.each(["Z", "+00:00"] as const)(
        "keeps PostgreSQL microseconds in the internal keyset cursor for the %s UTC representation",
        async utcSuffix => {
        const newerRows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.listPageSize - 1 }, (_, index) => ({
            ...attemptListRow({ ...attempt, id: `attempt-newer-${String(index).padStart(4, "0")}` }),
            finished_at: "2026-07-14T00:01:00.124000Z",
        }));
        const boundary = {
            ...attemptListRow({ ...attempt, id: "attempt-boundary-a" }),
            finished_at: `2026-07-14T00:01:00.123456${utcSuffix}`,
        };
        const next = {
            ...attemptListRow({ ...attempt, id: "attempt-next-z" }),
            finished_at: "2026-07-14T00:01:00.123400Z",
        };
        const keyset = keysetClient([...newerRows, boundary, next]);

        const result = await listTeacherAttemptsWithGateway(keyset.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });

        expect(result.status).toBe("loaded");
        expect(keyset.calls.filter(([method]) => method === "or")).toEqual([[
            "or",
            'finished_at.lt."2026-07-14T00:01:00.123456Z",and(finished_at.eq."2026-07-14T00:01:00.123456Z",id.lt."attempt-boundary-a")',
        ]]);
        if (result.status === "loaded") {
            expect(result.attempts).toHaveLength(INITIAL_OPERATIONS_LIMITS.listPageSize + 1);
            expect(result.attempts.map(item => item.id)).toContain("attempt-next-z");
            expect(result.attempts.find(item => item.id === "attempt-boundary-a")?.finishedAt)
                .toBe("2026-07-14T00:01:00.123Z");
        }
    });

    it.each([
        ["detailed", (client: TeacherAttemptGatewayClient) => listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })],
        ["summary", (client: TeacherAttemptGatewayClient) => listTeacherAttemptSummariesWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })],
    ] as const)("preserves authoritative microsecond order in %s output despite opposing ids", async (_label, load) => {
        const later = {
            ...attemptListRow({ ...attempt, id: "attempt-z" }),
            finished_at: "2026-07-14T00:01:00.123456Z",
        };
        const earlier = {
            ...attemptListRow({ ...attempt, id: "attempt-a" }),
            finished_at: "2026-07-14T00:01:00.123400Z",
        };
        const keyset = keysetClient([earlier, later]);

        const result = await load(keyset.client);

        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.attempts.map(item => item.id)).toEqual(["attempt-z", "attempt-a"]);
            expect(result.attempts.map(item => item.finishedAt)).toEqual([
                "2026-07-14T00:01:00.123Z",
                "2026-07-14T00:01:00.123Z",
            ]);
        }
    });

    it("rejects a has-more page instead of returning a usable partial collection", async () => {
        const total = INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1;
        const rows = Array.from({ length: total }, (_, index) => attemptListRow({
            ...attempt,
            id: `attempt-${String(index).padStart(5, "0")}`,
        }));
        const keyset = keysetClient(rows);

        await expect(listTeacherAttemptsWithGateway(keyset.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toEqual({
            status: "service_unavailable",
            error: "Incomplete canonical attempt collection",
        });
        expect(keyset.requests).toBe(9);
        expect(keyset.calls.filter(([method]) => method === "or")).toHaveLength(8);
    });

    it.each(["delete", "insert"] as const)(
        "preserves deterministic ordering without omissions or duplicates across a concurrent %s",
        async mutation => {
        const dataset = Array.from({ length: 300 }, (_, index) => attemptListRow({
            ...attempt,
            id: `attempt-${String(index).padStart(4, "0")}`,
        }));
        const keyset = keysetClient(dataset, rows => {
            if (mutation === "delete") {
                const alreadyDeliveredIndex = rows.findIndex(row => row.id === "attempt-0299");
                rows.splice(alreadyDeliveredIndex, 1);
            } else {
                rows.push(attemptListRow({ ...attempt, id: "attempt-9999" }));
            }
        });

        const result = await listTeacherAttemptsWithGateway(keyset.client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            const ids = result.attempts.map(item => item.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toContain("attempt-0250");
            expect(ids).toHaveLength(300);
            expect(ids).not.toContain("attempt-9999");
            expect(keyset.requests).toBe(2);
        }
    });

    it("loads an attempt with both organization and attempt id filters", async () => {
        const { client, filters } = clientWithRows([{ payload: attempt }]);
        await expect(loadTeacherAttemptWithGateway(client, "attempt-1", {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({ status: "loaded", attempt: { id: "attempt-1" } });
        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["id", "attempt-1"],
        ]);
    });

    it("does not expose the superseded full-attempt mutation gateway", () => {
        expect("saveTeacherAttemptWithGateway" in teacherAttemptGateway).toBe(false);
    });

    it("answers one student question without forwarding tampered canonical fields", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return {
                    data: [{
                        payload: {
                            ...attempt,
                            score: 1,
                            studentId: "student-original",
                            questionResults: [{ questionId: 1, score: 1 }],
                        },
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            answerTeacherAttemptQuestionWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.answerTeacherAttemptQuestionWithGateway).toBeTypeOf("function");
        if (!scoped.answerTeacherAttemptQuestionWithGateway) return;

        await expect(scoped.answerTeacherAttemptQuestionWithGateway(client, {
            attemptId: "attempt-1",
            questionId: "1",
            answer: "  설명입니다.  ",
            score: 999,
            studentId: "student-attacker",
            questionResults: [{ questionId: 1, score: 999 }],
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "김 선생",
            memberRole: "teacher",
        })).resolves.toMatchObject({
            status: "saved",
            attempt: {
                score: 1,
                studentId: "student-original",
                questionResults: [{ questionId: 1, score: 1 }],
            },
        });
        expect(calls).toEqual([{
            name: "omr_answer_attempt_question_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_id: "attempt-1",
                p_question_id: "1",
                p_answer: "설명입니다.",
                p_actor_user_id: "teacher-1",
                p_member_role: "teacher",
                p_actor_label: "김 선생",
            },
        }]);
    });

    it("updates one subquestion review status with an unambiguous parent path", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return { data: [{ payload: attempt }], error: null };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            setTeacherAttemptSubquestionReviewWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.setTeacherAttemptSubquestionReviewWithGateway).toBeTypeOf("function");
        if (!scoped.setTeacherAttemptSubquestionReviewWithGateway) return;

        await scoped.setTeacherAttemptSubquestionReviewWithGateway(client, {
            attemptId: "attempt-1",
            questionId: 7,
            subquestionId: "reason",
            status: "reviewed",
            score: 999,
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "김 선생",
            memberRole: "teacher",
        });
        expect(calls).toEqual([{
            name: "omr_set_subquestion_review_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_id: "attempt-1",
                p_subquestion_id: "7:reason",
                p_status: "reviewed",
                p_actor_user_id: "teacher-1",
                p_member_role: "teacher",
                p_actor_label: "김 선생",
            },
        }]);
    });

    it("loads canonical attempts and exams before force-finishing with trusted grading", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const inProgress: Attempt = {
            ...attempt,
            status: "in_progress",
            score: 0,
            totalScore: 0,
            answers: { 1: 2 },
            questionResults: [],
            classId: "class-a",
        };
        const canonicalExam = {
            id: "exam-1",
            organizationId: "org-a",
            classId: "class-a",
            title: "시험",
            createdAt: "2026-07-14T00:00:00.000Z",
            updatedAt: "2026-07-14T00:00:30.000Z",
            questions: [
                { id: 1, number: 1, answer: 2, score: 4, choices: 5 },
                { id: 2, number: 2, answer: 3, score: 6, choices: 5 },
            ],
        };
        const client = {
            from(table: string) {
                const filters: Array<[string, unknown]> = [];
                const query = {
                    eq(column: string, value: unknown) {
                        filters.push([column, value]);
                        return query;
                    },
                    in(column: string, value: unknown) {
                        filters.push([column, value]);
                        return query;
                    },
                    async order() {
                        return table === "omr_attempts"
                            ? { data: [{ payload: inProgress, updated_at: "2026-07-14T00:00:20.000Z" }], error: null }
                            : { data: [{ payload: canonicalExam, updated_at: canonicalExam.updatedAt }], error: null };
                    },
                };
                return { select: () => query };
            },
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return {
                    data: [{
                        payload: {
                            ...inProgress,
                            status: "completed",
                            score: 4,
                            totalScore: 10,
                            finishedAt: "2026-07-14T00:02:00.000Z",
                        },
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            forceFinishTeacherAttemptsWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.forceFinishTeacherAttemptsWithGateway).toBeTypeOf("function");
        if (!scoped.forceFinishTeacherAttemptsWithGateway) return;

        await scoped.forceFinishTeacherAttemptsWithGateway(client, {
            attemptIds: ["attempt-1", "attempt-1", " attempt-1 "],
            finishedAt: "2026-07-14T00:02:00.000Z",
            score: 999,
            questionResults: [{ questionId: 1, score: 999 }],
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "관리자",
            memberRole: "admin",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            name: "omr_force_finish_attempts_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_ids: ["attempt-1"],
                p_finished_at: "2026-07-14T00:02:00.000Z",
                p_actor_user_id: "teacher-1",
                p_member_role: "admin",
                p_actor_label: "관리자",
            },
        });
        expect(calls[0].args.p_gradings).toEqual([
            expect.objectContaining({
                attempt_id: "attempt-1",
                expected_answers: { 1: 2 },
                expected_is_retake: false,
                expected_exam_updated_at: canonicalExam.updatedAt,
                score: 4,
                total_score: 10,
                question_results: [
                    expect.objectContaining({ questionId: 1, status: "correct" }),
                    expect.objectContaining({ questionId: 2, status: "unanswered" }),
                ],
                question_result_rows: [
                    expect.objectContaining({ attempt_id: "attempt-1", question_id: 1, status: "correct" }),
                    expect.objectContaining({ attempt_id: "attempt-1", question_id: 2, status: "unanswered" }),
                ],
            }),
        ]);
    });

    it("rejects viewer mutations before calling the service-role RPC", async () => {
        const client = {
            async rpc() {
                throw new Error("must not be called");
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            answerTeacherAttemptQuestionWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.answerTeacherAttemptQuestionWithGateway).toBeTypeOf("function");
        if (!scoped.answerTeacherAttemptQuestionWithGateway) return;

        await expect(scoped.answerTeacherAttemptQuestionWithGateway(client, {
            attemptId: "attempt-1",
            questionId: "1",
            answer: "설명",
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "viewer-1",
            memberRole: "viewer",
        })).resolves.toMatchObject({ status: "forbidden" });
    });
});
