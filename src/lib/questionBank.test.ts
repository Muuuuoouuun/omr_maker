import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    buildQuestionBankReadiness,
    buildQuestionBankRecords,
    canonicalQuestionIdFor,
    ensureQuestionResultCanonicalId,
    summarizeQuestionBankReadiness,
} from "./questionBank";

const exam: Exam = {
    id: "exam-1",
    title: "6월 모의고사",
    createdAt: "2026-06-15T10:00:00.000Z",
    questions: [
        {
            id: 1,
            number: 1,
            answer: 3,
            score: 4,
            label: "문법",
            tags: { concept: "높임 표현", skill: "어법 판단", mistakeTypes: ["개념 혼동"] },
            pdfLocation: { page: 1, x: 0.2, y: 0.3 },
        },
        {
            id: 2,
            number: 2,
            answer: 5,
            score: 4,
            label: "문학",
            tags: { concept: "화자의 정서", unit: "현대시" },
            pdfRegion: { page: 1, x: 0.12, y: 0.44, width: 0.62, height: 0.2 },
        },
        {
            id: 3,
            number: 3,
        },
    ],
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "6월 모의고사",
    studentName: "김학생",
    studentId: "student-1",
    groupId: "class-a",
    groupName: "A반",
    startedAt: "2026-06-15T10:00:00.000Z",
    finishedAt: "2026-06-15T10:40:00.000Z",
    score: 50,
    totalScore: 100,
    answers: { 1: 2, 2: 5 },
    status: "completed",
    questionResults: [
        {
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "6월 모의고사",
            studentName: "김학생",
            studentId: "student-1",
            groupId: "class-a",
            groupName: "A반",
            questionId: 1,
            questionNumber: 1,
            score: 4,
            earnedScore: 0,
            selectedAnswer: 2,
            correctAnswer: 3,
            status: "wrong",
            isCorrect: false,
            isWrong: true,
            isUnanswered: false,
            concept: "높임 표현",
            finishedAt: "2026-06-15T10:40:00.000Z",
        },
    ],
};

describe("question bank readiness", () => {
    it("uses stable canonical IDs for question DB rows", () => {
        expect(canonicalQuestionIdFor("exam-1", 7)).toBe("exam-1:7");
        expect(ensureQuestionResultCanonicalId({
            ...attempt.questionResults![0],
            canonicalQuestionId: undefined,
        }).canonicalQuestionId).toBe("exam-1:1");
    });

    it("builds question records that can power analytics before cropped images exist", () => {
        const records = buildQuestionBankRecords(exam, [attempt]);

        expect(records).toHaveLength(3);
        expect(records[0]).toMatchObject({
            canonicalQuestionId: "exam-1:1",
            analysisReady: true,
            cropReady: false,
            imageAssetRequired: true,
            resultRowCount: 1,
            attemptAnswerCount: 1,
            readinessStatus: "crop_needed",
            missingActions: ["문항 영역 커팅"],
        });
        expect(records[1]).toMatchObject({
            canonicalQuestionId: "exam-1:2",
            analysisReady: true,
            cropReady: true,
            imageAssetRequired: false,
            resultRowCount: 0,
            attemptAnswerCount: 1,
            readinessStatus: "ready",
        });
        expect(records[1].missingActions).toEqual(["제출 결과 수집"]);
        expect(records[2]).toMatchObject({
            analysisReady: false,
            cropReady: false,
            readinessStatus: "metadata_needed",
        });
        expect(records[2].missingActions).toEqual([
            "정답 입력",
            "유형/개념 태그",
            "PDF 문항 위치 지정",
            "제출 결과 수집",
        ]);
    });

    it("summarizes readiness separately for analysis and future image crops", () => {
        const summary = buildQuestionBankReadiness(exam, [attempt]);

        expect(summary).toMatchObject({
            totalQuestions: 3,
            analysisReadyCount: 2,
            cropReadyCount: 1,
            metadataReadyCount: 2,
            resultBackedCount: 1,
            imageAssetRequiredCount: 2,
            analysisReadyRate: 67,
            cropReadyRate: 33,
            metadataReadyRate: 67,
        });
        expect(summary.weakestRecords.map(record => record.questionNumber)).toEqual([3, 1, 2]);
        expect(summarizeQuestionBankReadiness([])).toMatchObject({
            totalQuestions: 0,
            analysisReadyRate: 0,
            cropReadyRate: 0,
            metadataReadyRate: 0,
        });
    });

    it("treats an existing cropped image asset as visual DB-ready even without a PDF region", () => {
        const imageReadyExam: Exam = {
            ...exam,
            questions: [
                {
                    id: 10,
                    number: 10,
                    answer: 2,
                    label: "독서",
                    tags: { concept: "인과 추론" },
                    imageAssetRef: { store: "indexeddb", key: "question-10-image" },
                },
            ],
        };

        const [record] = buildQuestionBankRecords(imageReadyExam);

        expect(record).toMatchObject({
            canonicalQuestionId: "exam-1:10",
            analysisReady: true,
            cropReady: true,
            hasImageAsset: true,
            imageAssetRequired: false,
            readinessStatus: "ready",
            missingActions: ["제출 결과 수집"],
        });
    });
});
