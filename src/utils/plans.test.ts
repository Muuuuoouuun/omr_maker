import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PLAN_CATALOG,
    canArchiveHandwriting,
    currentAiUsageMonth,
    evaluatePlanLimit,
    getPlanEntitlementViews,
    getPlanLabel,
    hasPlanEntitlement,
    incrementAiRecognitionUsage,
    normalizePlan,
    readAiRecognitionUsage,
} from "./plans";

function storage(): Storage {
    const data = new Map<string, string>();

    return {
        get length() {
            return data.size;
        },
        clear() {
            data.clear();
        },
        getItem(key: string) {
            return data.get(key) ?? null;
        },
        key(index: number) {
            return [...data.keys()][index] ?? null;
        },
        removeItem(key: string) {
            data.delete(key);
        },
        setItem(key: string, value: string) {
            data.set(key, value);
        },
    } as Storage;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("plan catalog", () => {
    it("uses Free, Pro, Academy as canonical public plans", () => {
        expect(PLAN_CATALOG.map(plan => plan.key)).toEqual(["free", "pro", "academy"]);
        expect(getPlanLabel("academy")).toBe("Academy");
        expect(normalizePlan("school")).toBe("academy");
    });

    it("archives handwriting for paid plans", () => {
        expect(canArchiveHandwriting("free")).toBe(false);
        expect(canArchiveHandwriting("pro")).toBe(true);
        expect(canArchiveHandwriting("academy")).toBe(true);
        expect(hasPlanEntitlement("free", "feedbackMarkup")).toBe(false);
        expect(hasPlanEntitlement("pro", "feedbackMarkup")).toBe(true);
        expect(hasPlanEntitlement("academy", "returnedFeedback")).toBe(true);
        expect(hasPlanEntitlement("free", "retakeAssignments")).toBe(false);
        expect(hasPlanEntitlement("pro", "retakeAssignments")).toBe(true);
        expect(hasPlanEntitlement("academy", "organizationDashboard")).toBe(true);
    });

    it("summarizes plan entitlements with the first upgrade plan that unlocks them", () => {
        const freeViews = getPlanEntitlementViews("free", [
            "csvExport",
            "handwritingArchive",
            "feedbackMarkup",
            "advancedAnalytics",
            "multiTeacher",
        ]);

        expect(freeViews).toEqual([
            expect.objectContaining({ key: "csvExport", enabled: true, unlockPlan: undefined }),
            expect.objectContaining({ key: "handwritingArchive", enabled: false, unlockPlan: "pro" }),
            expect.objectContaining({ key: "feedbackMarkup", enabled: false, unlockPlan: "pro" }),
            expect.objectContaining({ key: "advancedAnalytics", enabled: false, unlockPlan: "pro" }),
            expect.objectContaining({ key: "multiTeacher", enabled: false, unlockPlan: "academy" }),
        ]);

        const proViews = getPlanEntitlementViews("pro", ["handwritingArchive", "advancedAnalytics", "multiTeacher"]);
        expect(proViews).toEqual([
            expect.objectContaining({ key: "handwritingArchive", enabled: true, unlockPlan: undefined }),
            expect.objectContaining({ key: "advancedAnalytics", enabled: true, unlockPlan: undefined }),
            expect.objectContaining({ key: "multiTeacher", enabled: false, unlockPlan: "academy" }),
        ]);

        expect(getPlanEntitlementViews("academy", ["multiTeacher"])).toEqual([
            expect.objectContaining({ key: "multiTeacher", enabled: true, unlockPlan: undefined }),
        ]);
    });

    it("increments AI answer-key recognition usage safely", () => {
        const localStorage = storage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        expect(readAiRecognitionUsage()).toBe(0);
        expect(incrementAiRecognitionUsage()).toBe(1);
        expect(incrementAiRecognitionUsage(4)).toBe(5);
        expect(localStorage.getItem("omr_ai_usage")).toBe(
            JSON.stringify({ month: currentAiUsageMonth(), count: 5 }),
        );
    });

    it("resets the monthly AI recognition quota when the month changes", () => {
        const localStorage = storage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        // A record from a previous month must not count toward this month.
        localStorage.setItem("omr_ai_usage", JSON.stringify({ month: "2020-01", count: 99 }));
        expect(readAiRecognitionUsage()).toBe(0);
        expect(localStorage.getItem("omr_ai_usage")).toBe(
            JSON.stringify({ month: currentAiUsageMonth(), count: 0 }),
        );

        // Same-month records are preserved.
        localStorage.setItem("omr_ai_usage", JSON.stringify({ month: currentAiUsageMonth(), count: 7 }));
        expect(readAiRecognitionUsage()).toBe(7);
    });

    it("migrates a legacy bare-number counter into the current month once", () => {
        const localStorage = storage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        localStorage.setItem("omr_ai_usage", "12");
        expect(readAiRecognitionUsage()).toBe(12);
        expect(localStorage.getItem("omr_ai_usage")).toBe(
            JSON.stringify({ month: currentAiUsageMonth(), count: 12 }),
        );
    });

    it("evaluates plan limits before paid workflows run", () => {
        expect(evaluatePlanLimit("free", "exams", 4, 1)).toMatchObject({
            allowed: true,
            remaining: 1,
            upgradeTarget: "pro",
        });
        expect(evaluatePlanLimit("free", "exams", 5, 1)).toMatchObject({
            allowed: false,
            remaining: 0,
            upgradeTarget: "pro",
        });
        expect(evaluatePlanLimit("pro", "students", 300, 1)).toMatchObject({
            allowed: false,
            upgradeTarget: "academy",
        });
        expect(evaluatePlanLimit("academy", "aiRecognition", 999999, 1)).toMatchObject({
            allowed: true,
            limit: Infinity,
            remaining: Infinity,
        });
    });
});
