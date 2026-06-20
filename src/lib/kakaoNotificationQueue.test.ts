import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildKakaoNotificationCandidates } from "./kakaoNotificationQueue";

const baseStudent = {
    email: "",
    avatar: "#4f46e5",
    avgScore: 0,
    examsTaken: 0,
    lastActive: "기록 없음",
    trend: "flat" as const,
    status: "active" as const,
};

const groups: RosterGroup[] = [
    { id: "class-a", name: "A반", region: "서울", count: 2, avgScore: 0, color: "#4f46e5" },
];

const students: RosterStudent[] = [
    { ...baseStudent, id: "class-a::김학생", name: "김학생", group: "A반", region: "서울" },
    { ...baseStudent, id: "class-a::이학생", name: "이학생", group: "A반", region: "서울" },
];

const exam: Exam = {
    id: "exam-1",
    title: "6월 중간",
    createdAt: "2026-06-15T08:00:00.000Z",
    startAt: "2026-06-15T09:00:00.000Z",
    endAt: "2026-06-15T10:00:00.000Z",
    accessConfig: { type: "group", groupIds: ["class-a"] },
    questions: [
        {
            id: 1,
            number: 1,
            answer: 1,
            label: "문법",
            tags: { concept: "높임 표현", mistakeTypes: ["개념 혼동"] },
        },
        {
            id: 2,
            number: 2,
            answer: 2,
            label: "문법",
            tags: { concept: "높임 표현", mistakeTypes: ["계산 실수"] },
        },
    ],
};

function attempt(overrides: Partial<Attempt>): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "6월 중간",
        studentName: "김학생",
        studentId: "class-a::김학생",
        groupId: "class-a",
        groupName: "A반",
        regionName: "서울",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 0,
        totalScore: 100,
        answers: { 1: 2, 2: 3 },
        status: "completed",
        ...overrides,
    };
}

describe("kakao notification queue", () => {
    it("builds pending missing-exam and retake candidates without implying live sending", () => {
        const summary = buildKakaoNotificationCandidates({
            exams: [exam],
            attempts: [attempt({})],
            students,
            groups,
            now: new Date("2026-06-15T10:30:00.000Z"),
        });

        expect(summary).toMatchObject({
            totalCount: 3,
            missingExamCount: 1,
            retakeRecommendationCount: 1,
            classRetakeRecommendationCount: 1,
            targetStudentCount: 2,
        });
        expect(summary.candidates.map(candidate => candidate.status)).toEqual(["candidate", "candidate", "candidate"]);
        expect(summary.candidates.find(candidate => candidate.kind === "missing_exam")).toMatchObject({
            title: "카카오 미응시 결과 확인 후보",
            targetCount: 1,
            studentIds: ["class-a::이학생"],
            studentNames: ["이학생"],
            groupNames: ["A반"],
            regionNames: ["서울"],
        });
        expect(summary.candidates.find(candidate => candidate.kind === "class_retake_recommendation")).toMatchObject({
            title: "카카오 반별 재시험 안내 후보",
            message: expect.stringContaining("A반 · 서울"),
            targetCount: 1,
            studentIds: ["class-a::김학생"],
            studentNames: ["김학생"],
            groupNames: ["A반"],
            regionNames: ["서울"],
            reason: expect.stringContaining("A반 · 서울"),
        });
        expect(summary.candidates.find(candidate => candidate.kind === "retake_recommendation")).toMatchObject({
            title: "카카오 재시험 안내 후보",
            targetCount: 1,
            studentNames: ["김학생"],
            groupNames: ["A반"],
            regionNames: ["서울"],
        });
        expect(summary.candidates.map(candidate => candidate.title).join(" ")).not.toContain("발송 완료");
    });

    it("uses roster matching so legacy attempts without studentId do not become false missing candidates", () => {
        const summary = buildKakaoNotificationCandidates({
            exams: [exam],
            attempts: [attempt({ studentId: undefined })],
            students,
            groups,
            now: new Date("2026-06-15T10:30:00.000Z"),
        });

        expect(summary.candidates.find(candidate => candidate.kind === "missing_exam")).toMatchObject({
            studentIds: ["class-a::이학생"],
            targetCount: 1,
        });
        expect(summary.candidates.find(candidate => candidate.kind === "class_retake_recommendation")).toMatchObject({
            studentIds: ["class-a::김학생"],
            targetCount: 1,
        });
    });

    it("does not create missing-exam candidates before an exam starts", () => {
        const summary = buildKakaoNotificationCandidates({
            exams: [exam],
            attempts: [],
            students,
            groups,
            now: new Date("2026-06-15T08:30:00.000Z"),
        });

        expect(summary.candidates).toEqual([]);
    });

    it("keeps missing-exam Kakao candidates scoped to the selected region group", () => {
        const summary = buildKakaoNotificationCandidates({
            exams: [{
                ...exam,
                accessConfig: { type: "group", groupIds: ["seoul-a"] },
            }],
            attempts: [],
            groups: [
                { id: "seoul-a", name: "A반", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" },
                { id: "busan-a", name: "A반", region: "부산", count: 1, avgScore: 0, color: "#10b981" },
            ],
            students: [
                { ...baseStudent, id: "seoul-a::김학생", name: "김학생", group: "A반", region: "서울" },
                { ...baseStudent, id: "busan-a::김학생", name: "김학생", group: "A반", region: "부산" },
            ],
            now: new Date("2026-06-15T10:30:00.000Z"),
        });

        expect(summary.candidates).toHaveLength(1);
        expect(summary.candidates[0]).toMatchObject({
            kind: "missing_exam",
            message: expect.stringContaining("A반 · 서울"),
            targetCount: 1,
            studentIds: ["seoul-a::김학생"],
            regionNames: ["서울"],
        });
    });

    it("uses region-scoped class labels for same-name class retake candidates", () => {
        const regionalGroups: RosterGroup[] = [
            { id: "seoul-a", name: "A반", region: "서울", count: 1, avgScore: 0, color: "#4f46e5" },
            { id: "busan-a", name: "A반", region: "부산", count: 1, avgScore: 0, color: "#10b981" },
        ];
        const regionalStudents: RosterStudent[] = [
            { ...baseStudent, id: "seoul-a::김학생", name: "김학생", group: "A반", region: "서울" },
            { ...baseStudent, id: "busan-a::김학생", name: "김학생", group: "A반", region: "부산" },
        ];
        const summary = buildKakaoNotificationCandidates({
            exams: [{
                ...exam,
                accessConfig: { type: "group", groupIds: ["seoul-a", "busan-a"] },
            }],
            attempts: [
                attempt({
                    id: "seoul-attempt",
                    studentId: "seoul-a::김학생",
                    groupId: "seoul-a",
                    regionName: "서울",
                }),
                attempt({
                    id: "busan-attempt",
                    studentId: "busan-a::김학생",
                    groupId: "busan-a",
                    regionName: "부산",
                    score: 100,
                    answers: { 1: 1, 2: 2 },
                }),
            ],
            students: regionalStudents,
            groups: regionalGroups,
            now: new Date("2026-06-15T10:30:00.000Z"),
        });

        const retakeCandidates = summary.candidates.filter(candidate => candidate.kind === "class_retake_recommendation");
        expect(retakeCandidates).toHaveLength(1);
        expect(retakeCandidates[0]).toMatchObject({
            message: expect.stringContaining("A반 · 서울"),
            reason: expect.stringContaining("A반 · 서울"),
            studentIds: ["seoul-a::김학생"],
            groupNames: ["A반"],
            regionNames: ["서울"],
        });
    });

    it("does not create retake candidates for archived exams", () => {
        const summary = buildKakaoNotificationCandidates({
            exams: [{ ...exam, archived: true }],
            attempts: [attempt({})],
            students,
            groups,
            now: new Date("2026-06-15T10:30:00.000Z"),
        });

        expect(summary.candidates).toEqual([]);
    });
});
