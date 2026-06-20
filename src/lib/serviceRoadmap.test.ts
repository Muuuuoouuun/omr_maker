import { describe, expect, it } from "vitest";
import {
    ANALYTICS_SEGMENTATION_ROADMAP,
    PAYMENT_PROVIDER_ROADMAP,
    PRIMARY_NOTIFICATION_CHANNEL,
    PRODUCT_PRIORITY_ORDER,
    QUESTION_DB_ROADMAP,
    RECOMMENDATION_ROADMAP,
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
});
