import { describe, expect, it, vi } from "vitest";
import { STUDENT_CODES_STORAGE_KEY } from "./studentCodes";
import {
    loadLocalStudentCodes,
    loadTeacherLocalStudentCodes,
} from "./studentCredentialLocalState";

function memoryStorage(initial: Record<string, string>) {
    const data = { ...initial };
    return {
        data,
        getItem: vi.fn((key: string) => data[key] ?? null),
        removeItem: vi.fn((key: string) => { delete data[key]; }),
    };
}

describe("teacher local student credential state", () => {
    it("scrubs production plaintext before any read and never returns the old code", () => {
        const storage = memoryStorage({
            [STUDENT_CODES_STORAGE_KEY]: JSON.stringify({ "student-1": "ABC234" }),
        });

        expect(loadTeacherLocalStudentCodes(storage, "production")).toEqual({});
        expect(storage.removeItem).toHaveBeenCalledWith(STUDENT_CODES_STORAGE_KEY);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.data[STUDENT_CODES_STORAGE_KEY]).toBeUndefined();
    });

    it("keeps the development fallback but removes malformed legacy payloads", () => {
        const valid = memoryStorage({
            [STUDENT_CODES_STORAGE_KEY]: JSON.stringify({ "student-1": "ABC234" }),
        });
        expect(loadTeacherLocalStudentCodes(valid, "development")).toEqual({ "student-1": "ABC234" });

        const malformed = memoryStorage({ [STUDENT_CODES_STORAGE_KEY]: "{broken" });
        expect(loadTeacherLocalStudentCodes(malformed, "development")).toEqual({});
        expect(malformed.removeItem).toHaveBeenCalledWith(STUDENT_CODES_STORAGE_KEY);
    });

    it("fails closed without touching the plaintext getter when production removal throws", () => {
        const getItem = vi.fn(() => {
            throw new Error("production credential material must never be read");
        });
        const removeItem = vi.fn(() => {
            throw new Error("storage is unavailable");
        });

        expect(loadLocalStudentCodes({ getItem, removeItem }, "production")).toEqual({});
        expect(removeItem).toHaveBeenCalledWith(STUDENT_CODES_STORAGE_KEY);
        expect(getItem).not.toHaveBeenCalled();
    });

    it("keeps the generic root-page loader development-only", () => {
        const storage = memoryStorage({
            [STUDENT_CODES_STORAGE_KEY]: JSON.stringify({ "student-root": "ROOT24" }),
        });

        expect(loadLocalStudentCodes(storage, "development")).toEqual({ "student-root": "ROOT24" });
        expect(storage.getItem).toHaveBeenCalledWith(STUDENT_CODES_STORAGE_KEY);
        expect(storage.removeItem).not.toHaveBeenCalled();
    });
});
