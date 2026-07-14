import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import {
    buildClassTypeWeaknessGroups,
    buildClassExamScoreGroups,
    buildClassExamWeaknessMatrix,
    buildExamQuestionDiscriminations,
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

describe("premium analytics", () => {
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
        expect(buildRetakeQuestionIds(exam, attempt)).toEqual([2, 3, 4]);
    });

    it("backfills missing question result rows when stored analytics are partial", () => {
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

        const rows = getAttemptQuestionResults(exam, partialAttempt);

        expect(rows).toHaveLength(4);
        expect(rows.map(row => ({ questionId: row.questionId, status: row.status }))).toEqual([
            { questionId: 1, status: "correct" },
            { questionId: 2, status: "wrong" },
            { questionId: 3, status: "unanswered" },
            { questionId: 4, status: "unanswered" },
        ]);
        expect(rows.find(row => row.questionId === 2)).toMatchObject({
            handwritingStrokeCount: 8,
            timeSec: 140,
            studentId: "student-1",
            groupId: "class-a",
            regionId: "서울",
            regionName: "서울",
        });
        expect(buildRetakeQuestionIds(exam, partialAttempt)).toEqual([2, 3, 4]);
        expect(buildExamQuestionResultStats(exam, [partialAttempt]).find(stat => stat.questionId === 3)).toMatchObject({
            totalCount: 1,
            wrongCount: 1,
            unansweredCount: 1,
        });
    });

    it("keeps current exam answers and metadata authoritative over stale stored result rows", () => {
        const staleQuestionTwo = buildQuestionResults(exam, attempt).find(row => row.questionId === 2);
        const staleAttempt: Attempt = {
            ...attempt,
            questionResults: staleQuestionTwo
                ? [{
                    ...staleQuestionTwo,
                    selectedAnswer: 4,
                    status: "correct",
                    isCorrect: true,
                    isWrong: false,
                    earnedScore: staleQuestionTwo.score,
                    label: "이전 라벨",
                    concept: "이전 개념",
                }]
                : [],
        };

        const row = getAttemptQuestionResults(exam, staleAttempt).find(result => result.questionId === 2);

        expect(row).toMatchObject({
            selectedAnswer: 1,
            correctAnswer: 4,
            status: "wrong",
            isCorrect: false,
            isWrong: true,
            earnedScore: 0,
            label: "문학",
            concept: "화자의 정서",
        });
        expect(buildRetakeQuestionIds(exam, staleAttempt)).toEqual([2, 3, 4]);
        expect(buildExamQuestionResultStats(exam, [staleAttempt]).find(stat => stat.questionId === 2)).toMatchObject({
            wrongCount: 1,
            correctCount: 0,
            topWrongOption: { option: 1, count: 1, rate: 100 },
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

        const rows = getAttemptQuestionResults(exam, retakeAttempt);

        expect(rows.map(row => ({ questionId: row.questionId, status: row.status }))).toEqual([
            { questionId: 2, status: "correct" },
            { questionId: 4, status: "unanswered" },
        ]);
        expect(summarizeAttemptScore(exam, retakeAttempt)).toMatchObject({
            earnedScore: 50,
            totalScore: 100,
            scorePercent: 50,
            gradedQuestionCount: 2,
        });
        expect(buildRetakeQuestionIds(exam, retakeAttempt)).toEqual([4]);
    });

    it("groups a student's wrong questions by teacher labels and deep tags", () => {
        expect(buildStudentWeaknessGroups(exam, attempt)).toEqual([
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

        expect(buildSimilarQuestionGroups(exam, [attempt, secondAttempt]).slice(0, 2)).toMatchObject([
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

        expect(buildStudentTypeWeaknessGroups(exam, [attempt, secondAttempt], "student-1", "concept")[0]).toMatchObject({
            title: "화자의 정서",
            basis: "같은 개념",
            questionIds: [2, 3],
            wrongCount: 2,
            unansweredCount: 1,
            totalCount: 2,
            studentCount: 1,
            recommendedQuestionIds: [2, 3],
        });

        expect(buildClassTypeWeaknessGroups(exam, [attempt, secondAttempt], "class-a", "source")[0]).toMatchObject({
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

        const rows = buildClassExamWeaknessMatrix(exam, [attempt, secondAttempt, classBAttempt], {
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

        const rows = buildClassExamWeaknessMatrix(restrictedExam, [rosterMatchedAttempt], {
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
            { ...attempt, id: "seoul", studentId: "seoul-a::김학생", groupName: "A반", regionName: "서울", answers: { 1: 2, 2: 1, 3: 0, 4: 3 } },
            { ...attempt, id: "busan", studentId: "busan-a::김학생", groupName: "A반", regionName: "부산", answers: { 1: 2, 2: 4, 3: 1, 4: 3 } },
        ], {
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

        const classARows = collectQuestionResults(exam, [legacyClassA, legacyClassB], {
            studentKey: "class-a::김학생",
        });
        expect(Array.from(new Set(classARows.map(row => row.attemptId)))).toEqual(["legacy-a"]);
        expect(collectQuestionResults(exam, [legacyClassA, legacyClassB], {
            studentKey: "김학생",
        })).toHaveLength(0);

        expect(buildLearningRecommendations(exam, [legacyClassA, legacyClassB], {
            scope: "student",
            studentKey: "class-a::김학생",
            kinds: ["concept"],
        })[0]).toMatchObject({
            title: "화자의 정서",
            wrongCount: 2,
            studentCount: 1,
            attemptCount: 1,
        });
        expect(buildLearningRecommendations(exam, [legacyClassA, legacyClassB], {
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

        const seoulRows = collectQuestionResults(exam, [legacySeoul, legacyBusan], {
            studentKey: "서울::A반::김학생",
        });
        expect(Array.from(new Set(seoulRows.map(row => row.attemptId)))).toEqual(["legacy-seoul"]);

        expect(buildLearningRecommendations(exam, [legacySeoul, legacyBusan], {
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

    it("filters class analytics from merged question-result identity when attempt snapshot is incomplete", () => {
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
            studentId: undefined,
            groupId: undefined,
            groupName: undefined,
            questionResults: storedRows,
        };

        const rows = collectQuestionResults(exam, [storedIdentityAttempt], { groupKey: "class-a" });

        expect(rows).toHaveLength(4);
        expect(Array.from(new Set(rows.map(row => row.groupId)))).toEqual(["class-a"]);
        expect(buildLearningRecommendations(exam, [storedIdentityAttempt], {
            scope: "class",
            groupKey: "class-a",
            kinds: ["concept"],
        })[0]).toMatchObject({
            sourceAttemptId: "class:class-a",
            studentCount: 1,
            attemptCount: 1,
        });
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

        const stats = buildExamQuestionResultStats(exam, [attempt, secondAttempt]);

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
        expect(buildMostMissedQuestionStats(exam, [attempt, secondAttempt], 2).map(stat => stat.questionNumber)).toEqual([3, 2]);
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
            totalScore: 10,
            answers: { 1: 2 }, // wrong → graded
            status: "completed",
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 60, visitCount: 3, revisitCount: 2, answerChangeCount: 0 },
            ],
        };
        const base = buildQuestionResults(oneQuestionExam, timedRevisited).find(row => row.questionId === 1)!;
        // Second respondent revisited the question but has no timing, so it is NOT timed.
        const untimedRevisited: Attempt = {
            ...timedRevisited,
            id: "r2",
            studentId: "s2",
            studentName: "학생2",
            questionTimings: [],
            questionResults: [{ ...base, attemptId: "r2", studentId: "s2", timeSec: undefined, visitCount: 4, revisitCount: 3 }],
        };

        const stat = buildExamQuestionResultStats(oneQuestionExam, [timedRevisited, untimedRevisited]).find(s => s.questionId === 1)!;
        // 2 graded responses, both revisited, only 1 timed. Old code did 2/1 = 200%.
        expect(stat.totalCount).toBe(2);
        expect(stat.revisitRate).toBe(100);
        expect(stat.revisitRate).toBeLessThanOrEqual(100);
    });

    it("returns null discrimination for small respondent pools and a number otherwise (B5)", () => {
        // Fewer than 5 respondents → discrimination is unreliable.
        expect(buildExamQuestionDiscriminations(exam, [attempt]).get(2)).toBeNull();

        const many: Attempt[] = Array.from({ length: 6 }, (_, i) => ({
            ...attempt,
            id: `disc-${i}`,
            studentId: `disc-s${i}`,
            // Top 2 answer q2 correctly (4), bottom answers wrong.
            answers: i < 2 ? { 1: 2, 2: 4, 3: 1, 4: 3 } : { 1: 3, 2: 1, 3: 2, 4: 2 },
            questionTimings: [],
            questionDrawings: [],
        }));
        const discrimination = buildExamQuestionDiscriminations(exam, many).get(2);
        expect(typeof discrimination).toBe("number");
        expect(discrimination as number).toBeGreaterThan(0);
    });

    it("returns null point-biserial for small respondent pools and a perfect correlation for cleanly separated groups", () => {
        // Fewer than DISCRIMINATION_MIN_RESPONDENTS respondents → unreliable, matches the
        // upper/lower-third guard above.
        expect(buildExamQuestionPointBiserial(exam, [attempt]).get(2)).toBeNull();

        // Same fixture as the discrimination test: the 2 respondents who answer q2
        // correctly (4) also ace every other question (100%), and the 4 who miss q2 also
        // miss everything else (0%) — a perfect correctness/score split, so r_pb = 1.
        const many: Attempt[] = Array.from({ length: 6 }, (_, i) => ({
            ...attempt,
            id: `pb-${i}`,
            studentId: `pb-s${i}`,
            answers: i < 2 ? { 1: 2, 2: 4, 3: 1, 4: 3 } : { 1: 3, 2: 1, 3: 2, 4: 2 },
            questionTimings: [],
            questionDrawings: [],
        }));
        expect(buildExamQuestionPointBiserial(exam, many).get(2)).toBe(1);
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
        const stats = buildQuestionResultTagStats(getAttemptQuestionResults(exam, attempt), "label");

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

        const attemptRecommendations = buildLearningRecommendations(exam, [attempt], {
            scope: "attempt",
            attempt,
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

        expect(buildLearningRecommendations(exam, [attempt, secondAttempt], {
            scope: "student",
            studentKey: "student-1",
            kinds: ["concept"],
        })[0]).toMatchObject({
            sourceAttemptId: "student:student-1",
            title: "화자의 정서",
            studentCount: 1,
            attemptCount: 1,
        });

        expect(buildLearningRecommendations(exam, [attempt, secondAttempt], {
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

        expect(buildLearningRecommendations(exam, [attempt, secondAttempt], {
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
        const attemptAllCorrectButSlow = slowAttempt({
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 150, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 2, questionNumber: 2, totalTimeSec: 120, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
                { questionId: 3, questionNumber: 3, totalTimeSec: 50, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        });

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
        const oneSlow = slowAttempt({
            questionTimings: [
                { questionId: 1, questionNumber: 1, totalTimeSec: 150, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
            ],
        });
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
        const recommendations = buildLearningRecommendations(mixedExam, [mixed], {
            scope: "attempt",
            attempt: mixed,
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
        const attemptNoExpectation = slowAttempt({
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
        });
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
