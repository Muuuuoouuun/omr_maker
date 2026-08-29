import { describe, expect, it } from "vitest";
import {
    ANALYTICS_SEGMENTATION_ROADMAP,
    PAYMENT_PROVIDER_ROADMAP,
    PRIMARY_NOTIFICATION_CHANNEL,
    PRODUCT_PRIORITY_ORDER,
    QUESTION_DB_ROADMAP,
    RECOMMENDATION_ROADMAP,
    PREMIUM_LEARNING_LOOP,
    ANALYSIS_EVIDENCE_THRESHOLDS,
    DEFAULT_RECOVERY_POLICY,
    LOW_FRICTION_SERVICE_PRIORITIES,
    formatPaymentProviderRoadmap,
} from "./serviceRoadmap";

describe("service roadmap", () => {
    it("keeps question DB development metadata-first before cropped image assets", () => {
        expect(QUESTION_DB_ROADMAP.currentStage).toBe("pdf_region");
        expect(QUESTION_DB_ROADMAP.currentScope).toContain("유형 태그");
        expect(QUESTION_DB_ROADMAP.nextStage).toBe("image_asset");
    });

    it("keeps Kakao as the primary planned notification channel", () => {
        expect(PRIMARY_NOTIFICATION_CHANNEL.key).toBe("kakao");
        expect(PRIMARY_NOTIFICATION_CHANNEL.scope).toContain("초대");
    });

    it("keeps payment providers in the requested order", () => {
        expect(PAYMENT_PROVIDER_ROADMAP.map(provider => provider.key)).toEqual(["toss", "naver", "kakao"]);
        expect(formatPaymentProviderRoadmap()).toBe("토스페이먼츠 → 네이버페이 → 카카오페이");
    });

    it("keeps implementation priority focused on the product core first", () => {
        expect(PRODUCT_PRIORITY_ORDER.map(item => item.key)).toEqual([
            "exam_distribution",
            "student_solving",
            "teacher_analytics",
            "billing_auth",
        ]);
        expect(RECOMMENDATION_ROADMAP.map(item => item.stage)).toEqual([1, 2, 3]);
    });

    it("keeps analytics segmentation region-first while covering all requested axes", () => {
        expect(ANALYTICS_SEGMENTATION_ROADMAP.primaryAxis).toBe("region");
        expect(ANALYTICS_SEGMENTATION_ROADMAP.supervisorMode).toBe("results_only");
        expect(ANALYTICS_SEGMENTATION_ROADMAP.rolloutDepth).toBe("intermediate_first");
        expect(ANALYTICS_SEGMENTATION_ROADMAP.axes.map(axis => axis.key)).toEqual([
            "region",
            "student",
            "class",
            "exam",
            "question",
            "type",
        ]);
    });

    it("does not market same-exam retakes as newly sourced similar questions", () => {
        expect(PREMIUM_LEARNING_LOOP.find(item => item.key === "typed_retake")).toMatchObject({
            status: "available_if_data_ready",
            label: "유형별 오답 다시 풀기",
        });
        expect(PREMIUM_LEARNING_LOOP.find(item => item.key === "new_similar_questions")).toMatchObject({
            status: "planned",
            label: "새 유사문항 추천",
        });
    });

    it("defines conservative evidence thresholds for academy-facing analysis", () => {
        expect(ANALYSIS_EVIDENCE_THRESHOLDS).toEqual({
            minTaggedQuestionsPerType: 2,
            minOriginalAttemptsForTrend: 3,
            minResultsPerTypeForRepeatedWeakness: 6,
            minStudentsForClassPattern: 5,
            minAlternativeQuestionsForSimilarSet: 3,
        });
    });

    it("keeps the default recovery assignment short and teacher-approved", () => {
        expect(DEFAULT_RECOVERY_POLICY).toMatchObject({
            teacherApprovalRequired: true,
            maxQuestionsPerAssignment: 10,
            defaultDueInHours: 48,
            maxAttempts: 2,
            autoAssignSlowCorrect: false,
        });
    });

    it("prioritizes low-effort service moments that reuse delivered workflows", () => {
        const nextItems = LOW_FRICTION_SERVICE_PRIORITIES.filter(item => item.stage === "next");
        expect(nextItems.length).toBeGreaterThanOrEqual(4);
        expect(nextItems.every(item => item.effort === "low")).toBe(true);
        expect(LOW_FRICTION_SERVICE_PRIORITIES.find(item => item.key === "one_click_recovery")).toMatchObject({
            value: "very_high",
            userDecisionCount: 1,
        });
    });
});
