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
import { buildPdfNormalizationJobs } from "../../scripts/korean-exam-pdf-core.mjs";
import {
    assertFixtureOwned,
    buildPrivateObjectPath,
    fixtureVerificationExpectations,
    parseFixtureMode,
    uniqueSupabaseTargets,
} from "../../scripts/setup-korean-exam-fixture.mjs";

// The fixture builder lives in an untyped .mjs script, so annotate the shapes
// this test reaches into to keep `tsc --noEmit` free of implicit-any.
interface FixtureQuestion { id: number; answer: number; score: number; }
interface FixtureResult { status: string; questionId: number; studentId: string; studentProfileId: string; }

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
            expect(exam.questions.map((question: FixtureQuestion) => question.id)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
            expect(exam.questions.every((question: FixtureQuestion) => Number.isInteger(question.answer) && question.answer >= 1 && question.answer <= 5)).toBe(true);
            expect(exam.questions.filter((question: FixtureQuestion) => question.score === 3)).toHaveLength(10);
            expect(exam.questions.filter((question: FixtureQuestion) => question.score === 2)).toHaveLength(35);
            expect(exam.questions.reduce((total: number, question: FixtureQuestion) => total + question.score, 0)).toBe(100);
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
        expect(original.questionResults.some((result: FixtureResult) => result.status === "wrong")).toBe(true);
        expect(original.questionResults.some((result: FixtureResult) => result.status === "unanswered")).toBe(true);
        expect(original.handwriting?.summary.strokeCount).toBeGreaterThan(0);
        expect(original.drawings).toEqual(fixture.handwritingPayloads[0].drawings);
        expect(retake.retake?.sourceAttemptId).toBe(original.id);
        expect(retake.retake?.questionIds).toEqual(
            original.questionResults.filter((result: FixtureResult) => result.status !== "correct").map((result: FixtureResult) => result.questionId),
        );
        expect(retake.questionResults.some((result: FixtureResult) => result.status === "correct")).toBe(true);
        expect(retake.questionResults.some((result: FixtureResult) => result.status === "wrong")).toBe(true);

        expect(fixture.feedback).toHaveLength(1);
        expect(fixture.feedback[0]).toMatchObject({
            id: "fixture-feedback-student1-original",
            attemptId: original.id,
            status: "returned",
        });
        expect(fixture.feedback[0].questionComments.length).toBeGreaterThan(0);
    });

    it("uses the canonical student profile id for both student read-gateway keys", () => {
        for (const attempt of fixture.attempts) {
            expect(attempt.studentId).toBe(attempt.studentProfileId);
            expect(attempt.questionResults.every((result: FixtureResult) => (
                result.studentId === attempt.studentProfileId
                && result.studentProfileId === attempt.studentProfileId
            ))).toBe(true);
        }
        expect(fixture.attemptRows.every(row => row.student_id === row.student_profile_id)).toBe(true);
        expect(fixture.questionResultRows.every(row => row.student_id === row.student_profile_id)).toBe(true);
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

    it("builds safe PDF normalization jobs from the fixture manifest", () => {
        const jobs = buildPdfNormalizationJobs(fixture.pdfArtifacts, "/workspace");

        expect(jobs).toHaveLength(3);
        expect(jobs.map(job => job.outputPath)).toEqual([
            "/workspace/output/pdf/2025학년도-수능-국어-언어와매체-홀수형.pdf",
            "/workspace/output/pdf/2026학년도-9월-모평-국어-언어와매체.pdf",
            "/workspace/output/pdf/2026학년도-수능-국어-언어와매체-홀수형.pdf",
        ]);
        expect(jobs.every(job => job.sourcePageIndexes.join(",") === NORMALIZED_SOURCE_PAGE_INDEXES.join(","))).toBe(true);
        expect(jobs.every(job => job.outputPageCount === 16)).toBe(true);
    });

    it("parses exactly one fixture runner mode", () => {
        expect(parseFixtureMode(["--dry-run"])).toBe("dry-run");
        expect(parseFixtureMode(["--apply"])).toBe("apply");
        expect(parseFixtureMode(["--verify"])).toBe("verify");
        expect(parseFixtureMode(["--remove"])).toBe("remove");
        expect(() => parseFixtureMode([])).toThrow("exactly one mode");
        expect(() => parseFixtureMode(["--apply", "--verify"])).toThrow("exactly one mode");
    });

    it("builds private object paths inside the shared organization", () => {
        expect(buildPrivateObjectPath({
            organizationId: SHARED_ORGANIZATION_ID,
            kind: "problem_pdf",
            ownerId: "fixture-korean-2025-csat-media",
            assetId: "fixture-asset-problem",
        })).toBe(
            "organizations/teacher_sharedqa/exams/fixture-korean-2025-csat-media/problem/fixture-asset-problem.pdf",
        );
        expect(buildPrivateObjectPath({
            organizationId: SHARED_ORGANIZATION_ID,
            kind: "attempt_handwriting",
            ownerId: "fixture-attempt-student1-original",
            assetId: "fixture-asset-handwriting",
        })).toBe(
            "organizations/teacher_sharedqa/attempts/fixture-attempt-student1-original/handwriting/fixture-asset-handwriting.json",
        );
        expect(() => buildPrivateObjectPath({
            organizationId: "../outside",
            kind: "problem_pdf",
            ownerId: "exam",
            assetId: "asset",
        })).toThrow("unsafe scope segment");
    });

    it("rejects collisions that are not owned by this fixture", () => {
        expect(() => assertFixtureOwned({ payload: { fixtureOwner: KOREAN_EXAM_FIXTURE_OWNER } }, "exam-1")).not.toThrow();
        expect(() => assertFixtureOwned({ payload: { fixtureOwner: "someone-else" } }, "exam-1")).toThrow(
            "refusing to overwrite",
        );
        expect(() => assertFixtureOwned(null, "exam-1")).not.toThrow();
    });

    it("deduplicates deployment targets that share one Supabase project", () => {
        expect(uniqueSupabaseTargets([
            { target: "production", url: "https://same.supabase.co", serviceRoleKey: "a" },
            { target: "preview", url: "https://same.supabase.co", serviceRoleKey: "b" },
            { target: "development", url: "https://other.supabase.co", serviceRoleKey: "c" },
        ]).map((config: { target: string }) => config.target)).toEqual(["production", "development"]);
    });

    it("exposes exact live verification expectations", () => {
        expect(fixtureVerificationExpectations(fixture)).toEqual({
            exams: 3,
            examQuestions: 135,
            attempts: 3,
            questionResults: 98,
            returnedFeedback: 1,
            remoteAssets: 4,
        });
    });
});
