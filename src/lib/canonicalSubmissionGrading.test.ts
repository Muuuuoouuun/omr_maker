import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import {
    buildExamQuestionPointBiserial,
    buildCanonicalAttemptAnalyticsIndex,
    buildExamQuestionResultStats,
    buildQuestionResults,
    buildSimilarQuestionGroups,
    buildStudentReviewQuestionSnapshot,
    buildStudentWeaknessGroups,
    getAttemptQuestionResults,
} from "@/lib/premiumAnalytics";
import { studentAttemptRecordFromAttempt } from "@/lib/studentAttemptHistoryContract";
import { localResultCacheFromServerReceipt } from "@/lib/studentAttemptReceipt";
import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    questionResultRowsForAttempt,
} from "@/lib/omrPersistence";
import {
    attestCanonicalQuestionResultEvidence,
    buildCanonicalQuestionResultEvidence,
} from "@/lib/canonicalQuestionResultManifest";
import { attemptFromSupabaseListRow } from "@/lib/supabaseListProjection";
import {
    buildTeacherCanonicalAnalyticsSnapshot,
} from "@/lib/teacherCanonicalAnalyticsSnapshot.server";
import { currentTeacherCanonicalAnalyticsSnapshot } from "@/lib/teacherCanonicalAnalyticsSnapshotContract";

const submittedExam: Exam = {
    id: "exam-immutable",
    title: "제출 당시 시험",
    createdAt: "2026-08-09T00:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 2, score: 40, label: "원래 1번", tags: { concept: "원래 개념 1" } },
        { id: 2, number: 2, answer: 4, score: 60, label: "원래 2번", tags: { concept: "원래 개념 2" } },
    ],
};

function targetedAttempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-targeted",
        examId: submittedExam.id,
        examTitle: submittedExam.title,
        organizationId: "org-1",
        classId: "class-1",
        assignmentId: "assignment-reused",
        assignmentRevision: 8,
        studentProfileId: "student-1",
        studentId: "student-1",
        studentName: "김학생",
        groupId: "class-1",
        groupName: "A반",
        identityType: "registered",
        startedAt: "2026-08-09T00:00:00.000Z",
        finishedAt: "2026-08-09T00:10:00.000Z",
        score: 40,
        totalScore: 100,
        answers: { 1: 2, 2: 1 },
        status: "completed",
        ...overrides,
    };
}

function canonicalAttempt(overrides: Partial<Attempt> = {}): Attempt {
    const base = targetedAttempt(overrides);
    const questionResults = buildQuestionResults(submittedExam, base);
    return { ...base, questionResults, ...buildCanonicalQuestionResultEvidence(base, questionResults) };
}

describe("canonical submission grading evidence", () => {
    it("keeps the hash verifier out of client-safe persistence and injects it only at server read boundaries", () => {
        const persistenceSource = readFileSync(resolve(process.cwd(), "src/lib/omrPersistence.ts"), "utf8");
        const listProjectionSource = readFileSync(resolve(process.cwd(), "src/lib/supabaseListProjection.ts"), "utf8");
        const serverGatewaySource = readFileSync(resolve(process.cwd(), "src/lib/teacherAttemptGateway.ts"), "utf8");
        const studentCoreSource = readFileSync(resolve(process.cwd(), "src/lib/studentExamCore.ts"), "utf8");
        const studentServerGradingSource = readFileSync(resolve(process.cwd(), "src/lib/studentExamServerGrading.ts"), "utf8");
        const solveSource = readFileSync(resolve(process.cwd(), "src/app/solve/[id]/page.tsx"), "utf8");

        expect(persistenceSource).not.toContain("@/lib/canonicalQuestionResultManifest");
        expect(listProjectionSource).not.toMatch(/from ["']@\/lib\/canonicalQuestionResultManifest["']/);
        expect(serverGatewaySource).toContain("attestCanonicalQuestionResultEvidence");
        expect(serverGatewaySource).toContain("attemptFromSupabaseRow(record, attestCanonicalQuestionResultEvidence)");
        expect(studentCoreSource).not.toContain("canonicalQuestionResultManifest");
        expect(studentCoreSource).not.toContain("premiumAnalytics");
        expect(studentServerGradingSource).toContain("buildCanonicalQuestionResultEvidence");
        expect(studentServerGradingSource).toContain("buildQuestionResults");
        expect(solveSource).not.toContain('from "@/lib/premiumAnalytics"');
        expect(solveSource).toContain('from "@/lib/questionResultBuilder"');
    });

    it("keeps full fresh roster profile analytics behind a server DTO boundary", () => {
        const usersSource = readFileSync(resolve(process.cwd(), "src/app/teacher/users/page.tsx"), "utf8");
        const profileActionSource = readFileSync(resolve(process.cwd(), "src/app/actions/teacherRosterProfiles.ts"), "utf8");

        expect(usersSource).not.toContain('import("@/lib/studentProfileAnalytics")');
        expect(usersSource).not.toContain('import("@/lib/groupProfileAnalytics")');
        expect(usersSource).not.toMatch(/import\s*\{[\s\S]*?buildRegionalLearningScopes[\s\S]*?\}\s*from\s*"@\/lib\/regionalAnalytics"/);
        expect(usersSource).toContain('import("@/lib/regionalAnalytics")');
        expect(usersSource).not.toMatch(/import\s*\{\s*loadTeacherCanonicalRosterProfile\s*\}\s*from/);
        expect(usersSource).toContain('await import("@/app/actions/teacherRosterProfiles")');
        expect(usersSource.match(/await import\("@\/app\/actions\/teacherRosterProfiles"\);\s*if \(!completionIsCurrent\(\)\) return;/g)).toHaveLength(2);
        expect(usersSource).toContain("profileLoadGenerationRef.current !== requestGeneration");
        expect(usersSource).toContain("sameTeacherRosterLoadIdentity(capturedIdentity, current)");
        expect(usersSource).toContain("rosterLoadStateRef.current");
        expect(usersSource).toContain("setStudentProfileResult(null)");
        expect(usersSource).toContain("setGroupProfileResult(null)");
        expect(usersSource).toContain("loadTeacherCanonicalRosterProfile");
        expect(profileActionSource).toContain("buildStudentProfileInsight");
        expect(profileActionSource).toContain("buildGroupProfileInsight");
        expect(profileActionSource).toContain("listTeacherAttemptSummariesWithGateway");
        expect(profileActionSource).toContain("loadTeacherAttemptWithGateway");
        expect(profileActionSource).not.toContain("listTeacherAttemptsWithGateway");
        expect(profileActionSource).toContain("listTeacherExamsWithGateway");
        expect(profileActionSource).toContain("loadTeacherRosterWithGateway");
    });

    it("keeps the submitted correct answer and question set after the current exam is edited", () => {
        const attempt = canonicalAttempt();
        const editedExam: Exam = {
            ...submittedExam,
            questions: [
                { id: 1, number: 11, answer: 3, score: 100, label: "수정 1번", tags: { concept: "수정 개념" } },
                { id: 3, number: 3, answer: 1, score: 100, label: "새 문항" },
            ],
        };

        expect(getAttemptQuestionResults(editedExam, attempt)).toEqual([
            expect.objectContaining({
                questionId: 1,
                questionNumber: 1,
                correctAnswer: 2,
                selectedAnswer: 2,
                status: "correct",
                score: 40,
                label: "원래 1번",
            }),
            expect.objectContaining({
                questionId: 2,
                questionNumber: 2,
                correctAnswer: 4,
                status: "wrong",
                score: 60,
                label: "원래 2번",
            }),
        ]);
        expect(buildStudentWeaknessGroups(editedExam, attempt)).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: "원래 개념 2", questionIds: [2] }),
        ]));
        expect(buildSimilarQuestionGroups(editedExam, [attempt])).toEqual(expect.arrayContaining([
            expect.objectContaining({ title: "원래 개념 2", questionIds: [2] }),
        ]));
        expect(buildExamQuestionResultStats(editedExam, [attempt])).toEqual([
            expect.objectContaining({ questionId: 1, questionNumber: 1, label: "원래 1번", correctAnswer: 2 }),
            expect.objectContaining({ questionId: 2, questionNumber: 2, label: "원래 2번", correctAnswer: 4 }),
        ]);
        expect([...buildExamQuestionPointBiserial(editedExam, [attempt]).keys()]).toEqual([
            `${attempt.questionResultsDefinitionManifestHash}\u001f1`,
            `${attempt.questionResultsDefinitionManifestHash}\u001f2`,
        ]);
        expect(buildStudentReviewQuestionSnapshot(editedExam, attempt)).toEqual([
            expect.objectContaining({ id: 1, number: 1, answer: 2, score: 40, label: "원래 1번" }),
            expect.objectContaining({ id: 2, number: 2, answer: 4, score: 60, label: "원래 2번" }),
        ]);
    });

    it("retains immutable correctAnswer evidence only in the completed owner's detail projection", () => {
        const attempt = canonicalAttempt();

        const listRecord = studentAttemptRecordFromAttempt(attempt);
        const detailRecord = studentAttemptRecordFromAttempt(attempt, { includeCanonicalEvidence: true });
        expect(listRecord?.questionResults[0]).not.toHaveProperty("correctAnswer");
        expect(detailRecord?.questionResults.map(row => row.correctAnswer)).toEqual([2, 4]);
    });

    it("carries exact assignment generation through generated evidence and rejects revisionless or mismatched rows", () => {
        const canonical = canonicalAttempt();
        expect(canonical.questionResults).toEqual(expect.arrayContaining([
            expect.objectContaining({ assignmentId: "assignment-reused", assignmentRevision: 8 }),
        ]));

        const revisionless = {
            ...canonical,
            assignmentRevision: undefined,
            questionResults: canonical.questionResults?.map(row => ({ ...row, assignmentRevision: undefined })),
        };
        const mismatched = {
            ...canonical,
            questionResults: canonical.questionResults?.map((row, index) => (
                index === 0 ? { ...row, assignmentRevision: 7 } : row
            )),
        };

        expect(getAttemptQuestionResults(submittedExam, revisionless)).toEqual([]);
        expect(getAttemptQuestionResults(submittedExam, mismatched)).toEqual([]);
    });

    it("rejects an over-capacity retake scope before reading any array element", () => {
        let elementReads = 0;
        const oversized = new Array<number>(501);
        Object.defineProperty(oversized, 0, {
            enumerable: true,
            configurable: true,
            get() {
                elementReads += 1;
                throw new Error("must not traverse an oversized retake scope");
            },
        });
        const attempt: Attempt = {
            ...canonicalAttempt(),
            retake: {
                sourceAttemptId: "attempt-source",
                mode: "custom",
                questionIds: oversized,
                createdAt: "2026-08-09T00:00:00.000Z",
            },
        };

        expect(getAttemptQuestionResults(submittedExam, attempt)).toEqual([]);
        expect(elementReads).toBe(0);
    });

    it("round-trips assignment generation through receipt caching and remote persistence", () => {
        const cached = localResultCacheFromServerReceipt({
            attemptId: "attempt-targeted",
            examId: submittedExam.id,
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            score: 40,
            totalScore: 100,
            correctCount: 1,
            incorrectCount: 1,
            unansweredCount: 0,
            ungradedCount: 0,
            finishedAt: "2026-08-09T00:10:00.000Z",
            questionResults: [{
                questionId: 1,
                questionNumber: 1,
                selectedAnswer: 2,
                score: 40,
                earnedScore: 40,
                status: "correct",
            }],
        }, {
            examTitle: submittedExam.title,
            studentName: "김학생",
            studentId: "student-1",
            identityType: "registered",
        });
        expect(cached.questionResults[0]).toMatchObject({
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
        });

        const attempt = canonicalAttempt();
        const row = attemptToSupabaseRow(attempt);
        expect(() => attemptFromSupabaseRow(row)).toThrow(/verifier/i);
        expect(row.payload.questionResults?.every(result => result.assignmentRevision === 8)).toBe(true);
        expect(questionResultRowsForAttempt(attempt).every(result => (
            result.assignment_revision === 8
            &&
            result.payload.assignmentRevision === 8
        ))).toBe(true);
        expect(attemptFromSupabaseRow(row, attestCanonicalQuestionResultEvidence)).toMatchObject({
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            questionResults: expect.arrayContaining([
                expect.objectContaining({ assignmentId: "assignment-reused", assignmentRevision: 8 }),
            ]),
        });
        const listAttempt = attemptFromSupabaseListRow({
            ...row,
            exam_title: row.payload.examTitle,
            answers: row.payload.answers,
            question_results: row.payload.questionResults,
            question_results_source: row.payload.questionResultsSource,
            question_timings: row.payload.questionTimings,
            focus_loss_events: row.payload.focusLossEvents,
            student_questions: row.payload.studentQuestions,
            drawings_ref: row.payload.drawingsRef,
            handwriting: row.payload.handwriting,
            question_drawings: row.payload.questionDrawings,
            retake: row.payload.retake,
        }, attestCanonicalQuestionResultEvidence);
        expect(listAttempt).not.toHaveProperty("questionResultsEvidenceVerified");
        expect(JSON.stringify(listAttempt)).not.toContain("questionResultsEvidenceVerified");
    });

    it("does not let a serialized verification boolean bypass full evidence verification", () => {
        const canonical = canonicalAttempt();
        const forged = {
            ...canonical,
            questionResultsEvidenceVerified: true,
            questionResults: canonical.questionResults?.map((row, index) => index === 0
                ? { ...row, selectedAnswer: 3, earnedScore: 0, status: "wrong" as const, isCorrect: false, isWrong: true }
                : row),
        } as Attempt & { questionResultsEvidenceVerified: boolean };

        const index = buildCanonicalAttemptAnalyticsIndex(submittedExam, [forged]);
        expect(index.diagnostics.canonicalQuestionResultCount).toBe(0);
        expect(index.resultsFor(forged)).toEqual([]);
    });

    it("rejects partial and corrupt stored rows instead of mixing them with current exam grading", () => {
        const canonical = canonicalAttempt();
        const partial = { ...canonical, questionResults: canonical.questionResults?.slice(0, 1) };
        const corrupt = {
            ...canonical,
            questionResults: canonical.questionResults?.map((row, index) => index === 0
                ? { ...row, correctAnswer: 3, status: "correct" as const }
                : row),
        };
        const strippedIdentity = {
            ...canonical,
            questionResults: canonical.questionResults?.map(row => ({
                ...row,
                organizationId: undefined,
                classId: undefined,
                studentProfileId: undefined,
                studentId: undefined,
                identityType: undefined,
            })),
        };
        const missingAnswerEvidence = {
            ...canonical,
            questionResults: canonical.questionResults?.map((row, index) => (
                index === 0 ? { ...row, correctAnswer: undefined } : row
            )),
        };

        expect(getAttemptQuestionResults(submittedExam, partial)).toEqual([]);
        expect(getAttemptQuestionResults(submittedExam, corrupt)).toEqual([]);
        expect(getAttemptQuestionResults(submittedExam, strippedIdentity)).toEqual([]);
        expect(getAttemptQuestionResults(submittedExam, missingAnswerEvidence)).toEqual([]);
    });

    it("rejects a dropped zero or ungraded row even when aggregate totals remain unchanged", () => {
        const exam: Exam = {
            ...submittedExam,
            questions: [
                ...submittedExam.questions,
                { id: 3, number: 3, score: 0 },
            ],
        };
        const base = targetedAttempt({ examId: exam.id, answers: { 1: 2, 2: 1 } });
        const questionResults = buildQuestionResults(exam, base);
        const canonical: Attempt = {
            ...base,
            questionResults,
            ...buildCanonicalQuestionResultEvidence(base, questionResults),
        };
        const dropped = { ...canonical, questionResults: questionResults.filter(row => row.questionId !== 3) };

        expect(getAttemptQuestionResults(exam, canonical)).toHaveLength(3);
        expect(getAttemptQuestionResults(exam, dropped)).toEqual([]);
    });

    it("rejects forged official row evidence even when the definition manifest and totals still match", () => {
        const canonical = canonicalAttempt();
        const forged = {
            ...canonical,
            questionResults: canonical.questionResults?.map((result, index) => index === 0
                ? { ...result, selectedAnswer: 3, status: "wrong" as const, earnedScore: 0, isCorrect: false, isWrong: true }
                : { ...result, selectedAnswer: 4, status: "correct" as const, earnedScore: 60, isCorrect: true, isWrong: false }),
        };
        expect(forged.questionResultsDefinitionManifestHash).toBe(canonical.questionResultsDefinitionManifestHash);
        expect(getAttemptQuestionResults(submittedExam, forged)).toEqual([]);
    });

    it("keeps incompatible answer-key generations in separate question-stat cohorts", () => {
        const answerTwo = canonicalAttempt({ id: "attempt-answer-2", answers: { 1: 2, 2: 4 }, score: 100 });
        const revisedExam: Exam = {
            ...submittedExam,
            questions: submittedExam.questions.map(question => question.id === 1
                ? { ...question, answer: 3, label: "개정 1번" }
                : question),
        };
        const revisedBase = targetedAttempt({ id: "attempt-answer-3", answers: { 1: 3, 2: 4 }, score: 100 });
        const revisedRows = buildQuestionResults(revisedExam, revisedBase);
        const answerThree = {
            ...revisedBase,
            questionResults: revisedRows,
            ...buildCanonicalQuestionResultEvidence(revisedBase, revisedRows),
        };

        const index = buildCanonicalAttemptAnalyticsIndex(submittedExam, [answerTwo, answerThree]);
        const questionOneStats = buildExamQuestionResultStats(submittedExam, [answerTwo, answerThree], index)
            .filter(stat => stat.questionId === 1);
        expect(questionOneStats).toHaveLength(2);
        expect(questionOneStats.map(stat => stat.correctAnswer).sort()).toEqual([2, 3]);
        expect(questionOneStats.map(stat => stat.correctCount)).toEqual([1, 1]);
        expect(new Set(questionOneStats.map(stat => stat.cohortKey)).size).toBe(2);
        expect(new Set(questionOneStats.map(stat => stat.definitionManifestHash)).size).toBe(2);
        expect(buildExamQuestionPointBiserial(submittedExam, [answerTwo, answerThree], index).size).toBe(4);
    });

    it("precomputes a supported intermediate canonical analytics matrix with full official aggregates", () => {
        const questionCount = 100;
        const attemptCount = 100;
        const largeExam: Exam = {
            id: "exam-large",
            title: "대규모 시험",
            createdAt: "2026-08-09T00:00:00.000Z",
            questions: Array.from({ length: questionCount }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: 1,
                score: 1,
            })),
        };
        const templateAttempt: Attempt = {
            ...targetedAttempt(),
            id: "attempt-template",
            examId: largeExam.id,
            examTitle: largeExam.title,
            assignmentId: undefined,
            assignmentRevision: undefined,
            answers: Object.fromEntries(largeExam.questions.map(question => [question.id, 1])),
            score: questionCount,
            totalScore: questionCount,
        };
        const templateRows = buildQuestionResults(largeExam, templateAttempt);
        const attempts = Array.from({ length: attemptCount }, (_, index) => {
            const id = `attempt-${index}`;
            const questionResults = templateRows.map(row => ({
                ...row,
                attemptId: id,
                studentId: `student-${index}`,
                studentProfileId: `student-${index}`,
            } satisfies QuestionResult));
            const candidate: Attempt = {
                ...templateAttempt,
                id,
                studentId: `student-${index}`,
                studentProfileId: `student-${index}`,
                questionResults,
            };
            const sealed = { ...candidate, ...buildCanonicalQuestionResultEvidence(candidate, questionResults) };
            return attemptFromSupabaseRow(
                attemptToSupabaseRow(sealed),
                attestCanonicalQuestionResultEvidence,
            );
        });

        expect(getAttemptQuestionResults(largeExam, attempts[0])).toHaveLength(questionCount);
        const heapBefore = process.memoryUsage().heapUsed;
        const startedAt = performance.now();
        const serverSnapshot = buildTeacherCanonicalAnalyticsSnapshot(largeExam, attempts);
        const summaries = attempts.map(attempt => {
            const summary: Partial<Attempt> = { ...attempt };
            delete summary.answers;
            delete summary.questionResults;
            delete summary.questionResultsQuestionCount;
            delete summary.questionResultsDefinitionManifestHash;
            delete summary.questionResultsFullEvidenceHash;
            return { ...summary, detailLevel: "summary" as const, answers: {} } as Attempt & { detailLevel: "summary" };
        });
        const actionEnvelope = structuredClone({
            summaries: {
                status: "loaded" as const,
                attempts: summaries,
                meta: { organizationId: "org-1", rawCount: attemptCount, parsedCount: attemptCount },
            },
            analytics: {
                status: "loaded" as const,
                analyticsSnapshots: { [largeExam.id]: serverSnapshot },
                meta: { organizationId: "org-1", rawCount: attemptCount, parsedCount: attemptCount },
            },
        });
        const flightSnapshot = actionEnvelope.analytics.analyticsSnapshots[largeExam.id];
        const clientSnapshot = currentTeacherCanonicalAnalyticsSnapshot(
            flightSnapshot,
            largeExam.id,
            actionEnvelope.summaries.attempts,
        );
        const elapsedMs = performance.now() - startedAt;
        const heapDelta = process.memoryUsage().heapUsed - heapBefore;
        const maxRssBytes = process.resourceUsage().maxRSS * 1024;
        const serializedEnvelope = JSON.stringify(actionEnvelope);
        const envelopeBytes = new TextEncoder().encode(serializedEnvelope).byteLength;
        const summaryActionBytes = new TextEncoder().encode(JSON.stringify(actionEnvelope.summaries)).byteLength;
        const analyticsActionBytes = new TextEncoder().encode(JSON.stringify(actionEnvelope.analytics)).byteLength;
        const forbiddenRichKeys: string[] = [];
        const visit = (value: unknown, path: string): void => {
            if (!value || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                if (["answers", "questionResults", "questionResultsDefinitionManifestHash", "questionResultsFullEvidenceHash"].includes(key)) {
                    if (!(key === "answers" && path.includes("summaries.attempts") && Object.keys(child as object).length === 0)) {
                        forbiddenRichKeys.push(`${path}.${key}`);
                    }
                }
                visit(child, `${path}.${key}`);
            }
        };
        visit(actionEnvelope, "action");
        console.info("canonical Flight max envelope", {
            elapsedMs,
            heapDelta,
            maxRssBytes,
            envelopeBytes,
            summaryActionBytes,
            analyticsActionBytes,
        });
        expect(actionEnvelope.summaries.attempts.every(summary => (
            summary.detailLevel === "summary"
            && Object.hasOwn(summary, "answers")
            && Object.keys(summary.answers).length === 0
            && !Object.hasOwn(summary, "questionResults")
        ))).toBe(true);
        expect(clientSnapshot?.status).toBe("ready");
        expect(clientSnapshot?.questionStats).toHaveLength(questionCount);
        expect(clientSnapshot?.pointBiserial).toHaveLength(questionCount);
        expect(clientSnapshot?.similarQuestionGroups.length).toBeLessThanOrEqual(questionCount);
        expect(clientSnapshot?.recommendations.length).toBeLessThanOrEqual(100);
        expect(clientSnapshot?.csvQuestionCohorts).toEqual(clientSnapshot?.questionStats);
        expect(clientSnapshot?.advancedAggregatesComplete).toBe(true);
        expect(clientSnapshot?.studentAggregatesComplete).toBe(true);
        expect(clientSnapshot?.studentRows).toHaveLength(attemptCount);
        expect(JSON.stringify(clientSnapshot)).not.toContain("selectedAnswer");
        expect(clientSnapshot?.diagnostics).toEqual({
            attemptCount,
            serverResolutionCount: attemptCount,
            canonicalQuestionResultCount: attemptCount * questionCount,
            clientResolutionCount: 0,
        });
        expect(forbiddenRichKeys).toEqual([]);
        expect(summaryActionBytes).toBeLessThan(2 * 1024 * 1024);
        expect(analyticsActionBytes).toBeLessThan(2 * 1024 * 1024);
        expect(envelopeBytes).toBeLessThan(4 * 1024 * 1024);
        expect(heapDelta).toBeLessThan(512 * 1024 * 1024);
        expect(maxRssBytes).toBeLessThan(512 * 1024 * 1024);
        expect(elapsedMs).toBeLessThan(1_500);
    }, 120_000);
});
