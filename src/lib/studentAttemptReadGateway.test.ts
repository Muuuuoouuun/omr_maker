import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { attemptToSupabaseRow, examToSupabaseRow } from "@/lib/omrPersistence";
import type { StudentServerSession } from "@/lib/studentServerSession";
import type { Attempt, Exam } from "@/types/omr";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import {
    listStudentAttemptsWithGateway,
    loadStudentAttemptWithGateway,
    type StudentAttemptReadGatewayClient,
} from "./studentAttemptReadGateway";
import { studentTrustedOfficialReviewFromUnknown } from "@/lib/studentAttemptHistoryContract";

const session: StudentServerSession = {
    audience: "omr-student",
    schemaVersion: 2,
    version: 2,
    kind: "student",
    organizationId: "org-1",
    studentId: "student-1",
    name: "학생 1",
    studentName: "학생 1",
    identityType: "registered",
    issuedAt: 1_000,
    expiresAt: 99_000,
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "공식 시험",
    organizationId: "org-1",
    studentProfileId: "student-1",
    studentId: "student-1",
    studentName: "학생 1",
    identityType: "registered",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T01:00:00.000Z",
    score: 5,
    totalScore: 10,
    answers: { 1: 3, 2: 2 },
    drawingsRef: {
        store: "remote",
        key: "asset-handwriting-1",
        organizationId: "org-1",
        kind: "attempt_handwriting",
        attemptId: "attempt-1",
        mimeType: "application/json",
        size: 512,
        updatedAt: "2026-07-14T01:00:01.000Z",
    },
    status: "completed",
    questionResults: [
        {
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "공식 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            questionId: 1,
            questionNumber: 1,
            score: 5,
            earnedScore: 5,
            selectedAnswer: 3,
            correctAnswer: 3,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            concept: "교사용 비밀 개념",
            finishedAt: "2026-07-14T01:00:00.000Z",
        },
        {
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "공식 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            questionId: 2,
            questionNumber: 2,
            score: 5,
            earnedScore: 0,
            selectedAnswer: 2,
            correctAnswer: 1,
            status: "wrong",
            isCorrect: false,
            isWrong: true,
            isUnanswered: false,
            finishedAt: "2026-07-14T01:00:00.000Z",
        },
    ],
};

const exam: Exam = {
    id: "exam-1",
    title: "공식 시험",
    organizationId: "org-1",
    createdAt: "2026-07-13T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,secret-answer-key",
    questions: [
        { id: 1, number: 1, answer: 3, score: 5, choices: 4, explanation: "비밀 해설", tags: { concept: "교사용 비밀 개념" } },
        { id: 2, number: 2, answer: 1, score: 5, choices: 4 },
    ],
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

function mockClient(options: {
    attemptRows?: unknown[];
    singleAttempt?: unknown;
    examRow?: unknown;
} = {}) {
    const calls: Array<{
        table: string;
        filters: Array<[string, string]>;
        mode: "list" | "single";
        afterId?: string;
        limit?: number;
        orders?: Array<[string, { ascending: boolean }]>;
        sequence?: Array<[string, ...unknown[]]>;
    }> = [];
    const client: StudentAttemptReadGatewayClient = {
        from(table) {
            return {
                select() {
                    const filters: Array<[string, string]> = [];
                    let afterId = "";
                    const orders: Array<[string, { ascending: boolean }]> = [];
                    const sequence: Array<[string, ...unknown[]]> = [];
                    const query = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            sequence.push(["eq", column, value]);
                            return query;
                        },
                        gt(column: string, value: string) {
                            afterId = value;
                            sequence.push(["gt", column, value]);
                            return query;
                        },
                        order(column: string, orderOptions: { ascending: boolean }) {
                            orders.push([column, orderOptions]);
                            sequence.push(["order", column, orderOptions]);
                            return query;
                        },
                        async limit(value: number) {
                            sequence.push(["limit", value]);
                            calls.push({ table, filters: [...filters], mode: "list", afterId, limit: value, orders: [...orders], sequence: [...sequence] });
                            const rows = options.attemptRows ?? [attemptListRow(attempt)];
                            const selected = rows.filter(row => (row as { id?: string }).id! > afterId).slice(0, value);
                            return { data: selected, error: null };
                        },
                        async maybeSingle() {
                            calls.push({ table, filters: [...filters], mode: "single" });
                            if (table === "omr_exams") {
                                return { data: options.examRow === undefined ? examToSupabaseRow(exam) : options.examRow, error: null };
                            }
                            return {
                                data: options.singleAttempt === undefined ? attemptToSupabaseRow(attempt) : options.singleAttempt,
                                error: null,
                            };
                        },
                    };
                    return query;
                },
            };
        },
    };
    return { client, calls };
}

describe("student attempt read gateway", () => {
    it("lists only completed attempts scoped by both HttpOnly-session organization and student", async () => {
        const { client, calls } = mockClient();
        const result = await listStudentAttemptsWithGateway(client, session);
        expect(result.status).toBe("loaded");
        expect(calls[0].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["student_profile_id", "student-1"],
            ["student_id", "student-1"],
            ["status", "completed"],
        ]));
        expect(calls[0].limit).toBe(INITIAL_OPERATIONS_LIMITS.listPageSize);
        expect(calls[0].orders).toEqual([
            ["id", { ascending: true }],
        ]);
        expect(calls[0].sequence).toEqual([
            ["eq", "organization_id", "org-1"],
            ["eq", "student_profile_id", "student-1"],
            ["eq", "student_id", "student-1"],
            ["eq", "status", "completed"],
            ["order", "id", { ascending: true }],
            ["limit", INITIAL_OPERATIONS_LIMITS.listPageSize],
        ]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("correctAnswer");
        expect(serialized).not.toContain("교사용 비밀 개념");
        expect(serialized).not.toContain("secret-answer-key");
    });

    it("reads no further than the student attempt ceiling plus one and fails loudly on overflow", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentAttempts + 1 }, (_, index) => attemptListRow({
            ...attempt,
            id: `attempt-${String(index).padStart(4, "0")}`,
        }));
        const { client, calls } = mockClient({ attemptRows: rows });

        await expect(listStudentAttemptsWithGateway(client, session)).resolves.toEqual({
            status: "service_unavailable",
            error: "initial_capacity_exceeded",
        });
        const pages = calls.filter(call => call.mode === "list");
        expect(pages.map(call => call.afterId)).toEqual(["", "attempt-0249"]);
        expect(pages.map(call => call.limit)).toEqual([INITIAL_OPERATIONS_LIMITS.listPageSize, 1]);
        expect(pages.reduce((sum, call) => sum + (call.limit || 0), 0)).toBe(INITIAL_OPERATIONS_LIMITS.studentAttempts + 1);
    });

    it("does not skip the next student attempt when an earlier id disappears between pages", async () => {
        const mutableRows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentAttempts }, (_, index) => {
            const id = `attempt-${String(index).padStart(4, "0")}`;
            return attemptListRow({
                ...attempt,
                id,
                questionResults: attempt.questionResults?.map(result => ({ ...result, attemptId: id })),
            });
        });
        let dataset = [...mutableRows];
        let page = 0;
        const calls: string[] = [];
        const client = {
            from() {
                let afterId = "";
                const query = {
                    eq() { return query; },
                    gt(_column: string, value: string) { afterId = value; calls.push(value); return query; },
                    order() { return query; },
                    async limit(value: number) {
                        const selected = dataset.filter(row => row.id > afterId).slice(0, value);
                        page += 1;
                        if (page === 1) dataset = dataset.filter(row => row.id !== "attempt-0000");
                        return { data: selected, error: null };
                    },
                };
                return { select: () => query };
            },
        } as unknown as StudentAttemptReadGatewayClient;

        const result = await listStudentAttemptsWithGateway(client, session);
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.attempts).toHaveLength(INITIAL_OPERATIONS_LIMITS.studentAttempts);
            expect(new Set(result.attempts.map(item => item.id)).size).toBe(result.attempts.length);
            expect(calls).toEqual(["attempt-0249"]);
        }
    });

    it("returns post-submit answers, explanations, and the owned remote handwriting ref only in detail", async () => {
        const exactRows = (attempt.questionResults || []).map(result => ({
            ...result,
            organizationId: attempt.organizationId,
            studentProfileId: attempt.studentProfileId,
        }));
        const sealedAttempt = {
            ...attempt,
            questionResults: exactRows,
            ...buildCanonicalQuestionResultEvidence(attempt, exactRows),
        };
        const { client, calls } = mockClient({ singleAttempt: attemptToSupabaseRow(sealedAttempt) });
        const result = await loadStudentAttemptWithGateway(client, "attempt-1", session);
        expect(result).toMatchObject({
            status: "loaded",
            detail: {
                attempt: {
                    score: 5,
                    questionResults: [
                        { questionId: 1, selectedAnswer: 3, status: "correct" },
                        { questionId: 2, selectedAnswer: 2, status: "wrong" },
                    ],
                },
                exam: {
                    id: "exam-1",
                    questions: [
                        { id: 1, answer: 3, explanation: "비밀 해설" },
                        { id: 2, answer: 1 },
                    ],
                },
                handwritingRef: {
                    store: "remote",
                    key: "asset-handwriting-1",
                    organizationId: "org-1",
                    kind: "attempt_handwriting",
                    attemptId: "attempt-1",
                },
                retakeEligibleQuestionIds: [2],
            },
        });
        expect(calls[0].filters).toContainEqual(["id", "attempt-1"]);
        expect(calls[1].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["id", "exam-1"],
        ]));
        const serialized = JSON.stringify(result);
        expect(serialized).toContain('"answer":3');
        expect(serialized).toContain("비밀 해설");
        expect(serialized).not.toContain("secret-answer-key");
        expect(serialized).not.toMatch(/questionResults(?:DefinitionManifest|FullEvidence)Hash/);
    });

    it("does not merge an explanation from an edited incompatible current definition", async () => {
        const editedExam = examToSupabaseRow({
            ...exam,
            questions: [
                { ...exam.questions[0], answer: 4, explanation: "현재 해설" },
            ],
        });
        const { client } = mockClient({ examRow: editedExam });

        const result = await loadStudentAttemptWithGateway(client, "attempt-1", session);

        expect(result).toMatchObject({
            status: "loaded",
            detail: {
                exam: {
                    questions: [
                        { id: 1, number: 1, answer: 3 },
                        { id: 2, number: 2, answer: 1 },
                    ],
                },
            },
        });
        if (result.status === "loaded") {
            expect(result.detail.exam.questions[0]).not.toHaveProperty("explanation");
        }
    });

    it("suppresses a current explanation when any immutable submitted PDF definition field changed", async () => {
        const submittedRows = (attempt.questionResults || []).map((result, index) => ({
            ...result,
            organizationId: attempt.organizationId,
            studentProfileId: attempt.studentProfileId,
            ...(index === 0 ? {
                pdfLocation: { page: 1, x: 0.1, y: 0.2 },
                pdfRegion: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                passagePdfRegions: [{ page: 2, x: 0.2, y: 0.3, width: 0.4, height: 0.5 }],
            } : {}),
        }));
        const submittedAttempt: Attempt = {
            ...attempt,
            questionResults: submittedRows,
            ...buildCanonicalQuestionResultEvidence(attempt, submittedRows),
        };
        const current = {
            ...exam,
            questions: exam.questions.map((question, index) => index === 0 ? {
                ...question,
                pdfLocation: { page: 1, x: 0.1, y: 0.2 },
                pdfRegion: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
                passagePdfRegions: [{ page: 2, x: 0.2, y: 0.3, width: 0.4, height: 0.6 }],
                explanation: "편집 후 해설",
            } : question),
        };
        const { client } = mockClient({
            singleAttempt: attemptToSupabaseRow(submittedAttempt),
            examRow: examToSupabaseRow(current),
        });

        const result = await loadStudentAttemptWithGateway(client, "attempt-1", session);

        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.detail.exam.questions[0]).not.toHaveProperty("explanation");
            expect(result.detail.trustedReview).toBeDefined();
            expect(result.detail.trustedReview!.questions[0]).not.toHaveProperty("explanation");
        }
    });

    it("suppresses a current explanation when the displayed choice-count definition changed", async () => {
        const exactRows = (attempt.questionResults || []).map(result => ({
            ...result,
            organizationId: attempt.organizationId,
            studentProfileId: attempt.studentProfileId,
        }));
        const sealedAttempt: Attempt = {
            ...attempt,
            questionResults: exactRows,
            ...buildCanonicalQuestionResultEvidence(attempt, exactRows),
        };
        const editedChoices: Exam = {
            ...exam,
            questions: exam.questions.map((question, index) => index === 0
                ? { ...question, choices: 5, explanation: "선택지 편집 후 해설" }
                : question),
        };
        const { client } = mockClient({
            singleAttempt: attemptToSupabaseRow(sealedAttempt),
            examRow: examToSupabaseRow(editedChoices),
        });

        const result = await loadStudentAttemptWithGateway(client, attempt.id, session);

        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.detail.trustedReview).toBeDefined();
            expect(result.detail.trustedReview!.questions[0]).not.toHaveProperty("explanation");
        }
    });

    it("returns a trusted hash-free review projection that the page can render directly", async () => {
        const exactRows = (attempt.questionResults || []).map(result => ({
            ...result,
            organizationId: attempt.organizationId,
            studentProfileId: attempt.studentProfileId,
        }));
        const sealedAttempt = {
            ...attempt,
            questionResults: exactRows,
            ...buildCanonicalQuestionResultEvidence(attempt, exactRows),
        };
        const { client } = mockClient({ singleAttempt: attemptToSupabaseRow(sealedAttempt) });

        const result = await loadStudentAttemptWithGateway(client, attempt.id, session);

        expect(result).toMatchObject({
            status: "loaded",
            detail: {
                trustedReview: {
                    gradingSource: "canonical_submission",
                    questions: [
                        { id: 1, answer: 3, explanation: "비밀 해설" },
                        { id: 2, answer: 1 },
                    ],
                    questionResults: [
                        { questionId: 1, correctAnswer: 3, status: "correct" },
                        { questionId: 2, correctAnswer: 1, status: "wrong" },
                    ],
                },
            },
        });
        expect(JSON.stringify(result)).not.toMatch(/questionResults(?:DefinitionManifest|FullEvidence)Hash/);
        if (result.status === "loaded" && result.detail.trustedReview) {
            expect(studentTrustedOfficialReviewFromUnknown(result.detail.trustedReview)).not.toBeNull();
            expect(studentTrustedOfficialReviewFromUnknown({
                ...result.detail.trustedReview,
                questionResults: result.detail.trustedReview.questionResults.map((row, index) => index === 0
                    ? { ...row, difficulty: "secret-difficulty" }
                    : row),
            })).toBeNull();
            expect(studentTrustedOfficialReviewFromUnknown({
                ...result.detail.trustedReview,
                questionResults: result.detail.trustedReview.questionResults.map((row, index) => index === 0
                    ? { ...row, expectedTimeSec: Number.NaN }
                    : row),
            })).toBeNull();
        }
    });

    it("rejects a remote handwriting ref whose organization or attempt scope was forged", async () => {
        const forged = attemptToSupabaseRow({
            ...attempt,
            drawingsRef: {
                ...attempt.drawingsRef!,
                organizationId: "other-org",
                attemptId: "other-attempt",
            },
        });
        const { client } = mockClient({ singleAttempt: forged });

        const result = await loadStudentAttemptWithGateway(client, "attempt-1", session);
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.detail.handwritingRef).toBeUndefined();
        }
    });

    it("fails closed if a service response contains another student or organization payload", async () => {
        const crossStudent = attemptToSupabaseRow({
            ...attempt,
            organizationId: "other-org",
            studentProfileId: "other-student",
            studentId: "other-student",
            studentName: "다른 학생",
            questionResults: attempt.questionResults?.map(result => ({
                ...result,
                studentId: "other-student",
                studentName: "다른 학생",
            })),
        });
        const { client } = mockClient({ singleAttempt: crossStudent });
        await expect(loadStudentAttemptWithGateway(client, "attempt-1", session)).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid scoped student attempt",
        });
    });

    it("returns not_found without exposing any local or cross-student record", async () => {
        const { client } = mockClient({ singleAttempt: null });
        await expect(loadStudentAttemptWithGateway(client, "missing", session)).resolves.toEqual({
            status: "not_found",
        });
    });
});
