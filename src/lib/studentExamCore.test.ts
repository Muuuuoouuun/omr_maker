import { describe, expect, it } from "vitest";
import {
    attemptOwnedBy,
    buildServerAttempt,
    hasArchiveableHandwriting,
    identityAccessSession,
    loadSubmissionBaseInParallel,
    remainingSecondsWithinWindow,
    resolveRetakeScope,
    type SubmitAttemptInput,
} from "./studentExamCore";
import type { Exam } from "@/types/omr";
import type { StudentServerIdentity } from "./studentServerSession";

const EXAM: Exam = {
    id: "e1", title: "기말", createdAt: "2026-07-01T00:00:00.000Z", organizationId: "teacher_abc",
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 2, choices: 5, score: 10 },
    ],
};
const GUEST: StudentServerIdentity = {
    kind: "guest", guestId: "g1", name: "Guest Student", identityType: "guest",
    issuedAt: 0, expiresAt: 9e15,
};
const INPUT: SubmitAttemptInput = {
    examId: "e1",
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
    answers: { 1: 3, 2: 4 },
    startedAt: "2026-07-01T01:00:00.000Z",
};

describe("remainingSecondsWithinWindow", () => {
    const NOW = Date.parse("2026-07-01T01:00:00.000Z");

    it("returns the full duration when there is no endAt", () => {
        expect(remainingSecondsWithinWindow(3000, undefined, NOW)).toBe(3000);
    });

    it("clamps to the time left until endAt when that is smaller than the duration", () => {
        // endAt is 5 minutes away but the duration budget is 50 minutes
        const endAt = new Date(NOW + 5 * 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(5 * 60);
    });

    it("keeps the duration when endAt is further away than the duration", () => {
        const endAt = new Date(NOW + 90 * 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(50 * 60);
    });

    it("returns 0 when endAt has already passed", () => {
        const endAt = new Date(NOW - 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(0);
    });

    it("never returns a negative or fractional value", () => {
        expect(remainingSecondsWithinWindow(-10, undefined, NOW)).toBe(0);
        expect(remainingSecondsWithinWindow(120.9, undefined, NOW)).toBe(120);
    });
});

describe("studentExamCore", () => {
    it("starts the retry lookup and exam lookup in the same submission round", async () => {
        const started: string[] = [];
        let releaseAttempt!: (value: string | null) => void;
        let releaseExam!: (value: string | null) => void;
        const attempt = new Promise<string | null>(resolve => { releaseAttempt = resolve; });
        const exam = new Promise<string | null>(resolve => { releaseExam = resolve; });

        const pending = loadSubmissionBaseInParallel(
            () => { started.push("attempt"); return attempt; },
            () => { started.push("exam"); return exam; },
        );

        expect(started).toEqual(["attempt", "exam"]);
        releaseAttempt(null);
        releaseExam("exam-row");
        await expect(pending).resolves.toEqual({ existingAttempt: null, examRow: "exam-row" });
    });

    it("does not make an idempotent retry wait for the speculative exam lookup", async () => {
        let releaseExam!: (value: string | null) => void;
        const exam = new Promise<string | null>(resolve => { releaseExam = resolve; });
        const pending = loadSubmissionBaseInParallel(
            async () => "stored-attempt",
            () => exam,
        );

        await expect(pending).resolves.toEqual({ existingAttempt: "stored-attempt", examRow: null });
        releaseExam("late-exam-row");
    });

    it("requires a plan lookup only when the submission contains handwriting that can be archived", () => {
        expect(hasArchiveableHandwriting(INPUT)).toBe(false);
        expect(hasArchiveableHandwriting({
            ...INPUT,
            handwriting: {
                schemaVersion: 1,
                status: "none",
                plan: "pro",
                summary: { pageCount: 0, strokeCount: 0, questionCount: 0 },
                questions: {},
            },
            handwritingPlan: "pro",
            drawingPageCount: 0,
            drawingStrokeCount: 0,
            questionDrawings: [],
        })).toBe(false);
        expect(hasArchiveableHandwriting({ ...INPUT, drawings: { 1: ["M0 0L1 1"] } })).toBe(true);
        expect(hasArchiveableHandwriting({
            ...INPUT,
            handwriting: {
                schemaVersion: 1,
                status: "saved",
                strokesRef: { store: "indexeddb", key: "attempt:a:drawings" },
                plan: "pro",
                summary: { pageCount: 1, strokeCount: 1, questionCount: 1 },
                questions: {},
            },
        })).toBe(true);
    });

    it("server-grades and injects owner/org, ignoring any client score", () => {
        const attempt = buildServerAttempt(INPUT, EXAM, GUEST, "att1", "2026-07-01T01:30:00.000Z");
        expect(attempt.score).toBe(10);       // only q1 correct
        expect(attempt.totalScore).toBe(20);
        expect(attempt.organizationId).toBe("teacher_abc");
        expect(attempt.studentId).toBe("guest:g1");
        expect(attempt.guestId).toBe("g1");
        expect(attempt.identityType).toBe("guest");
        expect(attempt.questionResults).toHaveLength(2);
        expect(attempt.questionResults?.[0]).toMatchObject({ questionId: 1, isCorrect: true });
    });

    it("attemptOwnedBy matches guest by guestId and student by studentId", () => {
        expect(attemptOwnedBy({ studentId: "guest:g1", guestId: "g1" }, GUEST)).toBe(true);
        expect(attemptOwnedBy({ studentId: "guest:g2", guestId: "g2" }, GUEST)).toBe(false);
        const student: StudentServerIdentity = { kind: "student", studentId: "grp1::김", name: "김", identityType: "temporary", issuedAt: 0, expiresAt: 9e15 };
        expect(attemptOwnedBy({ studentId: "grp1::김" }, student)).toBe(true);
        expect(attemptOwnedBy({ studentId: "grp1::이" }, student)).toBe(false);
    });

    it("maps identity to an ExamAccessSession for evaluateExamAccess", () => {
        expect(identityAccessSession(GUEST)).toMatchObject({ isGuest: true, identityType: "guest" });
    });

    it("clamps a future startedAt to the server finish time", () => {
        const attempt = buildServerAttempt(
            { ...INPUT, startedAt: "2999-01-01T00:00:00.000Z" },
            EXAM, GUEST, "att-future", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.startedAt).toBe("2026-07-01T01:30:00.000Z");
    });

    it("floors an absurdly old startedAt to the exam window (duration + 5m grace)", () => {
        const attempt = buildServerAttempt(
            { ...INPUT, startedAt: "2000-01-01T00:00:00.000Z" },
            EXAM, GUEST, "att-old", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.startedAt).toBe("2026-07-01T00:35:00.000Z"); // 01:30 - 55m
    });

    it("keeps a valid startedAt within the exam window unchanged", () => {
        const attempt = buildServerAttempt(INPUT, EXAM, GUEST, "att-valid", "2026-07-01T01:30:00.000Z");
        expect(attempt.startedAt).toBe("2026-07-01T01:00:00.000Z");
    });

    it("grades a retake over the scoped questions only", () => {
        const retake = { sourceAttemptId: "base1", questionIds: [2], mode: "wrong" as const, createdAt: "2026-07-01T01:00:00.000Z" };
        const attempt = buildServerAttempt(
            { ...INPUT, answers: { 2: 2 }, retake },
            EXAM, GUEST, "att-retake", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.totalScore).toBe(10);          // only q2 in scope
        expect(attempt.score).toBe(10);               // q2 correct this time
        expect(attempt.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [2], mode: "wrong" });
        expect(attempt.questionResults).toHaveLength(1);
        expect(attempt.questionResults?.[0]).toMatchObject({ questionId: 2, isCorrect: true });
    });

    it("ignores retake question ids that are not on the exam", () => {
        const scope = resolveRetakeScope(EXAM, {
            sourceAttemptId: "base1", questionIds: [2, 999], mode: "custom", createdAt: "x",
        });
        expect(scope.questions.map(q => q.id)).toEqual([2]);
        expect(scope.retake?.questionIds).toEqual([2]);
    });

    it("drops the retake only when no scoped id resolves", () => {
        expect(resolveRetakeScope(EXAM, {
            sourceAttemptId: "s", questionIds: [999], mode: "wrong", createdAt: "x",
        }).retake).toBeUndefined();
        expect(resolveRetakeScope(EXAM, undefined).questions).toHaveLength(2);
    });

    it("preserves retake metadata for a full-scope retake (grades all, still a retake)", () => {
        const scope = resolveRetakeScope(EXAM, {
            sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom", createdAt: "x",
        });
        expect(scope.questions).toHaveLength(2);
        expect(scope.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom" });
    });

    it("classifies a full-scope retake attempt as a retake, not a base attempt", () => {
        const attempt = buildServerAttempt(
            {
                examId: "e1",
                submissionId: INPUT.submissionId,
                answers: { 1: 3, 2: 2 },
                startedAt: "2026-07-01T01:00:00.000Z",
                retake: { sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom", createdAt: "x" },
            },
            EXAM, GUEST, "att-full-retake", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [1, 2] });
        expect(attempt.totalScore).toBe(20); // both questions graded
    });

    it("passes handwriting metadata only with a server-authorized capability", () => {
        const attempt = buildServerAttempt(
            {
                ...INPUT,
                drawings: { 1: ["M0 0L1 1"] },
                handwritingArchived: true,
                handwritingPlan: "pro",
                questionDrawings: [{ questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 }],
            },
            EXAM, GUEST, "att-hw", "2026-07-01T01:30:00.000Z",
            { handwritingArchive: true, handwritingPlan: "pro" },
        );
        expect(attempt.drawings).toEqual({ 1: ["M0 0L1 1"] });
        expect(attempt.handwritingArchived).toBe(true);
        expect(attempt.handwritingPlan).toBe("pro");
        expect(attempt.questionDrawings).toHaveLength(1);

        const stripped = buildServerAttempt(
            {
                ...INPUT,
                drawings: { 1: ["M0 0L1 1"] },
                handwritingArchived: true,
                handwritingPlan: "academy",
            },
            EXAM, GUEST, "att-hw-free", "2026-07-01T01:30:00.000Z",
        );
        expect(stripped.drawings).toBeUndefined();
        expect(stripped.handwritingArchived).toBe(false);
        expect(stripped.handwritingPlan).toBe("free");
    });

    it("rejects missing required sub-answers manually and records gaps only for timer submission", () => {
        const exam: Exam = {
            ...EXAM,
            questions: [{
                ...EXAM.questions[0],
                subQuestions: [{ schemaVersion: 1, id: 'reason', prompt: '근거를 쓰세요.', kind: 'free_text', required: true, maxLength: 20 }],
            }],
        };
        expect(() => buildServerAttempt(INPUT, exam, GUEST, 'att-manual-missing', '2026-07-01T01:30:00.000Z'))
            .toThrow('REQUIRED_SUB_QUESTIONS_MISSING');

        const auto = buildServerAttempt({ ...INPUT, autoSubmitted: true }, exam, GUEST, 'att-auto-missing', '2026-07-01T01:30:00.000Z');
        expect(auto.missingRequiredSubQuestions).toEqual([{ questionId: 1, subQuestionId: 'reason' }]);

        const completed = buildServerAttempt({
            ...INPUT,
            subQuestionAnswers: { 1: { reason: { schemaVersion: 1, body: '본문 근거', reviewStatus: 'reviewed' } } },
        }, exam, GUEST, 'att-sub-complete', '2026-07-01T01:30:00.000Z');
        expect(completed.missingRequiredSubQuestions).toBeUndefined();
        expect(completed.subQuestionAnswers?.[1].reason).toMatchObject({ body: '본문 근거', reviewStatus: 'needs_review' });
    });
});
