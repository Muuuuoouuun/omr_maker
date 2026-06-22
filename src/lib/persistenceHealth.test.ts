import { describe, expect, it } from "vitest";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import { summarizeAnalyticsDataHealth, summarizePersistenceHealth } from "./persistenceHealth";

const exam: Exam = {
    id: "exam-1",
    title: "중간고사",
    createdAt: "2026-06-15T09:00:00.000Z",
    pdfDataRef: { store: "indexeddb", key: "exam-pdf" },
    questions: [
        {
            id: 1,
            number: 1,
            answer: 1,
            label: "문법",
            tags: { concept: "높임 표현", mistakeTypes: ["개념 혼동"] },
            pdfLocation: { page: 1, x: 0.2, y: 0.2 },
            pdfRegion: { page: 1, x: 0, y: 0, width: 1, height: 0.5 },
        },
        {
            id: 2,
            number: 2,
            answer: 2,
            label: "독해",
            tags: { concept: "인과 추론" },
            pdfLocation: { page: 1, x: 0.2, y: 0.7 },
            pdfRegion: { page: 1, x: 0, y: 0.5, width: 1, height: 0.5 },
        },
    ],
};

function result(questionId: number, questionNumber = questionId): QuestionResult {
    return {
        schemaVersion: 1,
        attemptId: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        questionId,
        questionNumber,
        score: 5,
        earnedScore: questionId === 1 ? 5 : 0,
        selectedAnswer: questionId === 1 ? 1 : 1,
        correctAnswer: questionId,
        status: questionId === 1 ? "correct" : "wrong",
        isCorrect: questionId === 1,
        isWrong: questionId !== 1,
        isUnanswered: false,
        finishedAt: "2026-06-15T09:30:00.000Z",
    };
}

function attempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 5,
        totalScore: 10,
        answers: { 1: 1, 2: 1 },
        questionResults: [result(1), result(2)],
        status: "completed",
        ...overrides,
    };
}

describe("persistence health", () => {
    it("reports checking mode before any persistence source has loaded", () => {
        expect(summarizePersistenceHealth([])).toMatchObject({
            kind: "checking",
            label: "동기화 확인 중",
            detail: "저장 상태를 확인하고 있습니다",
            pendingCount: 0,
            remoteLoaded: false,
        });
    });

    it("reports local mode when remote persistence is not configured", () => {
        expect(summarizePersistenceHealth([
            { remoteLoaded: false },
            { remoteLoaded: false },
        ])).toMatchObject({
            kind: "local",
            label: "로컬 저장",
            detail: "Supabase 미연결",
            pendingCount: 0,
            remoteLoaded: false,
        });
    });

    it("reports synced mode when every loaded source is synced", () => {
        expect(summarizePersistenceHealth([
            { remoteLoaded: true, remoteSynced: true },
            { remoteLoaded: true, remoteSynced: true },
        ])).toMatchObject({
            kind: "synced",
            label: "Supabase 동기화",
            detail: "최신 데이터 기준",
            remoteLoaded: true,
        });
    });

    it("reports pending sync work across sources", () => {
        expect(summarizePersistenceHealth([
            { remoteLoaded: true, remoteSynced: false, pendingSyncCount: 1 },
            { remoteLoaded: true, remoteSynced: true, pendingSyncCount: 2 },
        ])).toMatchObject({
            kind: "pending",
            label: "동기화 대기",
            detail: "3건 재시도 대기",
            pendingCount: 3,
        });
    });

    it("lets remote errors override pending and synced labels", () => {
        expect(summarizePersistenceHealth([
            { remoteLoaded: false, remoteError: "network failed" },
            { remoteLoaded: true, remoteSynced: false, pendingSyncCount: 2 },
        ])).toMatchObject({
            kind: "error",
            label: "동기화 확인 필요",
            detail: "2건 재시도 대기",
            pendingCount: 2,
            error: "network failed",
        });
    });
});

describe("analytics data health", () => {
    it("reports empty mode before real exams or attempts exist", () => {
        expect(summarizeAnalyticsDataHealth([], [])).toMatchObject({
            kind: "empty",
            label: "데이터 대기",
            score: 0,
            totalExamCount: 0,
            totalAttemptCount: 0,
        });
    });

    it("reports ready mode when exam metadata and question result rows are complete", () => {
        const health = summarizeAnalyticsDataHealth([exam], [attempt()]);

        expect(health).toMatchObject({
            kind: "ready",
            label: "분석 데이터 준비",
            score: 100,
            totalQuestionCount: 2,
            resultReadyAttemptCount: 1,
        });
        expect(health.issues).toEqual([]);
    });

    it("treats retake result coverage against the assigned retake questions only", () => {
        const health = summarizeAnalyticsDataHealth([exam], [
            attempt({
                id: "retake-attempt",
                answers: { 2: 2 },
                questionResults: [result(2)],
                retake: {
                    sourceAttemptId: "attempt-1",
                    questionIds: [2],
                    mode: "wrong",
                    createdAt: "2026-06-16T10:00:00.000Z",
                },
            }),
        ]);

        expect(health).toMatchObject({
            kind: "ready",
            resultReadyAttemptCount: 1,
        });
        expect(health.issues.map(issue => issue.key)).not.toContain("partial-results");
        expect(health.issues.map(issue => issue.key)).not.toContain("missing-results");
    });

    it("blocks analytics quality when attempts cannot join exams or question results are missing", () => {
        const health = summarizeAnalyticsDataHealth([exam], [
            attempt({ id: "missing-results", questionResults: [] }),
            attempt({ id: "orphan", examId: "deleted-exam", questionResults: [] }),
        ]);

        expect(health.kind).toBe("blocked");
        expect(health.issues.map(issue => issue.key)).toEqual([
            "orphan-attempts",
            "missing-results",
        ]);
    });

    it("surfaces metadata and PDF-region gaps as attention items", () => {
        const weakExam: Exam = {
            ...exam,
            questions: [
                {
                    id: 1,
                    number: 1,
                    pdfLocation: { page: 1, x: 0.2, y: 0.2 },
                },
            ],
        };

        const health = summarizeAnalyticsDataHealth([weakExam], []);

        expect(health.kind).toBe("attention");
        expect(health.issues.map(issue => issue.key)).toEqual([
            "missing-answers",
            "untagged-questions",
            "region-missing",
        ]);
    });
});
