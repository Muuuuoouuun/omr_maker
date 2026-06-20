import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import {
    DEFAULT_REGION_NAME,
    buildRegionalActionPlans,
    buildRegionalLearningScopes,
    filterAttemptsByRegion,
    regionKeyFor,
    regionNameForAttempt,
} from "./regionalAnalytics";

const baseStudent = {
    email: "",
    avatar: "#4f46e5",
    avgScore: 0,
    examsTaken: 0,
    lastActive: "기록 없음",
    trend: "flat" as const,
    status: "active" as const,
};

const students: RosterStudent[] = [
    { ...baseStudent, id: "seoul-a::김학생", name: "김학생", group: "A반", region: "서울" },
    { ...baseStudent, id: "busan-b::김학생", name: "김학생", group: "B반", region: "부산" },
];

const groups: RosterGroup[] = [
    { id: "seoul-a", name: "A반", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" },
    { id: "busan-b", name: "B반", region: "부산", count: 1, avgScore: 0, color: "#10b981" },
];

const algebraExam: Exam = {
    id: "exam-1",
    title: "중간고사",
    createdAt: "2026-06-15T08:00:00.000Z",
    questions: [
        {
            id: 1,
            number: 1,
            answer: 1,
            label: "수학",
            tags: { unit: "방정식", concept: "비례식", mistakeTypes: ["계산 실수"] },
        },
        {
            id: 2,
            number: 2,
            answer: 2,
            label: "수학",
            tags: { unit: "방정식", concept: "비례식", mistakeTypes: ["개념 혼동"] },
        },
    ],
};

function attempt(overrides: Partial<Attempt>): Attempt {
    return {
        id: "attempt",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 80,
        totalScore: 100,
        answers: {},
        status: "completed",
        ...overrides,
    };
}

describe("regional analytics", () => {
    it("keeps same-name students separated by region and class scope", () => {
        const scopes = buildRegionalLearningScopes({
            students,
            groups,
            attempts: [
                attempt({ id: "seoul", studentId: "seoul-a::김학생", groupId: "seoul-a", groupName: "A반", score: 80 }),
                attempt({ id: "busan", studentId: "busan-b::김학생", groupId: "busan-b", groupName: "B반", score: 50 }),
                attempt({ id: "daegu", studentName: "이학생", groupName: "오프라인반", regionName: "대구", score: 90 }),
            ],
            exams: [],
        });

        const byRegion = new Map(scopes.map(scope => [scope.regionName, scope]));
        expect(byRegion.get("서울")).toMatchObject({
            studentCount: 1,
            groupCount: 1,
            attemptCount: 1,
            examCount: 1,
            averageScore: 80,
            groupNames: ["A반"],
        });
        expect(byRegion.get("부산")).toMatchObject({
            studentCount: 1,
            groupCount: 1,
            attemptCount: 1,
            averageScore: 50,
            groupNames: ["B반"],
        });
        expect(byRegion.get("대구")).toMatchObject({
            studentCount: 1,
            groupCount: 1,
            attemptCount: 1,
            averageScore: 90,
            groupNames: ["오프라인반"],
        });
    });

    it("falls back to an unclassified region without losing attempts", () => {
        const scopes = buildRegionalLearningScopes({
            students: [],
            groups: [],
            attempts: [attempt({ id: "legacy", studentName: "무소속", groupName: "미분류" })],
            exams: [],
        });

        expect(scopes).toEqual([
            expect.objectContaining({
                regionKey: regionKeyFor(DEFAULT_REGION_NAME),
                regionName: DEFAULT_REGION_NAME,
                studentCount: 1,
                groupCount: 1,
                attemptCount: 1,
            }),
        ]);
    });

    it("resolves and filters attempt regions from roster or submission snapshots", () => {
        const attempts = [
            attempt({ id: "roster-region", studentId: "seoul-a::김학생", groupId: "seoul-a", groupName: "A반" }),
            attempt({ id: "snapshot-region", studentName: "최학생", regionName: "대전", groupName: "특강반" }),
            attempt({ id: "fallback", studentName: "무소속" }),
        ];

        expect(regionNameForAttempt(attempts[0], students, groups)).toBe("서울");
        expect(regionNameForAttempt(attempts[1], students, groups)).toBe("대전");
        expect(regionNameForAttempt(attempts[2], students, groups)).toBe(DEFAULT_REGION_NAME);
        expect(filterAttemptsByRegion(attempts, regionKeyFor("서울"), students, groups).map(item => item.id)).toEqual(["roster-region"]);
        expect(filterAttemptsByRegion(attempts, regionKeyFor("대전"), students, groups).map(item => item.id)).toEqual(["snapshot-region"]);
    });

    it("builds regional action plans from wrong-question patterns and risk students", () => {
        const plans = buildRegionalActionPlans({
            students,
            groups,
            exams: [algebraExam],
            options: { weaknessKinds: ["concept"] },
            attempts: [
                attempt({
                    id: "seoul-1",
                    studentId: "seoul-a::김학생",
                    groupId: "seoul-a",
                    groupName: "A반",
                    regionName: "서울",
                    score: 40,
                    answers: { 1: 2, 2: 3 },
                    finishedAt: "2026-06-15T09:30:00.000Z",
                }),
                attempt({
                    id: "seoul-2",
                    studentId: "seoul-a::이학생",
                    studentName: "이학생",
                    groupId: "seoul-a",
                    groupName: "A반",
                    regionName: "서울",
                    score: 55,
                    answers: { 1: 2, 2: 2 },
                    finishedAt: "2026-06-15T09:40:00.000Z",
                }),
                attempt({
                    id: "busan-1",
                    studentId: "busan-b::김학생",
                    groupId: "busan-b",
                    groupName: "B반",
                    regionName: "부산",
                    score: 100,
                    answers: { 1: 1, 2: 2 },
                    finishedAt: "2026-06-15T09:45:00.000Z",
                }),
            ],
        });

        expect(plans.map(plan => plan.regionName)).toEqual(["서울", "부산"]);
        expect(plans[0]).toMatchObject({
            regionName: "서울",
            activeStudentCount: 2,
            wrongQuestionCount: 3,
            unansweredQuestionCount: 0,
            severity: "urgent",
        });
        expect(plans[0].recommendations[0]).toMatchObject({
            title: "비례식",
            wrongCount: 3,
            wrongRate: 75,
            retakeQuestionIds: [1, 2],
        });
        expect(plans[0].recommendedAction).toContain('서울 같은 개념 "비례식" 2문항 재추천');
        expect(plans[0].studentsNeedingAttention.map(student => student.name)).toEqual(["김학생", "이학생"]);
        expect(plans[1]).toMatchObject({
            regionName: "부산",
            wrongQuestionCount: 0,
            severity: "watch",
            recommendedAction: "부산 추가 조치 없음",
        });
    });

    it("keeps retakes out of regional averages and action plans by default", () => {
        const original = attempt({
            id: "seoul-original",
            studentId: "seoul-a::김학생",
            groupId: "seoul-a",
            groupName: "A반",
            regionName: "서울",
            score: 40,
            totalScore: 100,
            answers: { 1: 2, 2: 2 },
        });
        const retake = attempt({
            id: "seoul-retake",
            studentId: "seoul-a::김학생",
            groupId: "seoul-a",
            groupName: "A반",
            regionName: "서울",
            score: 100,
            totalScore: 100,
            answers: { 1: 2, 2: 1 },
            retake: {
                sourceAttemptId: "seoul-original",
                questionIds: [1, 2],
                mode: "wrong",
                createdAt: "2026-06-15T10:00:00.000Z",
            },
        });

        const scopes = buildRegionalLearningScopes({
            students,
            groups,
            attempts: [original, retake],
            exams: [],
        });
        const seoulScope = scopes.find(scope => scope.regionName === "서울");

        expect(seoulScope).toMatchObject({
            attemptCount: 1,
            retakeAttemptCount: 1,
            averageScore: 40,
        });

        const scopesWithRetakes = buildRegionalLearningScopes({
            students,
            groups,
            attempts: [original, retake],
            exams: [],
            options: { includeRetakes: true },
        });

        expect(scopesWithRetakes.find(scope => scope.regionName === "서울")).toMatchObject({
            attemptCount: 2,
            retakeAttemptCount: 1,
            averageScore: 70,
        });

        const defaultPlan = buildRegionalActionPlans({
            students,
            groups,
            exams: [algebraExam],
            attempts: [original, retake],
            options: { regionLimit: 1, weaknessKinds: ["concept"] },
        })[0];
        const withRetakePlan = buildRegionalActionPlans({
            students,
            groups,
            exams: [algebraExam],
            attempts: [original, retake],
            options: { includeRetakes: true, regionLimit: 1, weaknessKinds: ["concept"] },
        })[0];

        expect(defaultPlan).toMatchObject({
            regionName: "서울",
            attemptCount: 1,
            wrongQuestionCount: 1,
        });
        expect(withRetakePlan).toMatchObject({
            regionName: "서울",
            attemptCount: 2,
            wrongQuestionCount: 3,
        });
    });
});
