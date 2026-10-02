import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import {
    buildTeacherCanonicalAnalyticsSnapshot,
} from "@/lib/teacherCanonicalAnalyticsSnapshot.server";
import {
    currentTeacherCanonicalAnalyticsSnapshot,
    exactTeacherCanonicalRetakeCohorts,
    teacherCanonicalQuestionCohortCsvRows,
} from "@/lib/teacherCanonicalAnalyticsSnapshotContract";
import { readFileSync } from "node:fs";

const exam: Exam = {
    id: "exam-snapshot",
    title: "제출 정의 시험",
    createdAt: "2026-08-10T00:00:00.000Z",
    questions: [{ id: 1, number: 1, answer: 2, score: 5, label: "제출 문항" }],
};

function sealedAttempt(id: string, assignmentRevision: number): Attempt {
    const base: Attempt = {
        id,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: "org-1",
        classId: "class-1",
        groupId: "class-1",
        groupName: "1반",
        assignmentId: "assignment-reused",
        assignmentRevision,
        studentProfileId: `student-${id}`,
        studentId: `student-${id}`,
        studentName: `학생 ${id}`,
        identityType: "registered",
        startedAt: "2026-08-10T00:00:00.000Z",
        finishedAt: "2026-08-10T00:10:00.000Z",
        score: 5,
        totalScore: 5,
        answers: { 1: 2 },
        status: "completed",
    };
    const questionResults = buildQuestionResults(exam, base);
    return { ...base, questionResults, ...buildCanonicalQuestionResultEvidence(base, questionResults) };
}

describe("teacher canonical analytics Flight snapshot", () => {
    it("round-trips a bounded aggregate DTO and binds the exact evidence collection identity", () => {
        const attempts = [sealedAttempt("a", 8), sealedAttempt("b", 9)];
        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, attempts);
        const flightValue = structuredClone(snapshot);

        expect(flightValue).toMatchObject({
            schemaVersion: 1,
            status: "ready",
            examId: exam.id,
            diagnostics: {
                attemptCount: 2,
                serverResolutionCount: 2,
                canonicalQuestionResultCount: 2,
                clientResolutionCount: 0,
            },
            questionStats: [expect.objectContaining({ questionId: 1, correctCount: 2 })],
            advancedAggregatesComplete: true,
        });
        expect(flightValue.classMatrix).toHaveLength(1);
        expect(exactTeacherCanonicalRetakeCohorts(flightValue, [1])).toEqual([
            expect.stringMatching(/^sha256:[a-f0-9]{64}\u001f1$/),
        ]);
        expect(JSON.stringify(flightValue)).not.toMatch(/selectedAnswer|answers/);
        expect(currentTeacherCanonicalAnalyticsSnapshot(flightValue, exam.id, attempts)).not.toBeNull();
        expect(currentTeacherCanonicalAnalyticsSnapshot(flightValue, exam.id, [
            { ...attempts[0], assignmentRevision: 10 },
            attempts[1],
        ])).toBeNull();
        expect(currentTeacherCanonicalAnalyticsSnapshot({
            ...flightValue,
            collectionKey: "sha256:" + "0".repeat(64),
        }, exam.id, attempts)).toBeNull();
        expect(teacherCanonicalQuestionCohortCsvRows(flightValue)).toEqual([
            ["제출 정의", "문항 ID", "제출 당시 번호", "제출 당시 라벨", "배점", "응답", "정답", "오답", "미응답", "정답률"],
            [expect.stringMatching(/^sha256:/), 1, 1, "제출 문항", 5, 2, 2, 0, 0, 100],
        ]);

        const editedExam: Exam = {
            ...exam,
            questions: [{ id: 2, number: 20, answer: 1, score: 100, label: "현재 편집 문항" }],
        };
        const editedSnapshot = buildTeacherCanonicalAnalyticsSnapshot(editedExam, attempts);
        expect(editedSnapshot.csvQuestionCohorts).toEqual([
            expect.objectContaining({ questionId: 1, questionNumber: 1, label: "제출 문항" }),
        ]);
        expect(exactTeacherCanonicalRetakeCohorts(editedSnapshot, [1])).toBeNull();
    });

    it("keeps the client Flight contract free of the grading verifier and server index runtime", () => {
        const source = readFileSync(`${process.cwd()}/src/lib/teacherCanonicalAnalyticsSnapshotContract.ts`, "utf8");
        expect(source).not.toContain("buildCanonicalAttemptAnalyticsIndex");
        expect(source).not.toContain("resolveAttemptGrading");
        expect(source).not.toContain("canonicalQuestionResultManifest");
    });

    it("uses exact cohort identities for analytics rows and routes retakes through the cohort resolver", () => {
        const source = readFileSync(`${process.cwd()}/src/components/dashboard/tabs/ExamAnalyticsTab.tsx`, "utf8");
        const studentSource = readFileSync(`${process.cwd()}/src/components/dashboard/tabs/StudentAnalyticsTab.tsx`, "utf8");
        expect(source).toContain("key={q.cohortKey}");
        expect(source).not.toMatch(/key=\{i\}[\s\S]{0,1200}(?:q\.index|q\.cohortLabel)/);
        expect(source).toContain("exactTeacherCanonicalWrongRetakeCohorts(canonicalSnapshot, sourceAttemptId, questionIds)");
        expect(source).toContain("if (requiresCanonicalSnapshot && !cohortKeys) return null");
        expect(source).toContain("key={student.attempt.id}");
        expect(source).not.toContain("key={i}");
        expect(studentSource).toContain("exactTeacherCanonicalWrongRetakeCohorts(officialSnapshot, attempt.id, retakeIds)");
        expect(studentSource).not.toContain("exactTeacherCanonicalRetakeCohorts");
        expect(studentSource).toContain('buildRetakeHref(attempt.examId, attempt.id, retakeIds, "wrong"');
        expect(source).toContain("key: question.cohortKey");
        expect(source).not.toContain("key: question.id");
    });

    it("fails the whole completed base-attempt snapshot closed when one canonical resolution is unavailable", () => {
        const valid = sealedAttempt("valid", 8);
        const corrupt = {
            ...sealedAttempt("corrupt", 8),
            questionResultsFullEvidenceHash: `sha256:${"0".repeat(64)}`,
        };

        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, [valid, corrupt]);

        expect(snapshot.status).toBe("unavailable");
        expect(snapshot.questionStats).toEqual([]);
        expect(snapshot.csvQuestionCohorts).toEqual([]);
        expect(snapshot.diagnostics).toMatchObject({
            attemptCount: 2,
            serverResolutionCount: 2,
            canonicalQuestionResultCount: 1,
        });
    });

    it("scopes official identity and student rows to completed canonical base attempts only", () => {
        const base = sealedAttempt("base", 8);
        const retake = {
            ...sealedAttempt("retake", 8),
            retake: {
                sourceAttemptId: base.id,
                questionIds: [1],
                mode: "wrong" as const,
                createdAt: "2026-08-10T00:20:00.000Z",
            },
        };
        const inProgress = {
            ...sealedAttempt("progress", 8),
            status: "in_progress" as const,
        };

        const snapshot = buildTeacherCanonicalAnalyticsSnapshot(exam, [base, retake, inProgress]);

        expect(snapshot.status).toBe("ready");
        expect(snapshot.diagnostics).toEqual({
            attemptCount: 1,
            serverResolutionCount: 1,
            canonicalQuestionResultCount: 1,
            clientResolutionCount: 0,
        });
        expect(snapshot.studentRows.map(row => row.attemptId)).toEqual(["base"]);
        expect(snapshot.questionStats).toEqual([
            expect.objectContaining({ totalCount: 1, correctCount: 1 }),
        ]);
        expect(currentTeacherCanonicalAnalyticsSnapshot(
            structuredClone(snapshot),
            exam.id,
            [base, retake, inProgress],
        )).not.toBeNull();
    });

    it("carries bounded per-student fresh analytics needed by the existing students workspace and CSV", () => {
        const snapshot = structuredClone(buildTeacherCanonicalAnalyticsSnapshot(exam, [sealedAttempt("student-row", 8)]));
        const value = snapshot as unknown as Record<string, unknown>;

        expect(value.studentRows).toEqual([
            expect.objectContaining({
                attemptId: "student-row",
                studentName: "학생 student-row",
                totalScore: 5,
                scorePercentage: 100,
                hasPerformanceScore: true,
                labelScores: { "제출 문항": { earned: 5, total: 5 } },
                behavior: expect.objectContaining({ averageTimeSec: expect.any(Number) }),
                retakeQuestionIds: [],
                questionCsvRows: expect.arrayContaining([
                    ["문항 번호", "라벨(장르)", "배점", "학생 선택", "정답", "정오"],
                    [1, "제출 문항", 5, 2, 2, "O"],
                ]),
            }),
        ]);
    });

    it("rejects extra keys, accessors, non-finite values, count drift, and invalid status/cohort relations", () => {
        const attempts = [sealedAttempt("strict", 8)];
        const snapshot = structuredClone(buildTeacherCanonicalAnalyticsSnapshot(exam, attempts));
        const invalidValues: unknown[] = [
            { ...snapshot, secret: "must-not-pass" },
            { ...snapshot, diagnostics: { ...snapshot.diagnostics, extra: true } },
            { ...snapshot, diagnostics: { ...snapshot.diagnostics, canonicalQuestionResultCount: Number.NaN } },
            { ...snapshot, status: "unavailable", questionStats: snapshot.questionStats },
            { ...snapshot, status: "ready", questionStats: [], csvQuestionCohorts: [] },
            { ...snapshot, csvQuestionCohorts: [] },
            { ...snapshot, pointBiserial: [["unknown-cohort", 0.4]] },
            {
                ...snapshot,
                classMatrix: snapshot.classMatrix.map((row, index) => index === 0
                    ? { ...row, secret: "nested-secret" }
                    : row),
            },
        ];
        const accessor = { ...snapshot } as Record<string, unknown>;
        Object.defineProperty(accessor, "questionStats", {
            enumerable: true,
            get() {
                throw new Error("client parser must not invoke accessors");
            },
        });
        invalidValues.push(accessor);

        const nestedAccessor = structuredClone(snapshot);
        Object.defineProperty(nestedAccessor.studentRows[0].behavior, "focusLossCount", {
            enumerable: true,
            get() {
                throw new Error("nested accessors must never be invoked");
            },
        });
        invalidValues.push(nestedAccessor);
        invalidValues.push({
            ...snapshot,
            studentRows: snapshot.studentRows.map(row => ({
                ...row,
                behavior: { ...row.behavior, secret: "nested-secret" },
            })),
        });
        invalidValues.push({
            ...snapshot,
            studentRows: snapshot.studentRows.map(row => ({
                ...row,
                labelScores: { ...row.labelScores, "비밀\n키": { earned: 1, total: 1 } },
            })),
        });
        invalidValues.push({
            ...snapshot,
            studentRows: snapshot.studentRows.map(row => ({
                ...row,
                labelOutcomes: { 제출: { correct: 2, total: 1 } },
            })),
        });
        invalidValues.push({
            ...snapshot,
            studentRows: snapshot.studentRows.map(row => ({
                ...row,
                questionCsvRows: [["제목", { secret: "cell" }]],
            })),
        });

        for (const invalid of invalidValues) {
            expect(currentTeacherCanonicalAnalyticsSnapshot(invalid, exam.id, attempts)).toBeNull();
        }
    });

    it("rejects malformed optional official question-stat fields in both analytics and CSV cohorts", () => {
        const attempts = [sealedAttempt("strict-optionals", 8)];
        const snapshot = structuredClone(buildTeacherCanonicalAnalyticsSnapshot(exam, attempts));
        const malformedFields: Array<Record<string, unknown>> = [
            { averageTimeSec: -1 },
            { averageVisitCount: Number.NaN },
            { expectedTimeSec: -1 },
            { timeOverExpectedRate: 101 },
            { correctAnswer: "2" },
            { correctAnswer: 6 },
            { difficulty: "legendary" },
            { mistakeTypes: ["실수", 3] },
            { answerChangeCount: 0.5 },
            { handwritingStrokeCount: -1 },
            { topWrongOption: { option: 1, count: 1, rate: 50, secret: true } },
        ];

        for (const malformed of malformedFields) {
            const questionStats = snapshot.questionStats.map((row, index) => index === 0 ? { ...row, ...malformed } : row);
            const csvQuestionCohorts = structuredClone(questionStats);
            expect(currentTeacherCanonicalAnalyticsSnapshot({
                ...snapshot,
                questionStats,
                csvQuestionCohorts,
            }, exam.id, attempts), JSON.stringify(malformed)).toBeNull();
        }
    });
});
