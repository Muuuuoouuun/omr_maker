import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import {
    buildBillingPlanHealth,
    buildBillingUsageLimitViews,
    buildBillingUsageSummary,
    type BillingUsageSummary,
} from "./billingUsage";

const now = new Date("2026-06-15T12:00:00.000Z");

function exam(id: string, createdAt: string): Exam {
    return {
        id,
        title: id,
        createdAt,
        questions: [],
    };
}

function attempt(id: string, finishedAt: string, handwritingArchived = false): Attempt {
    return {
        id,
        examId: "exam",
        examTitle: "시험",
        studentName: "학생",
        startedAt: finishedAt,
        finishedAt,
        score: 0,
        totalScore: 100,
        answers: {},
        status: "completed",
        handwritingArchived,
        drawingStrokeCount: handwritingArchived ? 12 : 0,
        questionDrawings: handwritingArchived ? [
            { questionId: 1, questionNumber: 1, page: 1, strokeCount: 5 },
            { questionId: 2, questionNumber: 2, page: 1, strokeCount: 7 },
        ] : undefined,
    };
}

const students: RosterStudent[] = [
    {
        id: "s1",
        name: "학생",
        email: "s@example.com",
        group: "A반",
        avatar: "#000",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "기록 없음",
        trend: "flat",
        status: "active",
    },
];

describe("billing usage", () => {
    it("counts monthly exams, attempts, students, ai, and handwriting archive usage", () => {
        const usage = buildBillingUsageSummary({
            exams: [
                exam("current", "2026-06-01T00:00:00.000Z"),
                exam("old", "2026-05-15T00:00:00.000Z"),
            ],
            attempts: [
                attempt("a1", "2026-06-10T00:00:00.000Z", true),
                attempt("a2", "2026-06-11T00:00:00.000Z", false),
                attempt("a3", "2026-05-11T00:00:00.000Z", true),
            ],
            students,
            aiRecognition: 7.8,
            now,
        });

        expect(usage).toEqual({
            examsThisMonth: 1,
            students: 1,
            aiRecognition: 7,
            attemptsThisMonth: 2,
            handwritingArchivesThisMonth: 1,
            handwritingQuestionCount: 2,
            handwritingStrokeCount: 12,
        });
    });

    it("flags near-limit and blocked plan usage before paid workflows run", () => {
        const usage: BillingUsageSummary = {
            examsThisMonth: 5,
            students: 24,
            aiRecognition: 81,
            attemptsThisMonth: 0,
            handwritingArchivesThisMonth: 0,
            handwritingQuestionCount: 0,
            handwritingStrokeCount: 0,
        };

        expect(buildBillingUsageLimitViews("free", usage)).toEqual([
            expect.objectContaining({
                metric: "exams",
                status: "blocked",
                remaining: 0,
                upgradeTarget: "pro",
            }),
            expect.objectContaining({
                metric: "students",
                status: "near",
                percent: 80,
                upgradeTarget: "pro",
            }),
            expect.objectContaining({
                metric: "aiRecognition",
                status: "near",
                percent: 81,
                upgradeTarget: "pro",
            }),
        ]);
    });

    it("summarizes plan health from usage limits and locked premium features", () => {
        const lightUsage: BillingUsageSummary = {
            examsThisMonth: 1,
            students: 3,
            aiRecognition: 2,
            attemptsThisMonth: 4,
            handwritingArchivesThisMonth: 0,
            handwritingQuestionCount: 0,
            handwritingStrokeCount: 0,
        };

        const freeHealth = buildBillingPlanHealth({
            plan: "free",
            usage: lightUsage,
            entitlementKeys: ["handwritingArchive", "advancedAnalytics", "retakeAssignments"],
        });
        expect(freeHealth).toMatchObject({
            level: "watch",
            title: "프리미엄 기능 잠금",
            upgradeTarget: "pro",
            lockedEntitlementSummary: "필기 원본 보관, 고급 오답 분석, 재추천/재응시 링크",
        });
        expect(freeHealth.description).toContain("Pro에서 열립니다");
        expect(freeHealth.lockedEntitlements.map(entitlement => entitlement.key)).toEqual([
            "handwritingArchive",
            "advancedAnalytics",
            "retakeAssignments",
        ]);

        const proHealth = buildBillingPlanHealth({
            plan: "pro",
            usage: lightUsage,
            entitlementKeys: ["handwritingArchive", "multiTeacher", "organizationDashboard"],
        });
        expect(proHealth).toMatchObject({
            level: "watch",
            title: "Academy 기능 잠금",
            upgradeTarget: "academy",
            lockedEntitlementSummary: "다중 선생님, 조직 대시보드",
        });
        expect(proHealth.description).toContain("Academy에서 열립니다");
        expect(proHealth.description).not.toContain("고급 분석과 재추천");

        const academyHealth = buildBillingPlanHealth({
            plan: "academy",
            usage: lightUsage,
            entitlementKeys: ["handwritingArchive", "advancedAnalytics", "retakeAssignments"],
        });
        expect(academyHealth).toMatchObject({
            level: "ready",
            title: "운영 가능",
            lockedEntitlementSummary: "",
        });
        expect(academyHealth.lockedEntitlements).toEqual([]);
        expect(academyHealth.limitViews.every(view => view.status === "unlimited")).toBe(true);
    });
});
