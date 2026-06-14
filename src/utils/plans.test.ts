import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PLAN_CATALOG,
    canArchiveHandwriting,
    getPlanLabel,
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
    });

    it("increments AI answer-key recognition usage safely", () => {
        const localStorage = storage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);

        expect(readAiRecognitionUsage()).toBe(0);
        expect(incrementAiRecognitionUsage()).toBe(1);
        expect(incrementAiRecognitionUsage(4)).toBe(5);
        expect(localStorage.getItem("omr_ai_usage")).toBe("5");
    });
});
