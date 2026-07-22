import { describe, expect, it } from "vitest";
import {
    buildKoreanExamFixture,
    KOREAN_EXAM_FIXTURE_OWNER,
    NORMALIZED_SOURCE_PAGE_INDEXES,
    SHARED_CLASS_ID,
    SHARED_ORGANIZATION_ID,
    summarizeKoreanExamFixture,
    validateKoreanExamFixture,
} from "../../scripts/korean-exam-fixture-core.mjs";

describe("Korean exam Supabase fixture", () => {
    const fixture = buildKoreanExamFixture({ now: "2026-07-22T09:00:00.000Z" });

    it("builds three stable 45-question exams worth 100 points", () => {
        expect(fixture.owner).toBe(KOREAN_EXAM_FIXTURE_OWNER);
        expect(fixture.organizationId).toBe(SHARED_ORGANIZATION_ID);
        expect(fixture.classId).toBe(SHARED_CLASS_ID);
        expect(fixture.exams.map(exam => [exam.id, exam.title])).toEqual([
            ["fixture-korean-2025-csat-media", "[샘플] 2025학년도 수능 국어 언어와 매체"],
            ["fixture-korean-2026-september-media", "[샘플] 2026학년도 9월 모평 국어 언어와 매체"],
            ["fixture-korean-2026-csat-media", "[샘플] 2026학년도 수능 국어 언어와 매체"],
        ]);

        for (const exam of fixture.exams) {
            expect(exam.questions).toHaveLength(45);
            expect(exam.questions.map(question => question.id)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
            expect(exam.questions.every(question => Number.isInteger(question.answer) && question.answer >= 1 && question.answer <= 5)).toBe(true);
            expect(exam.questions.filter(question => question.score === 3)).toHaveLength(10);
            expect(exam.questions.filter(question => question.score === 2)).toHaveLength(35);
            expect(exam.questions.reduce((total, question) => total + question.score, 0)).toBe(100);
            expect(exam.accessConfig).toEqual({ type: "group", groupIds: [SHARED_CLASS_ID] });
            expect(exam.fixtureOwner).toBe(KOREAN_EXAM_FIXTURE_OWNER);
        }
    });

    it("normalizes common and language-and-media pages without including speech-and-writing", () => {
        expect(NORMALIZED_SOURCE_PAGE_INDEXES).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19,
        ]);
        expect(fixture.pdfArtifacts).toHaveLength(3);
        for (const artifact of fixture.pdfArtifacts) {
            expect(artifact.sourcePageIndexes).toEqual(NORMALIZED_SOURCE_PAGE_INDEXES);
            expect(artifact.outputPageCount).toBe(16);
            expect(artifact.normalizedToSourcePage[13]).toBe(17);
        }
    });

    it("seeds the requested student lifecycle states only", () => {
        expect(fixture.attempts.map(attempt => [
            attempt.id,
            attempt.studentProfileId,
            attempt.examId,
            attempt.retake?.mode ?? "original",
        ])).toEqual([
            ["fixture-attempt-student1-original", "teacher_sharedqa_student1", "fixture-korean-2025-csat-media", "original"],
            ["fixture-attempt-student1-retake", "teacher_sharedqa_student1", "fixture-korean-2025-csat-media", "wrong"],
            ["fixture-attempt-student2-original", "teacher_sharedqa_student2", "fixture-korean-2025-csat-media", "original"],
        ]);

        const original = fixture.attempts[0];
        const retake = fixture.attempts[1];
        expect(original.questionResults.some(result => result.status === "wrong")).toBe(true);
        expect(original.questionResults.some(result => result.status === "unanswered")).toBe(true);
        expect(original.handwriting?.summary.strokeCount).toBeGreaterThan(0);
        expect(retake.retake?.sourceAttemptId).toBe(original.id);
        expect(retake.retake?.questionIds).toEqual(
            original.questionResults.filter(result => result.status !== "correct").map(result => result.questionId),
        );
        expect(retake.questionResults.some(result => result.status === "correct")).toBe(true);
        expect(retake.questionResults.some(result => result.status === "wrong")).toBe(true);

        expect(fixture.feedback).toHaveLength(1);
        expect(fixture.feedback[0]).toMatchObject({
            id: "fixture-feedback-student1-original",
            attemptId: original.id,
            status: "returned",
        });
        expect(fixture.feedback[0].questionComments.length).toBeGreaterThan(0);
    });

    it("produces deterministic canonical row ids and validates the complete fixture", () => {
        const second = buildKoreanExamFixture({ now: "2026-07-22T09:00:00.000Z" });
        expect(second).toEqual(fixture);
        expect(fixture.examRows.map(row => row.id)).toEqual(fixture.exams.map(exam => exam.id));
        expect(fixture.examQuestionRows).toHaveLength(135);
        expect(new Set(fixture.examQuestionRows.map(row => row.id)).size).toBe(135);
        expect(fixture.attemptRows).toHaveLength(3);
        expect(fixture.questionResultRows).toHaveLength(
            fixture.attempts.reduce((total, attempt) => total + attempt.questionResults.length, 0),
        );
        expect(validateKoreanExamFixture(fixture)).toEqual({
            exams: 3,
            examQuestions: 135,
            attempts: 3,
            questionResults: fixture.questionResultRows.length,
            feedback: 1,
            assets: 4,
        });
    });

    it("redacts dry-run output", () => {
        const summary = JSON.stringify(summarizeKoreanExamFixture(fixture));
        expect(summary).toContain("fixture-korean-2025-csat-media");
        expect(summary).toContain("teacher_sharedqa_student3");
        expect(summary).not.toContain("service_role");
        expect(summary).not.toContain("signedUrl");
        expect(summary).not.toContain("eyJ");
    });
});
