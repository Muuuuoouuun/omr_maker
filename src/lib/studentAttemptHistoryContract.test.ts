import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    attemptFromStudentAttemptRecord,
    studentTrustedOfficialReviewFromUnknown,
    studentAttemptRecordFromAttempt,
    type StudentAttemptRecord,
} from "@/lib/studentAttemptHistoryContract";

function repairedAttempt(): Attempt {
    return {
        id: "attempt-legacy-repair",
        examId: "exam-1",
        examTitle: "과거 시험",
        studentId: "student-1",
        studentName: "김학생",
        identityType: "registered",
        startedAt: "2026-08-01T00:00:00.000Z",
        finishedAt: "2026-08-01T00:10:00.000Z",
        score: 10,
        totalScore: 10,
        answers: { 1: 2 },
        status: "completed",
        questionResultsSource: "legacy_derived_current_exam",
        questionResults: [{
            schemaVersion: 1,
            attemptId: "attempt-legacy-repair",
            examId: "exam-1",
            examTitle: "과거 시험",
            studentId: "student-1",
            studentName: "김학생",
            identityType: "registered",
            questionId: 1,
            questionNumber: 1,
            score: 10,
            earnedScore: 10,
            selectedAnswer: 2,
            correctAnswer: 2,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            finishedAt: "2026-08-01T00:10:00.000Z",
        }],
    };
}

describe("student attempt history grading provenance", () => {
    it("round-trips the strict legacy-derived marker", () => {
        const record = studentAttemptRecordFromAttempt(repairedAttempt());

        expect(record?.questionResultsSource).toBe("legacy_derived_current_exam");
        expect(attemptFromStudentAttemptRecord(record!).questionResultsSource).toBe("legacy_derived_current_exam");
    });

    it("fails closed for a malformed record source", () => {
        const record = studentAttemptRecordFromAttempt(repairedAttempt())!;
        const malformed = { ...record, questionResultsSource: "canonical_submission" } as unknown as StudentAttemptRecord;

        expect(attemptFromStudentAttemptRecord(malformed).questionResultsSource).toBe("incomplete_or_invalid");
        expect(studentAttemptRecordFromAttempt({
            ...repairedAttempt(),
            questionResultsSource: "canonical_submission" as never,
        })).toBeNull();
    });

    it("rejects trusted reviews whose question/result identity, grading semantics, or totals drift", () => {
        const valid = {
            gradingSource: "canonical_submission",
            questions: [{ id: 1, number: 1, answer: 2, choices: 4, score: 5, label: "독해" }],
            questionResults: [{
                questionId: 1,
                questionNumber: 1,
                selectedAnswer: 2,
                correctAnswer: 2,
                score: 5,
                earnedScore: 5,
                status: "correct",
            }],
            scoreSummary: {
                earnedScore: 5,
                totalScore: 5,
                scorePercent: 100,
                gradedQuestionCount: 1,
                ungradedQuestionCount: 0,
            },
            weaknessGroups: [],
            recommendations: [],
            behavior: {
                elapsedTimeSec: 60,
                totalTrackedTimeSec: 30,
                averageTimeSec: 30,
                slowQuestionNumbers: [],
                rushedQuestionNumbers: [],
                revisitedQuestionNumbers: [],
                answerChangedQuestionNumbers: [],
                focusLossCount: 0,
                focusLossQuestionNumbers: [],
            },
        };
        expect(studentTrustedOfficialReviewFromUnknown(structuredClone(valid))).not.toBeNull();

        const invalidValues = [
            { ...valid, questions: [{ ...valid.questions[0], id: 2 }] },
            { ...valid, questions: [valid.questions[0], { ...valid.questions[0] }], questionResults: [valid.questionResults[0], { ...valid.questionResults[0] }] },
            { ...valid, questionResults: [{ ...valid.questionResults[0], selectedAnswer: 1 }] },
            { ...valid, questionResults: [{ ...valid.questionResults[0], earnedScore: 4 }] },
            { ...valid, questionResults: [{ ...valid.questionResults[0], status: "wrong", selectedAnswer: 2 }] },
            { ...valid, scoreSummary: { ...valid.scoreSummary, earnedScore: 4 } },
            { ...valid, scoreSummary: { ...valid.scoreSummary, gradedQuestionCount: 0 } },
        ];
        for (const invalid of invalidValues) {
            expect(studentTrustedOfficialReviewFromUnknown(structuredClone(invalid))).toBeNull();
        }
    });
});
