import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import {
    buildClassTypeWeaknessGroups,
    buildClassExamScoreGroups,
    buildClassExamWeaknessMatrix,
    buildExamQuestionPointBiserial,
    buildExamQuestionResultStats,
    buildLearningRecommendations,
    buildMostMissedQuestionStats,
    buildQuestionResults,
    buildQuestionResultTagStats,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    buildStudentTypeWeaknessGroups,
    buildSimilarQuestionGroups,
    collectQuestionResults,
    getAttemptQuestionResults,
    hasGradableAttemptScore,
    resolveAttemptGrading,
    summarizeCanonicalQuestionSubset,
    summarizeQuestionResults,
    studentScopeKeyForAttempt,
    summarizeAttemptScore,
    summarizeAttemptBehavior,
} from "./premiumAnalytics";

const exam: Exam = {
    id: "exam-1",
    title: "국어 문학/문법",
    createdAt: "2026-06-14T10:00:00.000Z",
    questions: [
        {
            id: 1,
            number: 1,
            answer: 2,
            label: "문법",
            tags: { unit: "문법", concept: "높임 표현", source: "높임 표현", expectedTimeSec: 60 },
        },
        {
            id: 2,
            number: 2,
            answer: 4,
            label: "문학",
            tags: { unit: "현대시", concept: "화자의 정서", source: "님의 침묵", expectedTimeSec: 90, mistakeTypes: ["개념 혼동"] },
        },
        {
            id: 3,
            number: 3,
            answer: 1,
            label: "문학",
            tags: { unit: "현대시", concept: "화자의 정서", source: "님의 침묵", expectedTimeSec: 80, mistakeTypes: ["개념 혼동"] },
        },
        {
            id: 4,
            number: 4,
            answer: 3,
            label: "독서",
            tags: { unit: "사회", concept: "인과 추론", source: "경제 지문", expectedTimeSec: 75 },
        },
    ],
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "국어 문학/문법",
    studentName: "김학생",
    studentId: "student-1",
    groupId: "class-a",
    groupName: "A반",
    regionId: "서울",
    regionName: "서울",
    startedAt: "2026-06-14T10:00:00.000Z",
    finishedAt: "2026-06-14T10:05:00.000Z",
    score: 50,
    totalScore: 100,
    answers: {
        1: 2,
        2: 1,
        4: 0,
    },
    status: "completed",
    tabFociLostCount: 2,
    focusLossEvents: [
        { at: "2026-06-14T10:02:00.000Z", questionId: 2, questionNumber: 2, count: 1, reason: "hidden" },
        { at: "2026-06-14T10:03:00.000Z", questionId: 4, questionNumber: 4, count: 2, reason: "blur" },
    ],
    questionTimings: [
        { questionId: 1, questionNumber: 1, totalTimeSec: 45, visitCount: 1, revisitCount: 0, answerChangeCount: 1 },
        { questionId: 2, questionNumber: 2, totalTimeSec: 132, visitCount: 3, revisitCount: 2, answerChangeCount: 2 },
        { questionId: 4, questionNumber: 4, totalTimeSec: 18, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
    ],
    questionDrawings: [
        { questionId: 2, questionNumber: 2, page: 1, strokeCount: 3 },
    ],
};

function canonicalAttemptFor(testExam: Exam, candidate: Attempt): Attempt {
    const questionResults = buildQuestionResults(testExam, candidate);
    const scoreSummary = summarizeQuestionResults(questionResults);
    const preservesRoundedAggregate = Math.abs(candidate.score - scoreSummary.earnedScore) <= 0.05
        && Math.abs(candidate.totalScore - scoreSummary.totalScore) <= 0.05;
    const canonical = {
        ...candidate,
        score: preservesRoundedAggregate ? candidate.score : scoreSummary.earnedScore,
        totalScore: preservesRoundedAggregate ? candidate.totalScore : scoreSummary.totalScore,
        questionResults,
    };
    return { ...canonical, ...buildCanonicalQuestionResultEvidence(canonical, questionResults) };
}

describe("premium analytics", () => {
    it("excludes denominator-free submissions from class score evidence", () => {
        const ungradedExam: Exam = {
            id: "exam-ungraded-class",
            title: "미채점 반 분석",
            createdAt: "2026-08-08T09:00:00.000Z",
            questions: [{ id: 1, number: 1, score: 10, choices: 4 }],
        };
        const attempts: Attempt[] = Array.from({ length: 5 }, (_, index) => ({
            id: `ungraded-class-${index + 1}`,
            examId: ungradedExam.id,
            examTitle: ungradedExam.title,
            studentName: `학생 ${index + 1}`,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
            startedAt: "2026-08-08T09:00:00.000Z",
            finishedAt: "2026-08-08T09:10:00.000Z",
            score: index === 0 ? 10 : 0,
            totalScore: index === 0 ? 10 : 0,
            answers: {},
            status: "completed" as const,
        }));

        expect(hasGradableAttemptScore(summarizeAttemptScore(ungradedExam, attempts[0]))).toBe(true);
        expect(hasGradableAttemptScore(summarizeAttemptScore(ungradedExam, attempts[1]))).toBe(false);
        expect(buildClassExamScoreGroups(ungradedExam, attempts)).toEqual([{
            groupKey: "class-a",
            groupName: "A반",
            regionName: undefined,
            scores: [100],
        }]);
        expect(buildClassExamWeaknessMatrix(ungradedExam, attempts)[0]).toMatchObject({
            attemptCount: 5,
            performanceCount: 1,
            averageScorePercent: 100,
        });
    });

    it("keeps a fully ungraded class average explicitly unavailable", () => {
        const ungradedExam: Exam = {
            id: "exam-no-class-score",
            title: "근거 없는 반 분석",
            createdAt: "2026-08-08T09:00:00.000Z",
            questions: [{ id: 1, number: 1, score: 10, choices: 4 }],
        };
        const ungradedAttempt: Attempt = {
            id: "ungraded-only",
            examId: ungradedExam.id,
            examTitle: ungradedExam.title,
            studentName: "미채점 학생",
            groupId: "class-a",
            groupName: "A반",
            startedAt: "2026-08-08T09:00:00.000Z",
            finishedAt: "2026-08-08T09:10:00.000Z",
            score: 0,
            totalScore: 0,
            answers: {},
            status: "completed",
        };

        expect(buildClassExamScoreGroups(ungradedExam, [ungradedAttempt])[0].scores).toEqual([]);
        expect(buildClassExamWeaknessMatrix(ungradedExam, [ungradedAttempt])[0]).toMatchObject({
            performanceCount: 0,
            averageScorePercent: null,
        });
    });

    it("builds durable per-question result rows without cropped question images", () => {
        const rows = buildQuestionResults(exam, attempt);

        expect(rows).toHaveLength(4);
        expect(rows.map(row => ({ questionId: row.questionId, status: row.status }))).toEqual([
            { questionId: 1, status: "correct" },
            { questionId: 2, status: "wrong" },
            { questionId: 3, status: "unanswered" },
            { questionId: 4, status: "unanswered" },
        ]);
        expect(rows.find(row => row.questionId === 2)).toMatchObject({
            attemptId: "attempt-1",
            examId: "exam-1",
            studentId: "student-1",
            groupId: "class-a",
            regionId: "서울",
            regionName: "서울",
            selectedAnswer: 1,
            correctAnswer: 4,
            concept: "화자의 정서",
            source: "님의 침묵",
            timeSec: 132,
            handwritingStrokeCount: 3,
        });
        expect(rows.find(row => row.questionId === 3)?.selectedAnswer).toBeUndefined();
    });

    it("builds a retake set from wrong and unanswered questions only", () => {
        expect(buildRetakeQuestionIds(exam, canonicalAttemptFor(exam, attempt))).toEqual([2, 3, 4]);
    });

    it("fails closed instead of mixing partial stored grading with the current exam", () => {
        const storedQuestionTwo = buildQuestionResults(exam, attempt).find(row => row.questionId === 2);
        const partialAttempt: Attempt = {
            ...attempt,
            questionResults: storedQuestionTwo
                ? [{
                    ...storedQuestionTwo,
                    handwritingStrokeCount: 8,
                    timeSec: 140,
                }]
                : [],
        };

        expect(resolveAttemptGrading(exam, partialAttempt)).toMatchObject({
            source: "stored_totals_only",
            questionResults: [],
        });
        expect(getAttemptQuestionResults(exam, partialAttempt)).toEqual([]);
        expect(buildRetakeQuestionIds(exam, partialAttempt)).toEqual([]);
        expect(buildExamQuestionResultStats(exam, [partialAttempt]).every(stat => stat.totalCount === 0)).toBe(true);
        expect(summarizeAttemptScore(exam, partialAttempt)).toMatchObject({
            earnedScore: 50,
            totalScore: 100,
            scorePercent: 50,
        });
    });

    it("keeps complete stored grading canonical after the exam answer and metadata are edited", () => {
        const canonicalAttempt = canonicalAttemptFor(exam, attempt);
        const editedExam: Exam = {
            ...exam,
            questions: exam.questions.map(question => question.id === 1
                ? {
                    ...question,
                    answer: 3,
                    label: "수정된 표시 라벨",
                    tags: { ...question.tags, concept: "수정된 표시 개념" },
                }
                : question),
        };

        const resolution = resolveAttemptGrading(editedExam, canonicalAttempt);
        const row = resolution.questionResults.find(result => result.questionId === 1);

        expect(resolution.source).toBe("canonical_submission");
        expect(row).toMatchObject({
            selectedAnswer: 2,
            correctAnswer: 2,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            score: 25,
            earnedScore: 25,
            label: "문법",
            concept: "높임 표현",
        });
        expect(summarizeAttemptScore(editedExam, canonicalAttempt)).toMatchObject({
            earnedScore: 25,
            totalScore: 100,
            scorePercent: 25,
        });
        expect(buildRetakeQuestionIds(editedExam, canonicalAttempt)).toEqual([2, 3, 4]);
        expect(buildExamQuestionResultStats(editedExam, [canonicalAttempt]).find(stat => stat.questionId === 1)).toMatchObject({
            wrongCount: 0,
            correctCount: 1,
            optionCounts: { 2: 1 },
            topWrongOption: undefined,
        });
        expect(buildExamQuestionResultStats(editedExam, [canonicalAttempt]).find(stat => stat.questionId === 2)).toMatchObject({
            wrongCount: 1,
            correctCount: 0,
            topWrongOption: { option: 1, count: 1, rate: 100 },
        });
    });

    it("fails closed for conflicting totals but preserves a submitted question removed from the current exam", () => {
        const canonical = canonicalAttemptFor(exam, attempt);
        const conflictingTotals: Attempt = { ...canonical, score: 100 };
        const removedQuestionExam: Exam = {
            ...exam,
            questions: exam.questions.filter(question => question.id !== 4),
        };

        expect(resolveAttemptGrading(exam, conflictingTotals)).toMatchObject({
            source: "stored_totals_only",
            questionResults: [],
        });
        expect(resolveAttemptGrading(removedQuestionExam, canonical)).toMatchObject({
            source: "canonical_submission",
            questionResults: expect.arrayContaining([
                expect.objectContaining({ questionId: 4, correctAnswer: 3 }),
            ]),
        });
    });

    it("bounds current-exam derivation to attempts that predate stored question results", () => {
        expect(resolveAttemptGrading(exam, attempt).source).toBe("legacy_derived_current_exam");
        const editedExam = {
            ...exam,
            questions: exam.questions.map(question => question.id === 1 ? { ...question, answer: 3 } : question),
        };
        expect(collectQuestionResults(editedExam, [attempt])).toEqual([]);
        expect(buildExamQuestionResultStats(editedExam, [attempt]).every(stat => stat.totalCount === 0)).toBe(true);
        expect(resolveAttemptGrading(exam, { ...attempt, score: 0, totalScore: 0, questionResults: [] })).toMatchObject({
            source: "incomplete_or_invalid",
            questionResults: [],
        });
        expect(resolveAttemptGrading({ ...exam, questions: [] }, {
            ...attempt,
            score: 0,
            totalScore: 0,
            questionResults: [],
        })).toMatchObject({
            source: "incomplete_or_invalid",
            questionResults: [],
        });
    });

    it("keeps explicit legacy repair provenance after derived rows are stored", () => {
        const repairedAttempt: Attempt = {
            ...attempt,
            score: 25,
            totalScore: 100,
            questionResults: buildQuestionResults(exam, attempt),
            questionResultsSource: "legacy_derived_current_exam",
        };

        expect(resolveAttemptGrading(exam, repairedAttempt)).toMatchObject({
            source: "legacy_derived_current_exam",
            questionResults: expect.arrayContaining([
                expect.objectContaining({ questionId: 1, status: "correct" }),
            ]),
        });
    });

    it("fails closed for malformed canonical rows and snapshots result evidence once", () => {
        const canonicalAttempt = canonicalAttemptFor(exam, attempt);
        const canonicalRows = canonicalAttempt.questionResults!;
        const malformedAttempts: Attempt[] = [
            {
                ...canonicalAttempt,
                examId: "other-exam",
            },
            {
                ...canonicalAttempt,
                questionResultsSource: "canonical_submission" as never,
            },
            {
                ...canonicalAttempt,
                retake: "malformed-retake" as never,
            },
            {
                ...canonicalAttempt,
                questionResults: [canonicalRows[0], canonicalRows[0], canonicalRows[1], canonicalRows[2]],
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 0 ? { ...row, examId: "other-exam" } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 1 ? {
                    ...row,
                    correctAnswer: undefined,
                    status: "invalid" as never,
                    isCorrect: false,
                    isWrong: false,
                    isUnanswered: false,
                } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: [null as never, canonicalRows[1], canonicalRows[2], canonicalRows[3]],
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 1 ? {
                    ...row,
                    correctAnswer: "4" as never,
                } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 2 ? {
                    ...row,
                    correctAnswer: 1,
                    status: "ungraded",
                    isUnanswered: false,
                } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 1 ? {
                    ...row,
                    score: 0,
                } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 0 ? {
                    ...row,
                    studentId: "other-student",
                } : row),
            },
            {
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 1 ? {
                    ...row,
                    timeSec: Number.NaN,
                } : row),
            },
            ...[-1, Number.NaN, 1.5].map(selectedAnswer => ({
                ...canonicalAttempt,
                questionResults: canonicalRows.map((row, index) => index === 1 ? {
                    ...row,
                    correctAnswer: undefined,
                    selectedAnswer,
                } : row),
            })),
        ];

        malformedAttempts.forEach(candidate => {
            expect(resolveAttemptGrading(exam, candidate)).toMatchObject({
                source: "stored_totals_only",
                questionResults: [],
            });
        });

        const negativeZeroExam: Exam = {
            id: "negative-zero",
            title: "음수 영점",
            createdAt: exam.createdAt,
            questions: [{ id: 1, number: 1 }],
        };
        const negativeZeroAttempt: Attempt = {
            ...attempt,
            id: "negative-zero-attempt",
            examId: negativeZeroExam.id,
            examTitle: negativeZeroExam.title,
            score: 0,
            totalScore: 0,
            answers: {},
            questionResults: [{
                ...canonicalRows[0],
                attemptId: "negative-zero-attempt",
                examId: negativeZeroExam.id,
                examTitle: negativeZeroExam.title,
                questionId: 1,
                questionNumber: 1,
                score: -0,
                earnedScore: -0,
                selectedAnswer: undefined,
                correctAnswer: undefined,
                status: "ungraded",
                isCorrect: false,
                isWrong: false,
                isUnanswered: false,
            }],
        };
        expect(resolveAttemptGrading(negativeZeroExam, negativeZeroAttempt).source).toBe("incomplete_or_invalid");

        let reads = 0;
        const changingAttempt = { ...canonicalAttempt };
        Object.defineProperty(changingAttempt, "questionResults", {
            configurable: true,
            get() {
                reads += 1;
                return reads === 1 ? canonicalRows : [];
            },
        });
        expect(resolveAttemptGrading(exam, changingAttempt).source).toBe("canonical_submission");
        expect(reads).toBe(1);
    });

    it("materializes grading inputs once before validating or enriching canonical rows", () => {
        const accessorAttempt = canonicalAttemptFor(exam, attempt);
        const canonicalRows = accessorAttempt.questionResults!;
        const reads = new Map<string, number>();
        const once = <T,>(key: string, value: T) => () => {
            const nextRead = (reads.get(key) || 0) + 1;
            reads.set(key, nextRead);
            if (nextRead > 1) throw new Error(`${key} grading input was re-read`);
            return value;
        };
        Object.defineProperties(accessorAttempt, {
            questionResults: { configurable: true, get: once("questionResults", canonicalRows) },
            answers: { configurable: true, get: once("answers", { ...attempt.answers }) },
            retake: { configurable: true, get: once("retake", undefined) },
            studentId: { configurable: true, get: once("studentId", attempt.studentId) },
            finishedAt: { configurable: true, get: once("finishedAt", attempt.finishedAt) },
            questionTimings: { configurable: true, get: once("questionTimings", attempt.questionTimings) },
            questionDrawings: { configurable: true, get: once("questionDrawings", attempt.questionDrawings) },
        });

        let resolution: ReturnType<typeof resolveAttemptGrading> | undefined;
        expect(() => {
            resolution = resolveAttemptGrading(exam, accessorAttempt);
        }).not.toThrow();
        expect(Object.fromEntries(reads)).toEqual({
            questionResults: 1,
            answers: 1,
            retake: 1,
            studentId: 1,
            finishedAt: 1,
            questionTimings: 1,
            questionDrawings: 1,
        });
        expect(resolution?.source).toBe("canonical_submission");
    });

    it("does not consult the edited current question set for canonical validation", () => {
        const canonicalAttempt = canonicalAttemptFor(exam, attempt);
        let questionReads = 0;
        const changingExam = { ...exam };
        Object.defineProperty(changingExam, "questions", {
            configurable: true,
            get() {
                questionReads += 1;
                if (questionReads > 1) throw new Error("exam questions were re-read");
                return exam.questions;
            },
        });

        let resolution: ReturnType<typeof resolveAttemptGrading> | undefined;
        expect(() => {
            resolution = resolveAttemptGrading(changingExam, canonicalAttempt);
        }).not.toThrow();
        expect(resolution?.source).toBe("canonical_submission");
        expect(resolution?.questionResults).toHaveLength(exam.questions.length);
        expect(questionReads).toBe(0);
    });

    it("snapshots stored totals with question evidence and exposes one consistent score summary", () => {
        const sealedAttempt = canonicalAttemptFor(exam, attempt);
        let scoreReads = 0;
        let totalReads = 0;
        const changingAttempt: Attempt = {
            ...sealedAttempt,
        };
        Object.defineProperties(changingAttempt, {
            score: {
                configurable: true,
                get() {
                    scoreReads += 1;
                    return scoreReads === 1 ? 25 : 100;
                },
            },
            totalScore: {
                configurable: true,
                get() {
                    totalReads += 1;
                    return totalReads === 1 ? 100 : 0;
                },
            },
        });

        const resolution = resolveAttemptGrading(exam, changingAttempt);
        expect(resolution).toMatchObject({
            source: "canonical_submission",
            scoreSummary: {
                earnedScore: 25,
                totalScore: 100,
                scorePercent: 25,
            },
        });
        expect(scoreReads).toBe(1);
        expect(totalReads).toBe(1);

        const throwingAttempt = { ...changingAttempt };
        Object.defineProperty(throwingAttempt, "score", {
            configurable: true,
            get() {
                throw new Error("corrupt stored score accessor");
            },
        });
        expect(() => resolveAttemptGrading(exam, throwingAttempt)).not.toThrow();
        expect(resolveAttemptGrading(exam, throwingAttempt)).toMatchObject({
            source: "incomplete_or_invalid",
            scoreSummary: { earnedScore: 0, totalScore: 0, scorePercent: 0 },
        });
    });

    it("fails closed for malformed retake scopes instead of widening them", () => {
        const malformedScopes = [[], [2, 99], [99], [2, 2]];
        malformedScopes.forEach((questionIds, index) => {
            const candidate: Attempt = {
                ...attempt,
                id: `malformed-retake-${index}`,
                retake: {
                    sourceAttemptId: attempt.id,
                    questionIds,
                    mode: "wrong",
                    createdAt: "2026-08-09T00:00:00.000Z",
                },
            };
            expect(resolveAttemptGrading(exam, candidate)).toMatchObject({
                source: "stored_totals_only",
                questionResults: [],
            });
        });
    });

    it("summarizes a validated canonical source over an exact retake subset", () => {
        const canonicalAttempt = canonicalAttemptFor(exam, attempt);

        expect(summarizeCanonicalQuestionSubset(exam, canonicalAttempt, [2, 4])).toMatchObject({
            earnedScore: 0,
            totalScore: 50,
            scorePercent: 0,
            gradedQuestionCount: 2,
        });
        expect(summarizeCanonicalQuestionSubset(exam, canonicalAttempt, [2, 99])).toBeNull();
    });

    it("normalizes invalid fallback totals instead of emitting NaN or negative scores", () => {
        const invalidTotals: Attempt = {
            ...attempt,
            score: Number.NaN,
            totalScore: Number.NaN,
            questionResults: [],
        };

        expect(summarizeAttemptScore(exam, invalidTotals)).toMatchObject({
            earnedScore: 0,
            totalScore: 0,
            scorePercent: 0,
        });
    });

    it.each([3, 6, 7])("accepts %i-question canonical rows within aggregate rounding bounds", questionCount => {
        const equalWeightExam: Exam = {
            id: `equal-${questionCount}`,
            title: `${questionCount}문항 균등 배점`,
            createdAt: "2026-08-09T00:00:00.000Z",
            questions: Array.from({ length: questionCount }, (_, index) => ({
                id: index + 1,
                number: index + 1,
                answer: 1,
            })),
        };
        const equalWeightAttempt: Attempt = {
            id: `attempt-equal-${questionCount}`,
            examId: equalWeightExam.id,
            examTitle: equalWeightExam.title,
            studentName: "균등 학생",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T00:10:00.000Z",
            score: 100,
            totalScore: 100,
            answers: Object.fromEntries(equalWeightExam.questions.map(question => [question.id, 1])),
            status: "completed",
        };
        const canonicalEqualWeightAttempt = canonicalAttemptFor(equalWeightExam, equalWeightAttempt);

        expect(resolveAttemptGrading(equalWeightExam, canonicalEqualWeightAttempt)).toMatchObject({
            source: "canonical_submission",
        });
        expect(summarizeAttemptScore(equalWeightExam, canonicalEqualWeightAttempt)).toMatchObject({
            earnedScore: 100,
            totalScore: 100,
            scorePercent: 100,
            gradedQuestionCount: questionCount,
        });
    });

    it("summarizes attempt scores from current question results instead of stale attempt totals", () => {
        const staleScoreAttempt: Attempt = {
            ...attempt,
            score: 100,
            totalScore: 100,
        };

        expect(summarizeAttemptScore(exam, staleScoreAttempt)).toMatchObject({
            earnedScore: 25,
            totalScore: 100,
            scorePercent: 25,
            gradedQuestionCount: 4,
            ungradedQuestionCount: 0,
        });
    });

    it("scores and analyzes retake attempts against only the assigned question set", () => {
        const retakeAttempt: Attempt = {
            ...attempt,
            id: "retake-1",
            answers: { 2: 4, 4: 0 },
            score: 0,
            totalScore: 0,
            retake: {
                sourceAttemptId: "attempt-1",
                questionIds: [2, 4],
                mode: "wrong",
                createdAt: "2026-06-15T10:00:00.000Z",
            },
            questionTimings: [],
            questionDrawings: [],
        };

        const canonicalRetakeAttempt = canonicalAttemptFor(exam, retakeAttempt);
        const rows = getAttemptQuestionResults(exam, canonicalRetakeAttempt);

        expect(rows.map(row => ({ questionId: row.questionId, status: row.status }))).toEqual([
            { questionId: 2, status: "correct" },
            { questionId: 4, status: "unanswered" },
        ]);
        expect(summarizeAttemptScore(exam, canonicalRetakeAttempt)).toMatchObject({
            earnedScore: 50,
            totalScore: 100,
            scorePercent: 50,
            gradedQuestionCount: 2,
        });
        expect(buildRetakeQuestionIds(exam, canonicalRetakeAttempt)).toEqual([4]);
    });

    it("groups a student's wrong questions by teacher labels and deep tags", () => {
        expect(buildStudentWeaknessGroups(exam, canonicalAttemptFor(exam, attempt))).toEqual([
            {
                key: "source:님의 침묵",
                title: "님의 침묵",
                basis: "같은 지문/작품",
                questionIds: [2, 3],
                questionNumbers: [2, 3],
                wrongCount: 2,
                totalCount: 2,
                wrongRate: 100,
                labels: ["문학"],
                concepts: ["화자의 정서"],
                recommendedAction: "같은 지문/작품 2문항 재시험",
            },
            {
                key: "concept:인과 추론",
                title: "인과 추론",
                basis: "같은 개념",
                questionIds: [4],
                questionNumbers: [4],
                wrongCount: 1,
                totalCount: 1,
                wrongRate: 100,
                labels: ["독서"],
                concepts: ["인과 추론"],
                recommendedAction: "같은 개념 1문항 재시험",
            },
        ]);
    });

    it("sorts similar question groups by class-wide wrong pressure", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            score: 50,
            questionTimings: [],
            questionDrawings: [],
        };

        expect(buildSimilarQuestionGroups(exam, [attempt, secondAttempt].map(candidate => canonicalAttemptFor(exam, candidate))).slice(0, 2)).toMatchObject([
            {
                title: "님의 침묵",
                basis: "같은 지문/작품",
                questionNumbers: [2, 3],
                wrongCount: 3,
                totalCount: 4,
                wrongRate: 75,
            },
            {
                title: "높임 표현",
                basis: "같은 지문/작품",
                questionNumbers: [1],
                wrongCount: 1,
                totalCount: 2,
                wrongRate: 50,
            },
        ]);
    });

    it("excludes retake attempts from official similar-question pressure", () => {
        const base = canonicalAttemptFor(exam, attempt);
        const retake = canonicalAttemptFor(exam, {
            ...attempt,
            id: "attempt-retake",
            retake: {
                sourceAttemptId: attempt.id,
                questionIds: [2, 3],
                mode: "wrong",
                createdAt: "2026-08-10T01:00:00.000Z",
            },
        });

        expect(buildSimilarQuestionGroups(exam, [base, retake])).toEqual(
            buildSimilarQuestionGroups(exam, [base]),
        );
    });

    it("cuts weakness groups by student, class, exam, and type metadata", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            score: 50,
            questionTimings: [],
            questionDrawings: [],
        };
        const aggregateAttempts = [canonicalAttemptFor(exam, attempt), canonicalAttemptFor(exam, secondAttempt)];

        expect(buildStudentTypeWeaknessGroups(exam, aggregateAttempts, "student-1", "concept")[0]).toMatchObject({
            title: "화자의 정서",
            basis: "같은 개념",
            questionIds: [2, 3],
            wrongCount: 2,
            unansweredCount: 1,
            totalCount: 2,
            studentCount: 1,
            recommendedQuestionIds: [2, 3],
        });

        expect(buildClassTypeWeaknessGroups(exam, aggregateAttempts, "class-a", "source")[0]).toMatchObject({
            title: "님의 침묵",
            basis: "같은 지문/작품",
            questionIds: [2, 3],
            wrongCount: 3,
            totalCount: 4,
            studentCount: 2,
            recommendedQuestionIds: [2, 3],
        });
    });

    it("builds class-by-exam weakness rows for dashboard comparison", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };
        const classBAttempt: Attempt = {
            ...attempt,
            id: "attempt-b",
            studentId: "student-b",
            studentName: "박학생",
            groupId: "class-b",
            groupName: "B반",
            answers: { 1: 2, 2: 4, 3: 1, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };

        const rows = buildClassExamWeaknessMatrix(exam, [attempt, secondAttempt, classBAttempt].map(candidate => canonicalAttemptFor(exam, candidate)), {
            kinds: ["concept"],
            recommendationLimit: 2,
        });

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            groupKey: "class-a",
            groupName: "A반",
            attemptCount: 2,
            studentCount: 2,
            averageScorePercent: 38,
            wrongCount: 5,
            totalCount: 8,
            wrongRate: 63,
            focusQuestionNumbers: [3, 1, 2, 4],
            retakeQuestionIds: [2, 3, 4],
        });
        expect(rows[0].recommendations[0]).toMatchObject({
            scope: "class",
            sourceAttemptId: "class:class-a",
            title: "화자의 정서",
            retakeQuestionIds: [2, 3],
        });
        expect(rows[1]).toMatchObject({
            groupKey: "class-b",
            groupName: "B반",
            averageScorePercent: 100,
            rosterStudentCount: 0,
            missingStudentCount: 0,
            participationRate: null, // no roster linked → turnout unknown (was a misleading 100%)
            wrongRate: 0,
            recommendations: [],
            retakeQuestionIds: [],
        });
    });

    it("uses roster data to recover class rows and missing students for restricted exams", () => {
        const rosterGroups: RosterGroup[] = [
            { id: "class-a", name: "A반", region: "서울", count: 2, avgScore: 0, color: "#4f46e5" },
            { id: "class-b", name: "B반", region: "서울", count: 1, avgScore: 0, color: "#10b981" },
        ];
        const rosterStudents: RosterStudent[] = [
            { id: "class-a::김학생", name: "김학생", email: "", group: "A반", region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
            { id: "class-a::이학생", name: "이학생", email: "", group: "A반", region: "서울", avatar: "#10b981", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
            { id: "class-b::박학생", name: "박학생", email: "", group: "B반", region: "서울", avatar: "#f59e0b", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
        ];
        const restrictedExam: Exam = {
            ...exam,
            accessConfig: { type: "group", groupIds: ["class-a", "class-b"] },
        };
        const rosterMatchedAttempt: Attempt = {
            ...attempt,
            id: "attempt-roster",
            studentId: "class-a::김학생",
            groupId: undefined,
            groupName: undefined,
        };

        const rows = buildClassExamWeaknessMatrix(restrictedExam, [canonicalAttemptFor(restrictedExam, rosterMatchedAttempt)], {
            kinds: ["concept"],
            rosterGroups,
            rosterStudents,
        });

        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.groupKey === "class-a")).toMatchObject({
            groupName: "A반",
            regionName: "서울",
            attemptCount: 1,
            studentCount: 1,
            rosterStudentCount: 2,
            submittedRosterStudentCount: 1,
            missingStudentCount: 1,
            missingStudentNames: ["이학생"],
            participationRate: 50,
            retakeQuestionIds: [2, 3, 4],
        });
        expect(rows.find(row => row.groupKey === "class-b")).toMatchObject({
            groupName: "B반",
            attemptCount: 0,
            studentCount: 0,
            rosterStudentCount: 1,
            submittedRosterStudentCount: 0,
            missingStudentCount: 1,
            missingStudentNames: ["박학생"],
            participationRate: 0,
            recommendations: [],
        });
    });

    it("keeps class matrix rows separated for same-name groups in different regions", () => {
        const regionalGroups: RosterGroup[] = [
            { id: "seoul-a", name: "A반", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" },
            { id: "busan-a", name: "A반", region: "부산", count: 1, avgScore: 0, color: "#10b981" },
        ];
        const regionalStudents: RosterStudent[] = [
            { id: "seoul-a::김학생", name: "김학생", email: "", group: "A반", region: "서울", avatar: "#4f46e5", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
            { id: "busan-a::김학생", name: "김학생", email: "", group: "A반", region: "부산", avatar: "#10b981", avgScore: 0, examsTaken: 0, lastActive: "기록 없음", trend: "flat", status: "active" },
        ];
        const restrictedExam: Exam = {
            ...exam,
            accessConfig: { type: "group", groupIds: ["seoul-a", "busan-a"] },
        };
        const rows = buildClassExamWeaknessMatrix(restrictedExam, [
            { ...attempt, id: "seoul", studentId: "seoul-a::김학생", groupId: "seoul-a", groupName: "A반", regionName: "서울", answers: { 1: 2, 2: 1, 3: 0, 4: 3 } },
            { ...attempt, id: "busan", studentId: "busan-a::김학생", groupId: "busan-a", groupName: "A반", regionName: "부산", answers: { 1: 2, 2: 4, 3: 1, 4: 3 } },
        ].map(candidate => canonicalAttemptFor(restrictedExam, candidate)), {
            kinds: ["concept"],
            rosterGroups: regionalGroups,
            rosterStudents: regionalStudents,
        });

        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.groupKey === "seoul-a")).toMatchObject({
            groupName: "A반",
            regionName: "서울",
            attemptCount: 1,
            studentCount: 1,
            wrongRate: 50,
        });
        expect(rows.find(row => row.groupKey === "busan-a")).toMatchObject({
            groupName: "A반",
            regionName: "부산",
            attemptCount: 1,
            studentCount: 1,
            wrongRate: 0,
        });
    });

    it("keeps same-name legacy students separated by class-scoped fallback keys", () => {
        const legacyClassA: Attempt = {
            ...attempt,
            id: "legacy-a",
            studentId: undefined,
            groupId: "class-a",
            groupName: "A반",
            answers: { 1: 2, 2: 1, 3: 0, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };
        const legacyClassB: Attempt = {
            ...attempt,
            id: "legacy-b",
            studentId: undefined,
            groupId: "class-b",
            groupName: "B반",
            answers: { 1: 3, 2: 4, 3: 1, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };

        expect(studentScopeKeyForAttempt(legacyClassA)).toBe("class-a::김학생");
        expect(studentScopeKeyForAttempt(legacyClassB)).toBe("class-b::김학생");

        const canonicalClassAttempts = [legacyClassA, legacyClassB].map(candidate => canonicalAttemptFor(exam, candidate));
        const classARows = collectQuestionResults(exam, canonicalClassAttempts, {
            studentKey: "class-a::김학생",
        });
        expect(Array.from(new Set(classARows.map(row => row.attemptId)))).toEqual(["legacy-a"]);
        expect(collectQuestionResults(exam, canonicalClassAttempts, {
            studentKey: "김학생",
        })).toHaveLength(0);

        expect(buildLearningRecommendations(exam, canonicalClassAttempts, {
            scope: "student",
            studentKey: "class-a::김학생",
            kinds: ["concept"],
        })[0]).toMatchObject({
            title: "화자의 정서",
            wrongCount: 2,
            studentCount: 1,
            attemptCount: 1,
        });
        expect(buildLearningRecommendations(exam, canonicalClassAttempts, {
            scope: "student",
            studentKey: "class-b::김학생",
            kinds: ["concept"],
        })[0]).toMatchObject({
            title: "높임 표현",
            wrongCount: 1,
            studentCount: 1,
            attemptCount: 1,
        });
    });

    it("keeps same-name legacy students separated by region when group ids are missing", () => {
        const legacySeoul: Attempt = {
            ...attempt,
            id: "legacy-seoul",
            studentId: undefined,
            groupId: undefined,
            groupName: "A반",
            regionId: undefined,
            regionName: "서울",
            answers: { 1: 2, 2: 1, 3: 0, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };
        const legacyBusan: Attempt = {
            ...attempt,
            id: "legacy-busan",
            studentId: undefined,
            groupId: undefined,
            groupName: "A반",
            regionId: undefined,
            regionName: "부산",
            answers: { 1: 3, 2: 4, 3: 1, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };

        expect(studentScopeKeyForAttempt(legacySeoul)).toBe("서울::A반::김학생");
        expect(studentScopeKeyForAttempt(legacyBusan)).toBe("부산::A반::김학생");

        const canonicalRegionalAttempts = [legacySeoul, legacyBusan].map(candidate => canonicalAttemptFor(exam, candidate));
        const seoulRows = collectQuestionResults(exam, canonicalRegionalAttempts, {
            studentKey: "서울::A반::김학생",
        });
        expect(Array.from(new Set(seoulRows.map(row => row.attemptId)))).toEqual(["legacy-seoul"]);

        expect(buildLearningRecommendations(exam, canonicalRegionalAttempts, {
            scope: "student",
            studentKey: "부산::A반::김학생",
            kinds: ["concept"],
        })[0]).toMatchObject({
            title: "높임 표현",
            wrongCount: 1,
            studentCount: 1,
            attemptCount: 1,
        });
    });

    it("rejects stored row identity that is missing from the outer immutable submission scope", () => {
        const storedRows = buildQuestionResults(exam, attempt).map(row => ({
            ...row,
            attemptId: "stored-group",
            studentId: undefined,
            groupId: "class-a",
            groupName: "A반",
        }));
        const storedIdentityAttempt: Attempt = {
            ...attempt,
            id: "stored-group",
            score: 25,
            studentId: undefined,
            groupId: undefined,
            groupName: undefined,
            questionResults: storedRows,
        };
        Object.assign(storedIdentityAttempt, buildCanonicalQuestionResultEvidence(storedIdentityAttempt, storedRows));

        const rows = collectQuestionResults(exam, [storedIdentityAttempt], { groupKey: "class-a" });

        expect(rows).toEqual([]);
        expect(buildLearningRecommendations(exam, [storedIdentityAttempt], {
            scope: "class",
            groupKey: "class-a",
            kinds: ["concept"],
        })).toEqual([]);
    });

    it("aggregates exam-level question result stats from result rows", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            score: 50,
            questionTimings: [],
            questionDrawings: [],
        };

        const aggregateAttempts = [canonicalAttemptFor(exam, attempt), canonicalAttemptFor(exam, secondAttempt)];
        const stats = buildExamQuestionResultStats(exam, aggregateAttempts);

        expect(stats.find(stat => stat.questionId === 2)).toMatchObject({
            questionNumber: 2,
            totalCount: 2,
            correctCount: 1,
            wrongCount: 1,
            unansweredCount: 0,
            correctRate: 50,
            wrongRate: 50,
            topWrongOption: { option: 1, count: 1, rate: 50 },
            averageTimeSec: 132,
            expectedTimeSec: 90,
            timeOverExpectedRate: 147,
            averageVisitCount: 3,
            // 1 of 2 graded responses was revisited (the second student had no timing).
            revisitRate: 50,
            answerChangeCount: 2,
            handwritingStrokeCount: 3,
            studentCount: 2,
            groupCount: 1,
        });
        expect(stats.find(stat => stat.questionId === 4)).toMatchObject({
            totalCount: 2,
            correctCount: 1,
            wrongCount: 1,
            unansweredCount: 1,
            unansweredRate: 50,
        });
        expect(buildMostMissedQuestionStats(exam, aggregateAttempts, 2).map(stat => stat.questionNumber)).toEqual([3, 2]);
    });

    it("keeps revisit rate within 100% by dividing revisits over graded responses (B3)", () => {
        const oneQuestionExam: Exam = {
            id: "exam-r",
            title: "재방문",
            createdAt: "2026-06-14T10:00:00.000Z",
            questions: [{ id: 1, number: 1, answer: 1 }],
        };
        const timedRevisited: Attempt = {
            id: "r1",
            examId: "exam-r",
            examTitle: "재방문",
            studentName: "학생1",
            studentId: "s1",
            startedAt: "2026-06-14T10:00:00.000Z",
            finishedAt: "2026-06-14T10:05:00.000Z",
            score: 0,
            totalScore: 100,
            answers: { 1: 2 }, // wrong → graded
            status: "completed",
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 60, visitCount: 3, revisitCount: 2, answerChangeCount: 0 },
            ],
        };
        const base = buildQuestionResults(oneQuestionExam, timedRevisited).find(row => row.questionId === 1)!;
        timedRevisited.questionResults = [base];
        Object.assign(timedRevisited, buildCanonicalQuestionResultEvidence(timedRevisited, timedRevisited.questionResults));
        // Second respondent revisited the question but has no timing, so it is NOT timed.
        const untimedRevisited: Attempt = {
            ...timedRevisited,
            id: "r2",
            studentId: "s2",
            studentName: "학생2",
            questionTimings: [],
            questionResults: [{ ...base, attemptId: "r2", studentId: "s2", studentName: "학생2", timeSec: undefined, visitCount: 4, revisitCount: 3 }],
        };
        Object.assign(untimedRevisited, buildCanonicalQuestionResultEvidence(untimedRevisited, untimedRevisited.questionResults!));

        const stat = buildExamQuestionResultStats(oneQuestionExam, [timedRevisited, untimedRevisited]).find(s => s.questionId === 1)!;
        // 2 graded responses, both revisited, only 1 timed. Old code did 2/1 = 200%.
        expect(stat.totalCount).toBe(2);
        expect(stat.revisitRate).toBe(100);
        expect(stat.revisitRate).toBeLessThanOrEqual(100);
    });

    it("returns null point-biserial for small respondent pools and a perfect correlation for cleanly separated groups", () => {
        // Fewer than DISCRIMINATION_MIN_RESPONDENTS respondents → unreliable (B5 guard,
        // formerly enforced by the removed upper/lower-third index).
        const small = canonicalAttemptFor(exam, attempt);
        const smallQuestionTwo = buildExamQuestionResultStats(exam, [small]).find(stat => stat.questionId === 2)!;
        expect(buildExamQuestionPointBiserial(exam, [small]).get(smallQuestionTwo.cohortKey)).toBeNull();

        // The 2 respondents who answer q2 correctly (4) also ace every other question
        // (100%), and the 4 who miss q2 also miss everything else (0%) — a perfect
        // correctness/score split, so r_pb = 1.
        const many: Attempt[] = Array.from({ length: 6 }, (_, i) => canonicalAttemptFor(exam, {
            ...attempt,
            id: `pb-${i}`,
            studentId: `pb-s${i}`,
            answers: i < 2 ? { 1: 2, 2: 4, 3: 1, 4: 3 } : { 1: 3, 2: 1, 3: 2, 4: 2 },
            questionTimings: [],
            questionDrawings: [],
        }));
        const manyQuestionTwo = buildExamQuestionResultStats(exam, many).find(stat => stat.questionId === 2)!;
        expect(buildExamQuestionPointBiserial(exam, many).get(manyQuestionTwo.cohortKey)).toBe(1);
    });

    it("groups per-class score percentages the same way as buildClassExamWeaknessMatrix", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            // 2/4 correct → 50%.
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };
        const classBAttempt: Attempt = {
            ...attempt,
            id: "attempt-b",
            studentId: "student-b",
            studentName: "박학생",
            groupId: "class-b",
            groupName: "B반",
            // 4/4 correct → 100%.
            answers: { 1: 2, 2: 4, 3: 1, 4: 3 },
            questionTimings: [],
            questionDrawings: [],
        };

        // Base `attempt` answers { 1: 2, 2: 1, 4: 0 } → only Q1 correct → 25%.
        const groups = buildClassExamScoreGroups(exam, [attempt, secondAttempt, classBAttempt]);

        expect(groups).toHaveLength(2);
        const classA = groups.find(group => group.groupKey === "class-a");
        const classB = groups.find(group => group.groupKey === "class-b");
        expect(classA?.groupName).toBe("A반");
        expect([...(classA?.scores || [])].sort((a, b) => a - b)).toEqual([25, 50]);
        expect(classB?.groupName).toBe("B반");
        expect(classB?.scores).toEqual([100]);
    });

    it("excludes retakes from buildClassExamScoreGroups unless includeRetakes is set", () => {
        const retakeAttempt: Attempt = {
            ...attempt,
            id: "attempt-retake",
            studentId: "student-1",
            retake: { sourceAttemptId: "attempt-1", mode: "wrong", questionIds: [2], createdAt: "2026-06-14T10:10:00.000Z" },
            answers: { 1: 2, 2: 4, 3: 1, 4: 3 },
        };

        const withoutRetakes = buildClassExamScoreGroups(exam, [attempt, retakeAttempt]);
        expect(withoutRetakes.find(group => group.groupKey === "class-a")?.scores).toEqual([25]);

        const withRetakes = buildClassExamScoreGroups(exam, [attempt, retakeAttempt], { includeRetakes: true });
        expect(withRetakes.find(group => group.groupKey === "class-a")?.scores.sort((a, b) => a - b)).toEqual([25, 100]);
    });

    it("summarizes label/tag statistics with correct, missed, and timing counts", () => {
        const stats = buildQuestionResultTagStats(getAttemptQuestionResults(exam, canonicalAttemptFor(exam, attempt)), "label");

        expect(stats.find(stat => stat.title === "문학")).toMatchObject({
            kind: "label",
            basis: "같은 라벨",
            totalCount: 2,
            correctCount: 0,
            wrongCount: 2,
            unansweredCount: 1,
            correctRate: 0,
            wrongRate: 100,
            averageTimeSec: 132,
            questionNumbers: [2, 3],
            attemptCount: 1,
            studentCount: 1,
        });
        expect(stats.find(stat => stat.title === "문법")).toMatchObject({
            correctCount: 1,
            wrongCount: 0,
            correctRate: 100,
            averageTimeSec: 45,
        });
    });

    it("builds explainable learning recommendations for attempt, student, class, and exam scopes", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentId: "student-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            score: 50,
            questionTimings: [],
            questionDrawings: [],
        };
        const aggregateAttempts = [canonicalAttemptFor(exam, attempt), canonicalAttemptFor(exam, secondAttempt)];

        const canonicalAttempt = canonicalAttemptFor(exam, attempt);
        const attemptRecommendations = buildLearningRecommendations(exam, [canonicalAttempt], {
            scope: "attempt",
            attempt: canonicalAttempt,
            limit: 2,
        });

        expect(attemptRecommendations[0]).toMatchObject({
            scope: "attempt",
            title: "화자의 정서",
            basis: "같은 개념",
            severity: "urgent",
            sourceAttemptId: "attempt-1",
            retakeMode: "similar",
            retakeQuestionIds: [2, 3],
            retakeConcepts: ["화자의 정서"],
            recommendedAction: "같은 개념 2문항 재추천",
        });
        expect(attemptRecommendations[0].reason).toContain("이번 제출");
        expect(attemptRecommendations[0].priorityScore).toBeGreaterThan(0);
        expect(attemptRecommendations[1].kind).toBe("mistakeType");

        expect(buildLearningRecommendations(exam, aggregateAttempts, {
            scope: "student",
            studentKey: "student-1",
            kinds: ["concept"],
        })[0]).toMatchObject({
            sourceAttemptId: "student:student-1",
            title: "화자의 정서",
            studentCount: 1,
            attemptCount: 1,
        });

        expect(buildLearningRecommendations(exam, aggregateAttempts, {
            scope: "class",
            groupKey: "class-a",
            kinds: ["concept"],
        })[0]).toMatchObject({
            sourceAttemptId: "class:class-a",
            title: "화자의 정서",
            wrongCount: 3,
            totalCount: 4,
            studentCount: 2,
        });

        expect(buildLearningRecommendations(exam, aggregateAttempts, {
            scope: "exam",
            kinds: ["mistakeType"],
        })[0]).toMatchObject({
            sourceAttemptId: "exam:exam-1",
            title: "개념 혼동",
            retakeQuestionIds: [2, 3],
        });
    });

    it("summarizes time, revisit, and focus-loss signals for an attempt", () => {
        expect(summarizeAttemptBehavior(attempt)).toEqual({
            elapsedTimeSec: 300,
            totalTrackedTimeSec: 195,
            averageTimeSec: 65,
            slowQuestionNumbers: [2],
            rushedQuestionNumbers: [4],
            revisitedQuestionNumbers: [2],
            answerChangedQuestionNumbers: [1, 2],
            focusLossCount: 2,
            focusLossQuestionNumbers: [2, 4],
        });
    });

    it("preserves the larger cumulative focus-loss count after invalid events are removed", () => {
        expect(summarizeAttemptBehavior({
            ...attempt,
            tabFociLostCount: 3,
        }).focusLossCount).toBe(3);
    });
});

describe("slow-but-correct (불안정 개념) recommendation signal", () => {
    const slowExam: Exam = {
        id: "exam-slow",
        title: "수학 미적분",
        createdAt: "2026-06-20T10:00:00.000Z",
        questions: [
            { id: 1, number: 1, answer: 1, choices: 5, score: 10, tags: { concept: "접선의 기울기", expectedTimeSec: 60 } },
            { id: 2, number: 2, answer: 2, choices: 5, score: 10, tags: { concept: "접선의 기울기", expectedTimeSec: 60 } },
            { id: 3, number: 3, answer: 3, choices: 5, score: 10, tags: { concept: "적분 기초", expectedTimeSec: 60 } },
        ],
    };

    function slowAttempt(partial: Partial<Attempt>): Attempt {
        return {
            id: "slow-1",
            examId: "exam-slow",
            examTitle: "수학 미적분",
            studentName: "김학생",
            studentId: "s1",
            startedAt: "2026-06-20T10:00:00.000Z",
            finishedAt: "2026-06-20T10:40:00.000Z",
            score: 30,
            totalScore: 30,
            answers: { 1: 1, 2: 2, 3: 3 },
            status: "completed",
            ...partial,
        };
    }

    it("surfaces an all-correct concept when questions repeatedly blow the time budget", () => {
        const attemptAllCorrectButSlow = canonicalAttemptFor(slowExam, slowAttempt({
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 150, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 2, questionNumber: 2, totalTimeSec: 120, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 3, questionNumber: 3, totalTimeSec: 50, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        }));

        const recommendations = buildLearningRecommendations(slowExam, [attemptAllCorrectButSlow], {
            scope: "attempt",
            attempt: attemptAllCorrectButSlow,
            kinds: ["concept"],
            includeSlowCorrect: true,
        });

        // 접선의 기울기: 2 correct answers, both ≥ 1.5× expected → surfaces.
        const unstable = recommendations.find(item => item.title === "접선의 기울기");
        expect(unstable).toMatchObject({
            wrongCount: 0,
            slowCorrectCount: 2,
            slowCorrectQuestionNumbers: [1, 2],
            severity: "watch",
        });
        expect(unstable?.reason).toContain("불안정 개념");
        // 적분 기초: correct and within budget → stays silent.
        expect(recommendations.find(item => item.title === "적분 기초")).toBeUndefined();
    });

    it("keeps a single slow question silent (noise gate)", () => {
        const oneSlow = canonicalAttemptFor(slowExam, slowAttempt({
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 150, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        }));
        const recommendations = buildLearningRecommendations(slowExam, [oneSlow], {
            scope: "attempt",
            attempt: oneSlow,
            kinds: ["concept"],
            includeSlowCorrect: true,
        });
        expect(recommendations.find(item => item.title === "접선의 기울기")).toBeUndefined();
    });

    it("escalates severity when a miss combines with repeated slow-corrects", () => {
        const mixed = slowAttempt({
            answers: { 1: 1, 2: 2, 3: 5 }, // q3 wrong
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 150, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 2, questionNumber: 2, totalTimeSec: 120, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        });
        const mixedExam: Exam = {
            ...slowExam,
            questions: slowExam.questions.map(q => ({ ...q, tags: { ...q.tags, concept: "접선의 기울기" } })),
        };
        const canonicalMixed = canonicalAttemptFor(mixedExam, mixed);
        const recommendations = buildLearningRecommendations(mixedExam, [canonicalMixed], {
            scope: "attempt",
            attempt: canonicalMixed,
            kinds: ["concept"],
            includeSlowCorrect: true,
        });
        expect(recommendations[0]).toMatchObject({
            title: "접선의 기울기",
            wrongCount: 1,
            slowCorrectCount: 2,
            severity: "review",
        });
        expect(recommendations[0].reason).toContain("정답이지만 오래 걸린 문항 2건");
    });

    it("falls back to 2× the scope average when no expected time is tagged", () => {
        // Six questions, no expectedTimeSec tags. avg = (200+200+20·4)/6 = 80
        // → threshold 160 → only the two 200s qualify as slow-correct.
        const noExpectationExam: Exam = {
            id: "exam-noexp",
            title: "무태그 시험",
            createdAt: "2026-06-21T10:00:00.000Z",
            questions: [1, 2, 3, 4, 5, 6].map(n => ({
                id: n,
                number: n,
                answer: 1,
                choices: 5 as const,
                score: 5,
                tags: { concept: n <= 2 ? "접선의 기울기" : "적분 기초" },
            })),
        };
        const attemptNoExpectation = canonicalAttemptFor(noExpectationExam, slowAttempt({
            examId: "exam-noexp",
            answers: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
            questionTimings: [1, 2, 3, 4, 5, 6].map(n => ({
                questionId: n,
                questionNumber: n,
                totalTimeSec: n <= 2 ? 200 : 20,
                visitCount: 1,
                revisitCount: 0,
                answerChangeCount: 0,
            })),
        }));
        const recommendations = buildLearningRecommendations(noExpectationExam, [attemptNoExpectation], {
            scope: "attempt",
            attempt: attemptNoExpectation,
            kinds: ["concept"],
            includeSlowCorrect: true,
        });
        const unstable = recommendations.find(item => item.title === "접선의 기울기");
        expect(unstable?.slowCorrectCount).toBe(2);
        expect(recommendations.find(item => item.title === "적분 기초")).toBeUndefined();
    });
});
