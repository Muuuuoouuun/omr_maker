import { describe, expect, it } from "vitest";
import type { QuestionResult } from "@/types/omr";
import {
    buildCanonicalQuestionResultEvidence,
    buildCanonicalQuestionResultManifest,
} from "@/lib/canonicalQuestionResultManifest";
import { sha256HexUtf8 } from "@/lib/sha256";

function row(overrides: Partial<QuestionResult>): QuestionResult {
    return {
        schemaVersion: 1,
        attemptId: "attempt-1",
        examId: "exam-1",
        examTitle: "시험",
        studentName: "학생",
        questionId: 1,
        questionNumber: 1,
        score: 5,
        earnedScore: 5,
        selectedAnswer: 2,
        correctAnswer: 2,
        status: "correct",
        isCorrect: true,
        isWrong: false,
        isUnanswered: false,
        finishedAt: "2026-08-10T00:00:00.000Z",
        ...overrides,
    };
}

describe("canonical question-result manifest", () => {
    it("uses byte-exact UTF-8 SHA-256 without a client crypto bundle", () => {
        expect(sha256HexUtf8("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256HexUtf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(sha256HexUtf8("채점 근거")).toBe("6f83d78a620a43592f5d4139f1f823662a4e78cc2404d5fb89d93ca748fb6472");
    });
    it("domain-separates a stable sorted digest over immutable grading fields", () => {
        const rows = [
            row({ questionId: 2, questionNumber: 7, score: 0, earnedScore: 0, selectedAnswer: undefined, correctAnswer: undefined, status: "ungraded", isCorrect: false }),
            row({ questionId: 1, questionNumber: 3, score: 5, correctAnswer: 2 }),
        ];

        const manifest = buildCanonicalQuestionResultManifest(rows);
        expect(manifest).toEqual({
            questionResultsQuestionCount: 2,
            questionResultsDefinitionManifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(buildCanonicalQuestionResultManifest([...rows].reverse())).toEqual(manifest);
        expect(buildCanonicalQuestionResultManifest(rows.map(item => (
            item.questionId === 2 ? { ...item, questionNumber: 8 } : item
        )))).not.toEqual(manifest);
        expect(buildCanonicalQuestionResultManifest(rows.map(item => (
            item.questionId === 1 ? { ...item, correctAnswer: 3 } : item
        )))).not.toEqual(manifest);
    });

    it("separately seals exact submission scope and every official grading field", () => {
        const rows = [row({ organizationId: "org-1", classId: "class-1", studentId: "student-1", studentProfileId: "student-1", identityType: "registered" })];
        const attempt = {
            id: "attempt-1",
            examId: "exam-1",
            organizationId: "org-1",
            classId: "class-1",
            assignmentId: "assignment-1",
            assignmentRevision: 8,
            studentProfileId: "student-1",
            studentId: "student-1",
            identityType: "registered" as const,
            studentName: "학생",
            startedAt: "2026-08-10T00:00:00.000Z",
            finishedAt: "2026-08-10T00:10:00.000Z",
            score: 5,
            totalScore: 5,
            status: "completed" as const,
        };
        rows[0].assignmentId = "assignment-1";
        rows[0].assignmentRevision = 8;

        const evidence = buildCanonicalQuestionResultEvidence(attempt, rows);
        expect(evidence).toEqual({
            questionResultsQuestionCount: 1,
            questionResultsDefinitionManifestHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            questionResultsFullEvidenceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(buildCanonicalQuestionResultEvidence(attempt, [{ ...rows[0], selectedAnswer: 3, status: "wrong", earnedScore: 0, isCorrect: false, isWrong: true }]))
            .not.toEqual(evidence);
        expect(buildCanonicalQuestionResultEvidence({ ...attempt, assignmentRevision: 9 }, [{ ...rows[0], assignmentRevision: 9 }]))
            .not.toEqual(evidence);
        expect(buildCanonicalQuestionResultEvidence(attempt, [{ ...rows[0], timeSec: 12 }]))
            .not.toEqual(evidence);
    });

    it("uses exact versioned micro-unit number encoding across decimal and exponent spellings", () => {
        const decimalRows = [row({ score: 2, earnedScore: 2, timeSec: 1.000001 })];
        const exponentRows = [row({ score: 2e0, earnedScore: 20e-1, timeSec: 1000001e-6 })];
        const decimalAttempt = {
            id: "attempt-1", examId: "exam-1", studentName: "학생",
            startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:10:00.000Z",
            score: 2, totalScore: 2, status: "completed" as const,
        };
        const exponentAttempt = { ...decimalAttempt, score: 2e0, totalScore: 20e-1 };

        expect(buildCanonicalQuestionResultEvidence(decimalAttempt, decimalRows))
            .toEqual(buildCanonicalQuestionResultEvidence(exponentAttempt, exponentRows));
    });

    it("rejects negative zero, sub-micro precision, and out-of-range nested numbers", () => {
        const attempt = {
            id: "attempt-1", examId: "exam-1", studentName: "학생",
            startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:10:00.000Z",
            score: 5, totalScore: 5, status: "completed" as const,
        };
        expect(() => buildCanonicalQuestionResultEvidence(attempt, [row({ score: -0 })])).toThrow();
        expect(() => buildCanonicalQuestionResultEvidence(attempt, [row({ timeSec: 0.000001 })])).not.toThrow();
        expect(() => buildCanonicalQuestionResultEvidence(attempt, [row({ timeSec: 1.000001 })])).not.toThrow();
        expect(() => buildCanonicalQuestionResultEvidence({ ...attempt, totalScore: 9_000_000_000 }, [row({})]))
            .not.toThrow();
        expect(() => buildCanonicalQuestionResultEvidence(attempt, [row({ timeSec: 1e-7 })])).toThrow(/precision/i);
        expect(() => buildCanonicalQuestionResultEvidence(attempt, [row({
            pdfRegion: { page: 1, x: 0.1234567, y: 0, width: 1, height: 1 },
        })])).toThrow(/precision/i);
        expect(() => buildCanonicalQuestionResultEvidence({ ...attempt, totalScore: 9_000_000_001 }, [row({})]))
            .toThrow(/range/i);
    });

    it("rejects duplicate, empty, accessor, and nonfinite manifest inputs", () => {
        const valid = row({});
        expect(() => buildCanonicalQuestionResultManifest([])).toThrow();
        expect(() => buildCanonicalQuestionResultManifest([valid, { ...valid }])).toThrow();
        expect(() => buildCanonicalQuestionResultManifest([{ ...valid, score: Number.NaN }])).toThrow();
        expect(() => buildCanonicalQuestionResultManifest([Object.defineProperty({ ...valid }, "questionId", {
            enumerable: true,
            get() { return 1; },
        })])).toThrow();
    });

    it("canonicalizes nested passage geometry and handwriting counters exactly once", () => {
        const attempt = {
            id: "attempt-1", examId: "exam-1", studentName: "학생",
            startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:10:00.000Z",
            score: 5, totalScore: 5, status: "completed" as const,
        };
        const nested = row({
            passagePdfRegions: [{ page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
            pdfRegion: { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
            handwritingStrokeCount: 12,
            handwritingPage: 1,
        });
        expect(buildCanonicalQuestionResultEvidence(attempt, [nested]))
            .toEqual(buildCanonicalQuestionResultEvidence(attempt, [{
                ...nested,
                passagePdfRegions: nested.passagePdfRegions?.map(region => ({ ...region })),
            }]));
    });
});
